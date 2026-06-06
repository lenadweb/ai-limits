import { BaseProvider } from "@/providers/base.js";
import { StandardUsageResult, ModelUsage, ProviderName, OpenRouterRawResponse, UsageSummary } from "@/types.js";
import { buildSummary } from "@/utils.js";

type ResetInterval = "daily" | "weekly" | "monthly";
type LimitReset = ResetInterval | null;
type KeyData = OpenRouterRawResponse["data"];

const ENDPOINT = "https://openrouter.ai/api/v1/key";
const REQUEST_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60000;

const WINDOW_LABEL: Record<ResetInterval, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const SPEND_WINDOWS: ReadonlyArray<{
  key: string;
  label: string;
  field: "usage_daily" | "usage_weekly" | "usage_monthly";
  reset: ResetInterval;
}> = [
  { key: "spend_daily", label: "day", field: "usage_daily", reset: "daily" },
  { key: "spend_weekly", label: "week", field: "usage_weekly", reset: "weekly" },
  { key: "spend_monthly", label: "month", field: "usage_monthly", reset: "monthly" },
];

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatAmount(value: number): string {
  return Number(value ?? 0).toFixed(4).replace(/\.?0+$/, "");
}

function usageForWindow(data: KeyData, reset: LimitReset): number {
  switch (reset) {
    case "daily":
      return data.usage_daily ?? data.usage;
    case "weekly":
      return data.usage_weekly ?? data.usage;
    case "monthly":
      return data.usage_monthly ?? data.usage;
    default:
      return data.usage;
  }
}

function nextReset(reset: LimitReset): string | null {
  if (!reset) return null;
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();
  switch (reset) {
    case "daily":
      return new Date(Date.UTC(year, month, date + 1)).toISOString();
    case "weekly": {
      const weekday = now.getUTCDay() || 7;
      return new Date(Date.UTC(year, month, date + (8 - weekday))).toISOString();
    }
    case "monthly":
      return new Date(Date.UTC(year, month + 1, 1)).toISOString();
  }
}

export class OpenRouterProvider extends BaseProvider {
  readonly name = ProviderName.OpenRouter;
  private readonly apiKey: string | null;
  private cache: StandardUsageResult | null = null;
  private lastFetch = 0;

  constructor(options?: { apiKey?: string }) {
    super();
    this.apiKey = options?.apiKey || process.env.OPENROUTER_API_KEY || null;
  }

  async fetchUsage(): Promise<StandardUsageResult> {
    const now = Date.now();
    if (this.cache && now - this.lastFetch < CACHE_TTL_MS) {
      this.debug("Returning cached usage");
      return this.cache;
    }

    if (!this.apiKey) {
      this.debug("No API key configured, returning auth error");
      return this.errorResult("AUTH", "Auth Required");
    }

    try {
      this.debug("Fetching key usage from OpenRouter API");
      const { data } = await this.requestKeyInfo();
      const result = this.buildResult(data);
      this.cache = result;
      this.lastFetch = now;
      this.debug(`Usage fetched: ${result.overallUsagePercent ?? "n/a"}% used`);
      return result;
    } catch (err) {
      return this.mapError(err);
    }
  }

  async fetchRawUsage(): Promise<OpenRouterRawResponse> {
    if (!this.apiKey) {
      throw new Error("Authentication credentials missing");
    }
    return this.requestKeyInfo();
  }

  async fetchSummary(): Promise<UsageSummary> {
    return buildSummary(await this.fetchUsage());
  }

  private async requestKeyInfo(): Promise<OpenRouterRawResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(ENDPOINT, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      this.debug(`Response status ${response.status}`);

      if (!response.ok) {
        throw Object.assign(new Error(`OpenRouter API returned status ${response.status}`), {
          status: response.status,
        });
      }

      return (await response.json()) as OpenRouterRawResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildResult(data: KeyData): StandardUsageResult {
    const perModel: Record<string, ModelUsage> = {};
    let overallUsagePercent: number | null = null;
    let overallResetTime: string | null = null;

    const { limit } = data;
    if (limit != null && limit > 0) {
      const reset = data.limit_reset ?? null;
      const used = data.limit_remaining != null ? limit - data.limit_remaining : usageForWindow(data, reset);

      overallUsagePercent = clampPercent(Math.round((used / limit) * 100));
      overallResetTime = nextReset(reset);

      perModel[reset ?? "total"] = {
        usagePercent: overallUsagePercent,
        remainingAmount: data.limit_remaining ?? Math.max(0, limit - used),
        limitAmount: limit,
        resetTime: overallResetTime,
        displayName: `${reset ? WINDOW_LABEL[reset] : "Total"} Limit ($${limit})`,
      };
    }

    for (const window of SPEND_WINDOWS) {
      const spent = data[window.field];
      if (spent != null) {
        perModel[window.key] = {
          usagePercent: null,
          resetTime: nextReset(window.reset),
          displayName: `Spend (${window.label}): $${formatAmount(spent)}`,
        };
      }
    }

    perModel.spend_total = {
      usagePercent: null,
      resetTime: null,
      displayName: `Spend (all-time): $${formatAmount(data.usage)}`,
    };

    return {
      provider: this.name,
      overallUsagePercent,
      overallResetTime,
      perModel,
    };
  }

  private mapError(err: unknown): StandardUsageResult {
    const status = (err as { status?: number })?.status;
    if (status) {
      this.logger.error(`[${this.name}] Request failed with status ${status}`);
      const message = status === 401 ? "Auth Required" : status === 429 ? "Rate Limit" : `Error ${status}`;
      return this.errorResult(status, message);
    }

    this.logger.error(`[${this.name}] Connection error: ${(err as Error)?.message || err}`);
    return this.errorResult("CONN", "Conn Error");
  }

  private errorResult(code: string | number, message: string): StandardUsageResult {
    return {
      provider: this.name,
      overallUsagePercent: null,
      overallResetTime: null,
      error: { code, message },
    };
  }
}
