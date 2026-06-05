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

export interface LimitsClientOptions {
  antigravity?: {
    tokenPath?: string;
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
  };
  minimax?: {
    apiKey?: string;
  };
}
