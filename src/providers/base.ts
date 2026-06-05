import { StandardUsageResult, ProviderName, UsageSummary } from "../types.js";

export abstract class BaseProvider {
  abstract readonly name: ProviderName;
  abstract fetchUsage(): Promise<StandardUsageResult>;
  abstract fetchRawUsage(): Promise<unknown>;
  abstract fetchSummary(): Promise<UsageSummary>;
}
