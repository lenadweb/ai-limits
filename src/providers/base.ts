import { StandardUsageResult, ProviderName, UsageSummary, Logger } from "@/types.js";
import { consoleLogger } from "@/utils.js";

export abstract class BaseProvider {
  abstract readonly name: ProviderName;
  protected logger: Logger = consoleLogger;

  setLogger(logger: Logger): this {
    this.logger = logger;
    return this;
  }

  protected debug(message: string): void {
    this.logger.log(`[${this.name}] ${message}`);
  }

  abstract fetchUsage(): Promise<StandardUsageResult>;
  abstract fetchRawUsage(): Promise<unknown>;
  abstract fetchSummary(): Promise<UsageSummary>;
}
