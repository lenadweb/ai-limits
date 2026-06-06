import { BaseProvider } from "@/providers/base.js";
import {
  ApiKeyOptions,
  ModelUsage,
  OpenRouterLimit,
  OpenRouterRawResponse,
  OpenRouterUsage,
  ProviderError,
  ProviderErrorCode,
  ProviderName,
  ResetInterval,
  StandardUsageResult,
} from "@/types.js";

type LimitReset = ResetInterval | null;
type KeyData = OpenRouterRawResponse["data"];

const ENDPOINT = "https://openrouter.ai/api/v1/key";
const REQUEST_TIMEOUT_MS = 5000;

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

function toLimit(data: KeyData): OpenRouterLimit | null {
  const { limit } = data;
  if (limit == null || limit <= 0) return null;

  const interval = data.limit_reset ?? null;
  const used = data.limit_remaining != null ? limit - data.limit_remaining : usageForWindow(data, interval);

  return {
    amount: limit,
    interval,
    used,
    remaining: data.limit_remaining ?? Math.max(0, limit - used),
    usagePercent: clampPercent(Math.round((used / limit) * 100)),
    resetTime: nextReset(interval),
  };
}

export class OpenRouterProvider extends BaseProvider {
  readonly name = ProviderName.OpenRouter;
  private readonly apiKey: string | null;
  private cache: { response: OpenRouterRawResponse; at: number } | null = null;

  constructor(options?: ApiKeyOptions) {
    super(options);
    this.apiKey = options?.apiKey || process.env.OPENROUTER_API_KEY || null;
  }

  protected async loadUsage(): Promise<StandardUsageResult> {
    if (!this.apiKey) {
      this.debug("No API key configured, returning auth error");
      return this.errorResult("AUTH", "Auth Required");
    }

    try {
      const data = await this.loadData();
      return this.buildResult(data);
    } catch (err) {
      return this.mapError(err);
    }
  }

  async fetchRawUsage(): Promise<OpenRouterRawResponse> {
    return this.load();
  }

  protected onClearCache(): void {
    this.cache = null;
  }

  /** Structured, fully typed view of the key's limit and spend. */
  async fetchDetails(): Promise<OpenRouterUsage> {
    const data = await this.loadData();
    return {
      isFreeTier: data.is_free_tier ?? false,
      limit: toLimit(data),
      spend: {
        total: data.usage,
        daily: data.usage_daily ?? null,
        weekly: data.usage_weekly ?? null,
        monthly: data.usage_monthly ?? null,
      },
    };
  }

  /** Configured spend limit on the key, or `null` when the key is unlimited. */
  async getLimit(): Promise<OpenRouterLimit | null> {
    return toLimit(await this.loadData());
  }

  /** All-time spend in USD. */
  async getTotalSpend(): Promise<number> {
    return (await this.loadData()).usage;
  }

  async getDailySpend(): Promise<number | null> {
    return (await this.loadData()).usage_daily ?? null;
  }

  async getWeeklySpend(): Promise<number | null> {
    return (await this.loadData()).usage_weekly ?? null;
  }

  async getMonthlySpend(): Promise<number | null> {
    return (await this.loadData()).usage_monthly ?? null;
  }

  private async loadData(): Promise<KeyData> {
    return (await this.load()).data;
  }

  private async load(): Promise<OpenRouterRawResponse> {
    const now = Date.now();
    if (this.cache && this.cacheTtlMs > 0 && now - this.cache.at < this.cacheTtlMs) {
      this.debug("Returning cached key data");
      return this.cache.response;
    }

    if (!this.apiKey) {
      throw new Error("Authentication credentials missing");
    }

    this.debug("Fetching key usage from OpenRouter API");
    const response = await this.requestKeyInfo();
    this.cache = { response, at: now };
    return response;
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

    const limit = toLimit(data);
    if (limit) {
      overallUsagePercent = limit.usagePercent;
      overallResetTime = limit.resetTime;

      perModel[limit.interval ?? "total"] = {
        usagePercent: limit.usagePercent,
        remainingAmount: limit.remaining,
        limitAmount: limit.amount,
        resetTime: limit.resetTime,
        displayName: `${limit.interval ? WINDOW_LABEL[limit.interval] : "Total"} Limit ($${limit.amount})`,
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

  private errorResult(code: ProviderErrorCode, message: string): StandardUsageResult {
    const error: ProviderError = { code, message };
    return {
      provider: this.name,
      overallUsagePercent: null,
      overallResetTime: null,
      error,
    };
  }
}
