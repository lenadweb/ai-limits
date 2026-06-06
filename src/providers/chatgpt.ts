import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { BaseProvider } from "@/providers/base.js";
import { StandardUsageResult, ModelUsage, ProviderName, ChatGptOptions, ChatGptRawResponse } from "@/types.js";

interface CodexAuthData {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

interface CodexApiResponse {
  plan_type: string;
  rate_limit: {
    primary_window?: {
      used_percent: number;
      reset_at: number;
    } | null;
    secondary_window?: {
      used_percent: number;
      reset_at: number;
    } | null;
  };
}

export class ChatGptProvider extends BaseProvider {
  readonly name = ProviderName.ChatGpt;
  private authPath: string;

  constructor(options?: ChatGptOptions) {
    super(options);
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    this.authPath = options?.authPath || join(codexHome, "auth.json");
  }

  protected async loadUsage(): Promise<StandardUsageResult> {
    const auth = await this.readAuthTokens();
    if (!auth) {
      this.debug(`No auth tokens at ${this.authPath}, returning auth error`);
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: "AUTH", message: "Auth Required" },
      };
    }

    try {
      this.debug("Fetching usage from ChatGPT API");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${auth.accessToken}`,
          "ChatGPT-Account-Id": auth.accountId,
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      this.debug(`Response status ${response.status}`);

      if (!response.ok) {
        this.logger.error(`[${this.name}] Request failed with status ${response.status}`);
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: {
            code: response.status,
            message: response.status === 401 ? "Auth Required" : response.status === 429 ? "Rate Limit" : `Error ${response.status}`,
          },
        };
      }

      const data = (await response.json()) as CodexApiResponse;

      const primaryUsed = data.rate_limit.primary_window?.used_percent ?? null;
      const secondaryUsed = data.rate_limit.secondary_window?.used_percent ?? null;
      let overallUsagePercent = null;
      if (primaryUsed !== null && secondaryUsed !== null) {
        overallUsagePercent = Math.max(primaryUsed, secondaryUsed);
      } else if (primaryUsed !== null) {
        overallUsagePercent = primaryUsed;
      } else if (secondaryUsed !== null) {
        overallUsagePercent = secondaryUsed;
      }

      const primaryReset = data.rate_limit.primary_window?.reset_at ?? null;
      const secondaryReset = data.rate_limit.secondary_window?.reset_at ?? null;
      let overallResetTime: string | null = null;
      if (primaryReset !== null && secondaryReset !== null && primaryUsed !== null && secondaryUsed !== null) {
        overallResetTime = new Date((primaryUsed >= secondaryUsed ? primaryReset : secondaryReset) * 1000).toISOString();
      } else if (primaryReset !== null) {
        overallResetTime = new Date(primaryReset * 1000).toISOString();
      } else if (secondaryReset !== null) {
        overallResetTime = new Date(secondaryReset * 1000).toISOString();
      }

      const perModel: Record<string, ModelUsage> = {};
      if (data.rate_limit.primary_window) {
        perModel["primary_window"] = {
          usagePercent: data.rate_limit.primary_window.used_percent,
          resetTime: new Date(data.rate_limit.primary_window.reset_at * 1000).toISOString(),
          displayName: "Primary Window",
        };
      }
      if (data.rate_limit.secondary_window) {
        perModel["secondary_window"] = {
          usagePercent: data.rate_limit.secondary_window.used_percent,
          resetTime: new Date(data.rate_limit.secondary_window.reset_at * 1000).toISOString(),
          displayName: "Secondary Window",
        };
      }

      const result: StandardUsageResult = {
        provider: this.name,
        overallUsagePercent,
        overallResetTime,
        perModel,
      };

      this.debug(`Usage fetched: ${overallUsagePercent ?? "n/a"}% used`);
      return result;
    } catch (err: any) {
      this.logger.error(`[${this.name}] Connection error: ${err?.message || err}`);
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: "CONN", message: "Conn Error" },
      };
    }
  }

  async fetchRawUsage(): Promise<ChatGptRawResponse> {
    const auth = await this.readAuthTokens();
    if (!auth) {
      throw new Error("Authentication credentials missing");
    }
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${auth.accessToken}`,
        "ChatGPT-Account-Id": auth.accountId,
      },
    });
    if (!response.ok) {
      throw new Error(`ChatGPT API returned status ${response.status}`);
    }
    return (await response.json()) as ChatGptRawResponse;
  }

  /** Usage of the primary rate-limit window. */
  getPrimaryWindow(): Promise<ModelUsage | null> {
    return this.bucket("primary_window");
  }

  /** Usage of the secondary rate-limit window. */
  getSecondaryWindow(): Promise<ModelUsage | null> {
    return this.bucket("secondary_window");
  }

  private async readAuthTokens(): Promise<{ accessToken: string; accountId: string } | null> {
    try {
      if (!existsSync(this.authPath)) {
        return null;
      }

      const content = await readFile(this.authPath, "utf-8");
      const auth: CodexAuthData = JSON.parse(content);
      const accessToken = auth?.tokens?.access_token;
      const accountId = auth?.tokens?.account_id;

      if (!accessToken || !accountId) {
        return null;
      }

      return { accessToken, accountId };
    } catch {
      return null;
    }
  }
}
