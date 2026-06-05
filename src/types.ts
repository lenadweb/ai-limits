export enum ProviderName {
  Antigravity = "antigravity",
  Claude = "claude",
  ChatGpt = "chatgpt",
  Gemini = "gemini",
  MiniMax = "minimax",
}

export interface ModelUsage {
  usagePercent: number;
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
  error?: {
    code: string | number;
    message: string;
  };
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

export interface LimitsClientOptions {
  logger?: LoggerOption;
  antigravity?: {
    tokenPath?: string;
    clientId?: string;
    clientSecret?: string;
  };
  claude?: {
    credentialsPath?: string;
    useKeychain?: boolean;
  };
  chatgpt?: {
    authPath?: string;
  };
  gemini?: {
    credentialsPath?: string;
    projectId?: string;
    clientId?: string;
    clientSecret?: string;
  };
  minimax?: {
    apiKey?: string;
  };
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
