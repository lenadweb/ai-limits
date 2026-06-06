import { StandardUsageResult, ModelUsage, ProviderName, UsageSummary, Logger } from "@/types.js";
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

  /** Reads a single normalized bucket from {@link fetchUsage}, or `null` if absent. */
  protected async bucket(key: string): Promise<ModelUsage | null> {
    const usage = await this.fetchUsage();
    return usage.perModel?.[key] ?? null;
  }

  /** Lists the available bucket keys for this provider's latest usage snapshot. */
  async listBuckets(): Promise<string[]> {
    const usage = await this.fetchUsage();
    return Object.keys(usage.perModel ?? {});
  }
}
