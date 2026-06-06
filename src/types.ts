export enum ProviderName {
  Antigravity = "antigravity",
  Claude = "claude",
  ChatGpt = "chatgpt",
  Gemini = "gemini",
  MiniMax = "minimax",
  OpenRouter = "openrouter",
}

export type ResetInterval = "daily" | "weekly" | "monthly";

export type ProviderErrorCode = "AUTH" | "API" | "CONN" | number;

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
}

export interface ModelUsage {
  usagePercent: number | null;
  remainingAmount?: number;
  limitAmount?: number;
  resetTime?: string | null;
  displayName?: string;
}

export interface StandardUsageResult {
  provider: ProviderName;
  overallUsagePercent: number | null;
  overallResetTime: string | null;
  perModel?: Record<string, ModelUsage>;
  error?: ProviderError;
}

export interface UsageSummary {
  provider: ProviderName;
  overallUsagePercent: number | null;
  overallResetTime: string | null;
  isExhausted: boolean;
  isRateLimited: boolean;
  needsAuthentication: boolean;
  formattedText: string;
}

export type LogFunction = (message: string) => void;

export interface Logger {
  log: LogFunction;
  error: LogFunction;
}

export type LoggerOption = LogFunction | Logger;

export interface CacheOptions {
  /** Internal usage cache TTL in milliseconds. Defaults to 30000. Set to 0 to disable caching. */
  cacheTtlMs?: number;
}

export interface ApiKeyOptions extends CacheOptions {
  apiKey?: string;
}

export interface AntigravityOptions extends CacheOptions {
  tokenPath?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface ClaudeOptions extends CacheOptions {
  credentialsPath?: string;
  useKeychain?: boolean;
}

export interface ChatGptOptions extends CacheOptions {
  authPath?: string;
}

export interface GeminiOptions extends CacheOptions {
  credentialsPath?: string;
  projectId?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface LimitsClientOptions {
  logger?: LoggerOption;
  /** Default usage cache TTL (ms) applied to every provider. Per-provider `cacheTtlMs` overrides it. Set to 0 to disable. */
  cacheTtlMs?: number;
  antigravity?: AntigravityOptions;
  claude?: ClaudeOptions;
  chatgpt?: ChatGptOptions;
  gemini?: GeminiOptions;
  minimax?: ApiKeyOptions;
  openrouter?: ApiKeyOptions;
}

export interface AntigravityRawModelInfo {
  displayName?: string;
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
    isExhausted?: boolean;
  };
  [key: string]: any;
}

export interface AntigravityRawResponse {
  buckets?: Array<{
    modelId?: string;
    remainingFraction?: number;
    resetTime?: string;
    [key: string]: any;
  }>;
  models?: Record<string, AntigravityRawModelInfo>;
}

export interface ClaudeRawResponse {
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

export interface ChatGptRawResponse {
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

export interface GeminiRawResponse {
  buckets?: Array<{
    resetTime: string;
    tokenType: string;
    modelId: string;
    remainingFraction: number;
    remainingAmount?: string;
  }>;
}

export interface MiniMaxRawResponse {
  model_remains: Array<{
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
  }>;
  base_resp: { status_code: number; status_msg: string };
}

export interface OpenRouterRawResponse {
  data: {
    label?: string;
    usage: number;
    limit: number | null;
    is_free_tier?: boolean;
    limit_remaining?: number | null;
    usage_daily?: number;
    usage_weekly?: number;
    usage_monthly?: number;
    limit_reset?: ResetInterval | null;
  };
}

export interface OpenRouterLimit {
  amount: number;
  interval: ResetInterval | null;
  used: number;
  remaining: number;
  usagePercent: number;
  resetTime: string | null;
}

export interface OpenRouterSpend {
  total: number;
  daily: number | null;
  weekly: number | null;
  monthly: number | null;
}

export interface OpenRouterUsage {
  isFreeTier: boolean;
  limit: OpenRouterLimit | null;
  spend: OpenRouterSpend;
}
