import { execFileSync, spawn } from "child_process";
import { readFile, stat } from "fs/promises";
import { homedir, platform } from "os";
import { join } from "path";
import { BaseProvider } from "@/providers/base.js";
import { StandardUsageResult, ProviderName, ClaudeRawResponse, UsageSummary } from "@/types.js";
import { buildSummary } from "@/utils.js";

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
  };
}

interface ClaudeApiResponse {
  five_hour?: {
    utilization: number;
    resets_at: string;
  } | null;
  seven_day?: {
    utilization: number;
    resets_at: string;
  } | null;
  seven_day_sonnet?: {
    utilization: number;
    resets_at: string;
  } | null;
}

export class ClaudeProvider extends BaseProvider {
  readonly name = ProviderName.Claude;
  private credentialsPath: string;
  private useKeychain: boolean;
  private lastFetch: number = 0;
  private cache: StandardUsageResult | null = null;
  private credCache: { token: string | null; mtime?: number; timestamp?: number } | null = null;
  private readonly CACHE_TTL_MS = 60000;
  private readonly KEYCHAIN_CACHE_TTL_MS = 10000;
  private readonly MAX_RETRIES = 4;
  private readonly BASE_BACKOFF_MS = 1000;
  private readonly MAX_BACKOFF_MS = 30000;
  private readonly MAX_CONSECUTIVE_429 = 4;
  private readonly CIRCUIT_COOLDOWN_MS = 60000;
  private consecutive429Count = 0;
  private cooldownUntil = 0;
  private invalidTokens = new Set<string>();

  constructor(options?: { credentialsPath?: string; useKeychain?: boolean }) {
    super();
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    this.credentialsPath = options?.credentialsPath || join(configDir, ".credentials.json");
    this.useKeychain = options?.useKeychain ?? true;
  }

