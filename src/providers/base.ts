import { StandardUsageResult, ProviderName } from "../types.js";

export abstract class BaseProvider {
  abstract readonly name: ProviderName;
  abstract fetchUsage(): Promise<StandardUsageResult>;
}
