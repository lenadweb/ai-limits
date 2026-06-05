import { StandardUsageResult, UsageSummary, Logger, LoggerOption } from "@/types.js";

export const consoleLogger: Logger = {
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
};

export function resolveLogger(logger?: LoggerOption): Logger {
  if (!logger) return consoleLogger;
  if (typeof logger === "function") {
    return { log: logger, error: logger };
  }
  return logger;
}

export function formatResetTime(resetStr: string | null): string {
  if (!resetStr) return "-";
  try {
    const date = new Date(resetStr);
    if (isNaN(date.getTime())) return resetStr;
    
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    if (diffMs <= 0) return "Reset now";
    
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    
    if (diffHours > 0) {
      return `in ${diffHours}h ${mins}m`;
    }
    return `in ${diffMins}m`;
  } catch {
    return resetStr;
  }
}

export function buildSummary(result: StandardUsageResult): UsageSummary {
  const needsAuthentication = result.error?.code === "AUTH";
  const isRateLimited = result.error?.code === 429;
  const isExhausted = result.overallUsagePercent !== null && result.overallUsagePercent >= 100;
  
  let formattedText = `${result.provider.toUpperCase()}: `;
  if (result.error) {
    formattedText += `Error (${result.error.code}): ${result.error.message}`;
  } else if (result.overallUsagePercent !== null) {
    formattedText += `${result.overallUsagePercent}% used`;
    if (result.overallResetTime) {
      formattedText += `, resets ${formatResetTime(result.overallResetTime)}`;
    }
  } else {
    formattedText += "No usage data";
  }

  return {
    provider: result.provider,
    overallUsagePercent: result.overallUsagePercent,
    overallResetTime: result.overallResetTime,
    isExhausted,
    isRateLimited,
    needsAuthentication,
    formattedText,
  };
}