  async fetchUsage(): Promise<StandardUsageResult> {
    const now = Date.now();
    if (this.cooldownUntil > now) {
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: 429, message: "Rate Limit" },
      };
    }

    if (this.cache && (now - this.lastFetch) < this.CACHE_TTL_MS) {
      return this.cache;
    }

    const token = await this.getCredentials();
    if (!token) {
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: "AUTH", message: "Auth Required" },
      };
    }

    try {
      const response = await this.fetchWithRetry(token);
      if (!response) {
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: { code: "CONN", message: "Conn Error" },
        };
      }

      if (response.status === 401) {
        this.invalidTokens.add(token);
        this.credCache = null;
        const refreshed = await this.refreshTokenViaCLI();
        if (refreshed) {
          return await this.fetchUsageInternal();
        }
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: { code: 401, message: "Unauthorized" },
        };
      }

      if (response.status === 429) {
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: { code: 429, message: "Rate Limit" },
        };
      }

      if (!response.ok) {
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: { code: response.status, message: `Error ${response.status}` },
        };
      }

      const data = (await response.json()) as ClaudeApiResponse;
      const usage = this.mapResponseToResult(data);
      this.cache = usage;
      this.lastFetch = now;
      this.consecutive429Count = 0;
      this.cooldownUntil = 0;
      return usage;
    } catch {
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: "API", message: "API Error" },
      };
    }
  }

  private async fetchUsageInternal(): Promise<StandardUsageResult> {
    const token = await this.getCredentials();
    if (!token) {
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: "AUTH", message: "Auth Required" },
      };
    }

    try {
      const response = await this.fetchWithRetry(token);
      if (!response) {
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: { code: "CONN", message: "Conn Error" },
        };
      }

      if (response.status === 401) {
        this.invalidTokens.add(token);
        this.credCache = null;
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: { code: 401, message: "Unauthorized" },
        };
      }

      if (response.status === 429) {
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: { code: 429, message: "Rate Limit" },
        };
      }

      if (!response.ok) {
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: { code: response.status, message: `Error ${response.status}` },
        };
      }

      const data = (await response.json()) as ClaudeApiResponse;
      const usage = this.mapResponseToResult(data);
      this.cache = usage;
      this.lastFetch = Date.now();
      this.consecutive429Count = 0;
      this.cooldownUntil = 0;
      return usage;
    } catch {
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: "API", message: "API Error" },
      };
    }
  }

  private mapResponseToResult(data: ClaudeApiResponse): StandardUsageResult {
    const fiveHourUsage = data.five_hour?.utilization ?? null;
    const sevenDayUsage = data.seven_day?.utilization ?? null;
    let overallUsagePercent = null;
    if (fiveHourUsage !== null && sevenDayUsage !== null) {
      overallUsagePercent = Math.max(fiveHourUsage, sevenDayUsage);
    } else if (fiveHourUsage !== null) {
      overallUsagePercent = fiveHourUsage;
    } else if (sevenDayUsage !== null) {
      overallUsagePercent = sevenDayUsage;
    }

    const fiveHourReset = data.five_hour?.resets_at ?? null;
    const sevenDayReset = data.seven_day?.resets_at ?? null;
    let overallResetTime = fiveHourReset || sevenDayReset || null;
    if (fiveHourUsage !== null && sevenDayUsage !== null) {
      overallResetTime = fiveHourUsage >= sevenDayUsage ? fiveHourReset : sevenDayReset;
    }

    const perModel: Record<string, any> = {};
    if (data.five_hour) {
      perModel["5h_quota"] = {
        usagePercent: data.five_hour.utilization,
        resetTime: data.five_hour.resets_at,
        displayName: "5-Hour Quota",
      };
    }
    if (data.seven_day) {
      perModel["7d_quota"] = {
        usagePercent: data.seven_day.utilization,
        resetTime: data.seven_day.resets_at,
        displayName: "7-Day Quota",
      };
    }
    if (data.seven_day_sonnet) {
      perModel["7d_sonnet_quota"] = {
        usagePercent: data.seven_day_sonnet.utilization,
        resetTime: data.seven_day_sonnet.resets_at,
        displayName: "7-Day Sonnet Quota",
      };
    }

    return {
      provider: this.name,
      overallUsagePercent,
      overallResetTime,
      perModel,
    };
  }

  async fetchRawUsage(): Promise<ClaudeRawResponse> {
    const token = await this.getCredentials();
    if (!token) {
      throw new Error("Authentication credentials missing");
    }
    const response = await this.fetchUsageEndpoint(token);
    if (!response || !response.ok) {
      throw new Error(`Anthropic API returned status ${response?.status || "unknown"}`);
    }
    return (await response.json()) as ClaudeRawResponse;
  }

  async fetchSummary(): Promise<UsageSummary> {
    const usage = await this.fetchUsage();
    return buildSummary(usage);
  }

  private async getCredentials(): Promise<string | null> {
    try {
      let token: string | null = null;
      if (platform() === "darwin" && this.useKeychain) {
        token = await this.getCredentialsFromKeychain();
        if (token && this.invalidTokens.has(token)) {
          token = await this.getCredentialsFromFile();
        }
      } else {
        token = await this.getCredentialsFromFile();
      }

      if (token && this.invalidTokens.has(token)) {
        return null;
      }
      return token;
    } catch {
      return null;
    }
  }

  private async getCredentialsFromKeychain(): Promise<string | null> {
    if (this.credCache?.timestamp && Date.now() - this.credCache.timestamp < this.KEYCHAIN_CACHE_TTL_MS) {
      if (this.credCache.token && !this.invalidTokens.has(this.credCache.token)) {
        return this.credCache.token;
      }
    }

    try {
      const result = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();

      const creds: ClaudeCredentials = JSON.parse(result);
      const token = creds?.claudeAiOauth?.accessToken ?? null;
      this.credCache = { token, timestamp: Date.now() };
      return token;
    } catch {
      return await this.getCredentialsFromFile();
    }
  }

  private async getCredentialsFromFile(): Promise<string | null> {
    try {
      const fileStat = await stat(this.credentialsPath);
      const mtime = fileStat.mtimeMs;

      if (this.credCache?.mtime === mtime) {
        if (this.credCache.token && !this.invalidTokens.has(this.credCache.token)) {
          return this.credCache.token;
        }
      }

      const content = await readFile(this.credentialsPath, "utf-8");
      const creds: ClaudeCredentials = JSON.parse(content);
      const token = creds?.claudeAiOauth?.accessToken ?? null;
      this.credCache = { token, mtime };
      return token;
    } catch {
      return null;
    }
  }

  private async fetchWithRetry(token: string): Promise<Response | null> {
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      const response = await this.fetchUsageEndpoint(token);
      if (!response) {
        return null;
      }

      lastResponse = response;
      if (response.ok || response.status === 401) {
        return response;
      }

      if (response.status === 429) {
        this.consecutive429Count += 1;

        if (this.consecutive429Count >= this.MAX_CONSECUTIVE_429) {
          this.cooldownUntil = Date.now() + this.CIRCUIT_COOLDOWN_MS;
          return response;
        }

        if (attempt >= this.MAX_RETRIES) {
          return response;
        }

        const retryAfterHeader = response.headers.get("retry-after");
        const delayMs = this.computeBackoffDelayMs(attempt, retryAfterHeader);
        await this.sleep(delayMs);
        continue;
      }

      this.consecutive429Count = 0;

      if (response.status >= 500 && attempt < this.MAX_RETRIES) {
        const delayMs = this.computeBackoffDelayMs(attempt, null);
        await this.sleep(delayMs);
        continue;
      }

      return response;
    }

    return lastResponse;
  }

  private async fetchUsageEndpoint(token: string): Promise<Response | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      return await fetch("https://api.anthropic.com/api/oauth/usage", {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private computeBackoffDelayMs(attempt: number, retryAfterHeader: string | null): number {
    const retryAfterMs = this.parseRetryAfterMs(retryAfterHeader);
    if (retryAfterMs !== null) {
      return retryAfterMs;
    }

    const exponential = Math.min(this.BASE_BACKOFF_MS * (2 ** attempt), this.MAX_BACKOFF_MS);
    const jitter = Math.floor(Math.random() * 500);
    return exponential + jitter;
  }

  private parseRetryAfterMs(retryAfterHeader: string | null): number | null {
    if (!retryAfterHeader) {
      return null;
    }

    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.floor(seconds * 1000);
    }

    const at = Date.parse(retryAfterHeader);
    if (!Number.isNaN(at)) {
      const delay = at - Date.now();
      return delay > 0 ? delay : 0;
    }

    return null;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private refreshTokenViaCLI(): Promise<boolean> {
    return new Promise((resolve) => {
      const isWin = platform() === "win32";
      const claudePath = isWin ? "claude" : join(homedir(), ".local", "bin", "claude");
      const proc = spawn(claudePath, [], {
        stdio: "ignore",
        detached: !isWin,
        shell: isWin,
      });

      proc.on("error", () => {
        resolve(false);
      });

      setTimeout(() => {
        try {
          proc.kill();
        } catch { }
        resolve(true);
      }, 10000);

      proc.unref();
    });
  }
}
