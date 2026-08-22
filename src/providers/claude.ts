import { execFileSync } from "child_process";
import { readFile, stat, writeFile } from "fs/promises";
import { homedir, platform } from "os";
import { join } from "path";
import { BaseProvider } from "@/providers/base.js";
import { StandardUsageResult, ModelUsage, ProviderName, ClaudeOptions, ClaudeRawLimit, ClaudeRawResponse } from "@/types.js";

interface ClaudeOAuthData {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface ClaudeCredentials {
  claudeAiOauth?: ClaudeOAuthData;
  [key: string]: unknown;
}

interface StoredCredentials {
  oauth: ClaudeOAuthData;
  payload: ClaudeCredentials;
  source: "keychain" | "file";
}

type TokenResolution =
  | { token: string }
  | { error: "missing" | "expired" };

const KEYCHAIN_SERVICE = "Claude Code-credentials";

const SESSION_BUCKET = "5h_quota";
const WEEKLY_BUCKET = "7d_quota";
const SONNET_MODEL = "Sonnet";

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function scopedBucketKey(model: string): string {
  return `7d_${slugify(model)}_quota`;
}

function mapLimit(limit: ClaudeRawLimit, debug: (message: string) => void): { key: string; usage: ModelUsage } | null {
  if (limit.percent == null) {
    return null;
  }

  const usage: ModelUsage = {
    usagePercent: limit.percent,
    resetTime: limit.resets_at ?? null,
  };

  if (limit.kind === "session") {
    return { key: SESSION_BUCKET, usage: { ...usage, displayName: "5-Hour Quota" } };
  }
  if (limit.kind === "weekly_all") {
    return { key: WEEKLY_BUCKET, usage: { ...usage, displayName: "7-Day Quota" } };
  }
  if (limit.kind !== "weekly_scoped") {
    debug(`Ignoring limit of unknown kind "${limit.kind}"`);
    return null;
  }

  const model = limit.scope?.model?.display_name?.trim() || undefined;
  const surface = limit.scope?.surface?.trim() || undefined;
  const name = model ?? surface;
  if (!name || !slugify(name)) {
    debug("Ignoring scoped limit without a model or surface name");
    return null;
  }

  return {
    key: scopedBucketKey(name),
    usage: {
      ...usage,
      displayName: `7-Day ${name} Quota`,
      scope: { model, modelId: limit.scope?.model?.id ?? undefined, surface },
    },
  };
}

function mostConstrained(buckets: Array<ModelUsage | undefined>): ModelUsage | null {
  let worst: ModelUsage | null = null;
  for (const bucket of buckets) {
    if (!bucket || bucket.usagePercent == null) continue;
    if (!worst || bucket.usagePercent > (worst.usagePercent ?? -1)) {
      worst = bucket;
    }
  }
  return worst;
}

export function mapClaudeUsage(data: ClaudeRawResponse, debug: (message: string) => void = () => {}): StandardUsageResult {
  const perModel: Record<string, ModelUsage> = {};

  if (data.five_hour) {
    perModel[SESSION_BUCKET] = {
      usagePercent: data.five_hour.utilization,
      resetTime: data.five_hour.resets_at,
      displayName: "5-Hour Quota",
    };
  }
  if (data.seven_day) {
    perModel[WEEKLY_BUCKET] = {
      usagePercent: data.seven_day.utilization,
      resetTime: data.seven_day.resets_at,
      displayName: "7-Day Quota",
    };
  }
  if (data.seven_day_sonnet) {
    perModel[scopedBucketKey(SONNET_MODEL)] = {
      usagePercent: data.seven_day_sonnet.utilization,
      resetTime: data.seven_day_sonnet.resets_at,
      displayName: `7-Day ${SONNET_MODEL} Quota`,
      scope: { model: SONNET_MODEL },
    };
  }

  const fromLimits = new Set<string>();
  for (const limit of data.limits ?? []) {
    const mapped = mapLimit(limit, debug);
    if (!mapped) continue;
    if (fromLimits.has(mapped.key)) {
      debug(`Duplicate limit bucket "${mapped.key}", keeping the first one`);
      continue;
    }
    fromLimits.add(mapped.key);
    perModel[mapped.key] = mapped.usage;
  }

  const overall = mostConstrained([perModel[SESSION_BUCKET], perModel[WEEKLY_BUCKET]]);

  return {
    provider: ProviderName.Claude,
    overallUsagePercent: overall?.usagePercent ?? null,
    overallResetTime: overall?.resetTime ?? null,
    perModel,
  };
}

export class ClaudeProvider extends BaseProvider {
  readonly name = ProviderName.Claude;
  private credentialsPath: string;
  private useKeychain: boolean;
  private autoRefresh: boolean;
  private credCache: { stored: StoredCredentials | null; mtime?: number; timestamp?: number } | null = null;
  private readonly KEYCHAIN_CACHE_TTL_MS = 10000;
  private readonly MAX_RETRIES = 4;
  private readonly BASE_BACKOFF_MS = 1000;
  private readonly MAX_BACKOFF_MS = 30000;
  private readonly MAX_CONSECUTIVE_429 = 4;
  private readonly CIRCUIT_COOLDOWN_MS = 60000;
  // Claude Code's public OAuth client id; the token endpoint accepts refresh grants for it.
  private readonly OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
  private readonly OAUTH_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
  private readonly TOKEN_EXPIRY_LEEWAY_MS = 60000;
  private readonly REFRESH_COOLDOWN_MS = 300000;
  private consecutive429Count = 0;
  private cooldownUntil = 0;
  private invalidTokens = new Set<string>();
  // Refresh tokens rejected with invalid_grant; retrying them can never succeed until the user re-logs-in.
  private deadRefreshTokens = new Set<string>();
  private refreshCooldownUntil = 0;
  private refreshInFlight: Promise<ClaudeOAuthData | null> | null = null;
  // Holds refreshed credentials when writing them back to the original store fails.
  private memoryOauth: ClaudeOAuthData | null = null;

