import { BaseProvider } from "@/providers/base.js";
import { StandardUsageResult, ModelUsage, ProviderName, MiniMaxRawResponse, UsageSummary } from "@/types.js";
import { buildSummary } from "@/utils.js";

interface MiniMaxModelRemains {
  start_time: number;
  end_time: number;
  remains_time: number;
  current_interval_total_count: number;
  current_interval_usage_count: number;
  model_name: string;
  current_weekly_total_count: number;
  current_weekly_usage_count: number;
  weekly_start_time: number;
  weekly_end_time: number;
  weekly_remains_time: number;
  current_interval_status?: number;
  current_interval_remaining_percent?: number;
  current_weekly_status?: number;
  current_weekly_remaining_percent?: number;
}

interface MiniMaxApiResponse {
  model_remains: MiniMaxModelRemains[];
  base_resp: { status_code: number; status_msg: string };
}

export class MiniMaxProvider extends BaseProvider {
  readonly name = ProviderName.MiniMax;
  private apiKey: string | null;
  private lastFetch: number = 0;
  private cache: StandardUsageResult | null = null;
  private readonly CACHE_TTL_MS = 60000;
  private readonly TARGET_MODEL = "general";

  constructor(options?: { apiKey?: string }) {
    super();
    this.apiKey = options?.apiKey || process.env.MINIMAX_API_KEY || null;
  }

  async fetchUsage(): Promise<StandardUsageResult> {
    const now = Date.now();
    if (this.cache && (now - this.lastFetch) < this.CACHE_TTL_MS) {
      this.debug("Returning cached usage");
      return this.cache;
    }

    if (!this.apiKey) {
      this.debug("No API key configured, returning auth error");
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: "AUTH", message: "Auth Required" },
      };
    }

    try {
      this.debug("Fetching usage from MiniMax API");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch("https://platform.minimax.io/v1/api/openplatform/coding_plan/remains", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Accept": "application/json",
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

      const data = (await response.json()) as MiniMaxApiResponse;

      if (data.base_resp.status_code !== 0) {
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: { code: "API", message: data.base_resp.status_msg },
        };
      }

      const model = data.model_remains.find((m) => m.model_name === this.TARGET_MODEL);
      if (!model) {
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: { code: "API", message: "Model missing" },
        };
      }

      const dailyRemaining = model.current_interval_remaining_percent ?? 100;
      const weeklyRemaining = model.current_weekly_remaining_percent ?? 100;
      const sessionPercent = Math.max(0, Math.min(100, Math.round(100 - dailyRemaining)));
      const weekPercent = Math.max(0, Math.min(100, Math.round(100 - weeklyRemaining)));

      const overallUsagePercent = Math.max(sessionPercent, weekPercent);
      const overallResetTime = new Date(model.end_time).toISOString();

      const perModel: Record<string, ModelUsage> = {
        [this.TARGET_MODEL]: {
          usagePercent: sessionPercent,
          resetTime: new Date(model.end_time).toISOString(),
          displayName: "Daily Interval",
        },
        "weekly_interval": {
          usagePercent: weekPercent,
          resetTime: new Date(model.weekly_end_time).toISOString(),
          displayName: "Weekly Interval",
        },
      };

      const result: StandardUsageResult = {
        provider: this.name,
        overallUsagePercent,
        overallResetTime,
        perModel,
      };

      this.cache = result;
      this.lastFetch = now;
      this.debug(`Usage fetched: ${overallUsagePercent}% used`);
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

  async fetchRawUsage(): Promise<MiniMaxRawResponse> {
    if (!this.apiKey) {
      throw new Error("Authentication credentials missing");
    }
    const response = await fetch("https://platform.minimax.io/v1/api/openplatform/coding_plan/remains", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Accept": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`MiniMax API returned status ${response.status}`);
    }
    return (await response.json()) as MiniMaxRawResponse;
  }

  async fetchSummary(): Promise<UsageSummary> {
    const usage = await this.fetchUsage();
    return buildSummary(usage);
  }
}
