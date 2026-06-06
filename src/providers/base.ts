import { StandardUsageResult, ModelUsage, ProviderName, UsageSummary, Logger, CacheOptions } from "@/types.js";
import { buildSummary, consoleLogger } from "@/utils.js";

const DEFAULT_CACHE_TTL_MS = 30000;

export abstract class BaseProvider {
  abstract readonly name: ProviderName;
  protected logger: Logger = consoleLogger;
  protected readonly cacheTtlMs: number;
  private usageCache: { value: StandardUsageResult; at: number } | null = null;

  constructor(options?: CacheOptions) {
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  setLogger(logger: Logger): this {
    this.logger = logger;
    return this;
  }

  protected debug(message: string): void {
    this.logger.log(`[${this.name}] ${message}`);
  }

  /** Normalized usage, served from the internal cache when still fresh. */
  async fetchUsage(): Promise<StandardUsageResult> {
    const now = Date.now();
    if (this.usageCache && this.cacheTtlMs > 0 && now - this.usageCache.at < this.cacheTtlMs) {
      this.debug("Returning cached usage");
      return this.usageCache.value;
    }

    const value = await this.loadUsage();
    if (!value.error && this.cacheTtlMs > 0) {
      this.usageCache = { value, at: now };
    }
    return value;
  }

  /** Drops the cached usage so the next {@link fetchUsage} hits the network. */
  clearCache(): void {
    this.usageCache = null;
    this.onClearCache();
  }

  /** Hook for subclasses that maintain additional caches. */
  protected onClearCache(): void {}

  async fetchSummary(): Promise<UsageSummary> {
    return buildSummary(await this.fetchUsage());
  }

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

  /** Fetches and normalizes usage without caching; called by {@link fetchUsage}. */
  protected abstract loadUsage(): Promise<StandardUsageResult>;

  abstract fetchRawUsage(): Promise<unknown>;
}