  constructor(options?: ClaudeOptions) {
    super(options);
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    this.credentialsPath = options?.credentialsPath || join(configDir, ".credentials.json");
    this.useKeychain = options?.useKeychain ?? true;
    this.autoRefresh = options?.autoRefresh ?? true;
  }

  protected onClearCache(): void {
    this.credCache = null;
    this.memoryOauth = null;
    this.invalidTokens.clear();
    this.deadRefreshTokens.clear();
    this.refreshCooldownUntil = 0;
  }

  protected async loadUsage(): Promise<StandardUsageResult> {
    const now = Date.now();
    if (this.cooldownUntil > now) {
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: 429, message: "Rate Limit" },
      };
    }

    const resolution = await this.resolveAccessToken();
    if ("error" in resolution) {
      this.debug(resolution.error === "expired" ? "Token expired and refresh unavailable" : "No credentials, returning auth error");
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: "AUTH", message: resolution.error === "expired" ? "Login Expired" : "Auth Required" },
      };
    }
    const token = resolution.token;

    try {
      this.debug("Fetching usage from Claude API");
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
        const refreshed = await this.refreshCredentials();
        if (refreshed?.accessToken) {
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

      const data = (await response.json()) as ClaudeRawResponse;
      const usage = mapClaudeUsage(data, (message) => this.debug(message));
      this.consecutive429Count = 0;
      this.cooldownUntil = 0;
      this.debug(`Usage fetched: ${usage.overallUsagePercent ?? "n/a"}% used`);
      return usage;
    } catch (err: any) {
      this.logger.error(`[${this.name}] Fetch failed: ${err?.message || err}`);
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: "API", message: "API Error" },
      };
    }
  }

  private async fetchUsageInternal(): Promise<StandardUsageResult> {
    const resolution = await this.resolveAccessToken();
    if ("error" in resolution) {
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: "AUTH", message: resolution.error === "expired" ? "Login Expired" : "Auth Required" },
      };
    }
    const token = resolution.token;

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

      const data = (await response.json()) as ClaudeRawResponse;
      const usage = mapClaudeUsage(data, (message) => this.debug(message));
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

  async fetchRawUsage(): Promise<ClaudeRawResponse> {
    const resolution = await this.resolveAccessToken();
    if ("error" in resolution) {
      throw new Error(resolution.error === "expired" ? "Authentication expired, run /login in Claude Code" : "Authentication credentials missing");
    }
    const response = await this.fetchUsageEndpoint(resolution.token);
    if (!response || !response.ok) {
      throw new Error(`Anthropic API returned status ${response?.status || "unknown"}`);
    }
    return (await response.json()) as ClaudeRawResponse;
  }

  /** Usage of the rolling 5-hour quota window. */
  getFiveHourUsage(): Promise<ModelUsage | null> {
    return this.bucket(SESSION_BUCKET);
  }

  /** Usage of the rolling 7-day quota window. */
  getSevenDayUsage(): Promise<ModelUsage | null> {
    return this.bucket(WEEKLY_BUCKET);
  }

  /** Usage of the Sonnet-specific 7-day quota window. */
  getSonnetWeeklyUsage(): Promise<ModelUsage | null> {
    return this.getScopedWeeklyUsage(SONNET_MODEL);
  }

  getScopedWeeklyUsage(model: string): Promise<ModelUsage | null> {
    return this.bucket(scopedBucketKey(model));
  }

  async listScopedWeeklyUsage(): Promise<Record<string, ModelUsage>> {
    const usage = await this.fetchUsage();
    const scoped: Record<string, ModelUsage> = {};
    for (const [key, bucket] of Object.entries(usage.perModel ?? {})) {
      if (bucket.scope) {
        scoped[key] = bucket;
      }
    }
    return scoped;
  }

  private async resolveAccessToken(): Promise<TokenResolution> {
    let stored: StoredCredentials | null = null;
    try {
      stored = await this.loadStoredCredentials();
    } catch {
      stored = null;
    }

    const oauth = this.pickFreshest(stored?.oauth ?? null, this.memoryOauth);
    if (!oauth?.accessToken) {
      return { error: "missing" };
    }

    const expired = this.isExpired(oauth) || this.invalidTokens.has(oauth.accessToken);
    if (!expired) {
      return { token: oauth.accessToken };
    }

    const refreshed = await this.refreshCredentials();
    if (refreshed?.accessToken && !this.invalidTokens.has(refreshed.accessToken)) {
      return { token: refreshed.accessToken };
    }

    // Refresh failed or is gated; a stale token that merely hit the expiry leeway may still work,
    // so only give up when we know the token is dead.
    if (!this.invalidTokens.has(oauth.accessToken)) {
      return { token: oauth.accessToken };
    }
    return { error: "expired" };
  }

  /** Prefers whichever credential set expires later: the CLI may have refreshed since our in-memory refresh. */
  private pickFreshest(stored: ClaudeOAuthData | null, memory: ClaudeOAuthData | null): ClaudeOAuthData | null {
    if (!memory?.accessToken) return stored;
    if (!stored?.accessToken) return memory;
    if ((stored.expiresAt ?? 0) >= (memory.expiresAt ?? 0)) {
      this.memoryOauth = null;
      return stored;
    }
    return memory;
  }

  private isExpired(oauth: ClaudeOAuthData): boolean {
    if (!oauth.expiresAt) {
      return false;
    }
    return Date.now() >= oauth.expiresAt - this.TOKEN_EXPIRY_LEEWAY_MS;
  }

  private async refreshCredentials(): Promise<ClaudeOAuthData | null> {
    if (!this.autoRefresh) {
      return null;
    }
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.refreshCredentialsCore().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refreshCredentialsCore(): Promise<ClaudeOAuthData | null> {
    if (Date.now() < this.refreshCooldownUntil) {
      this.debug("Token refresh in cooldown after previous failure");
      return null;
    }

    this.credCache = null;
    let stored: StoredCredentials | null = null;
    try {
      stored = await this.loadStoredCredentials();
    } catch {
      stored = null;
    }

    const refreshToken = this.memoryOauth?.refreshToken || stored?.oauth?.refreshToken;
    if (!refreshToken) {
      this.debug("No refresh token available");
      return null;
    }
    if (this.deadRefreshTokens.has(refreshToken)) {
      this.debug("Refresh token previously rejected, waiting for re-login");
      return null;
    }

    this.debug("Refreshing OAuth token");
    let response: Response | null = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        response = await fetch(this.OAUTH_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: this.OAUTH_CLIENT_ID,
          }).toString(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      response = null;
    }

    if (!response) {
      this.refreshCooldownUntil = Date.now() + this.REFRESH_COOLDOWN_MS;
      this.debug("Token refresh request failed (network)");
      return null;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // invalid_grant is terminal: the refresh token itself is revoked, only a re-login helps.
      if (body.includes("invalid_grant")) {
        this.deadRefreshTokens.add(refreshToken);
        this.logger.error(`[${this.name}] OAuth refresh rejected (invalid_grant), re-login required`);
      } else {
        this.refreshCooldownUntil = Date.now() + this.REFRESH_COOLDOWN_MS;
        this.logger.error(`[${this.name}] OAuth refresh failed with status ${response.status}`);
      }
      return null;
    }

    let data: { access_token?: string; refresh_token?: string; expires_in?: number };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      this.refreshCooldownUntil = Date.now() + this.REFRESH_COOLDOWN_MS;
      return null;
    }
    if (!data.access_token) {
      this.refreshCooldownUntil = Date.now() + this.REFRESH_COOLDOWN_MS;
      return null;
    }

    const oauth: ClaudeOAuthData = {
      ...stored?.oauth,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };
    this.memoryOauth = oauth;
    this.refreshCooldownUntil = 0;
    this.debug("Token refresh successful");

    // The endpoint may rotate the refresh token, so persist it where Claude Code reads it —
    // otherwise the CLI could be left holding a revoked token.
    if (stored) {
      const persisted = await this.persistCredentials(stored, oauth);
      if (persisted) {
        this.memoryOauth = null;
        this.credCache = null;
      } else {
        this.logger.error(`[${this.name}] Could not write refreshed token back to ${stored.source}, keeping it in memory`);
      }
    }
    return oauth;
  }

  private async persistCredentials(stored: StoredCredentials, oauth: ClaudeOAuthData): Promise<boolean> {
    const payload: ClaudeCredentials = {
      ...stored.payload,
      claudeAiOauth: { ...stored.payload.claudeAiOauth, ...oauth },
    };
    const json = JSON.stringify(payload);

    if (stored.source === "keychain") {
      try {
        const account = this.readKeychainAccount() ?? (process.env.USER || process.env.LOGNAME || "");
        execFileSync(
          "security",
          ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", json],
          { stdio: ["pipe", "pipe", "pipe"] }
        );
        return true;
      } catch {
        return false;
      }
    }

    try {
      await writeFile(this.credentialsPath, json, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /** Reads the account attribute of the existing keychain item so the write-back updates it in place. */
  private readKeychainAccount(): string | null {
    try {
      const output = execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      const match = output.match(/"acct"<blob>="([^"]*)"/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  private async loadStoredCredentials(): Promise<StoredCredentials | null> {
    if (platform() === "darwin" && this.useKeychain) {
      return await this.loadFromKeychain();
    }
    return await this.loadFromFile();
  }

  private async loadFromKeychain(): Promise<StoredCredentials | null> {
    if (
      this.credCache?.timestamp &&
      Date.now() - this.credCache.timestamp < this.KEYCHAIN_CACHE_TTL_MS &&
      this.credCache.stored?.source === "keychain"
    ) {
      return this.credCache.stored;
    }

    try {
      const result = execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();

      const payload: ClaudeCredentials = JSON.parse(result);
      if (!payload?.claudeAiOauth?.accessToken) {
        // Claude Code stores MCP server OAuth state in the same item; its presence alone
        // does not mean the user is logged in.
        this.debug("Keychain item has no claudeAiOauth token (MCP OAuth state only?)");
      }
      const stored: StoredCredentials = { oauth: payload?.claudeAiOauth ?? {}, payload: payload ?? {}, source: "keychain" };
      this.credCache = { stored, timestamp: Date.now() };
      return stored;
    } catch {
      return await this.loadFromFile();
    }
  }

  private async loadFromFile(): Promise<StoredCredentials | null> {
    try {
      const fileStat = await stat(this.credentialsPath);
      const mtime = fileStat.mtimeMs;

      if (this.credCache?.mtime === mtime && this.credCache.stored?.source === "file") {
        return this.credCache.stored;
      }

      const content = await readFile(this.credentialsPath, "utf-8");
      const payload: ClaudeCredentials = JSON.parse(content);
      const stored: StoredCredentials = { oauth: payload?.claudeAiOauth ?? {}, payload: payload ?? {}, source: "file" };
      this.credCache = { stored, mtime };
      return stored;
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
}
