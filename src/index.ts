import { ProviderName, LimitsClientOptions, StandardUsageResult, UsageSummary, Logger } from "@/types.js";
import { resolveLogger } from "@/utils.js";
import { AntigravityProvider } from "@/providers/antigravity.js";
import { ClaudeProvider } from "@/providers/claude.js";
import { ChatGptProvider } from "@/providers/chatgpt.js";
import { GeminiProvider } from "@/providers/gemini.js";
import { MiniMaxProvider } from "@/providers/minimax.js";
import { BaseProvider } from "@/providers/base.js";

export * from "@/types.js";
export * from "@/utils.js";
export { BaseProvider };
export { AntigravityProvider };
export { ClaudeProvider };
export { ChatGptProvider };
export { GeminiProvider };
export { MiniMaxProvider };

export class LimitsClient {
  private providers: Record<ProviderName, BaseProvider>;

  readonly logger: Logger;

  constructor(options?: LimitsClientOptions) {
    this.logger = resolveLogger(options?.logger);
    this.providers = {
      [ProviderName.Antigravity]: new AntigravityProvider(options?.antigravity),
      [ProviderName.Claude]: new ClaudeProvider(options?.claude),
      [ProviderName.ChatGpt]: new ChatGptProvider(options?.chatgpt),
      [ProviderName.Gemini]: new GeminiProvider(options?.gemini),
      [ProviderName.MiniMax]: new MiniMaxProvider(options?.minimax),
    };
    for (const provider of Object.values(this.providers)) {
      provider.setLogger(this.logger);
    }
  }

  getProvider<T extends BaseProvider>(name: ProviderName): T {
    return this.providers[name] as T;
  }

  async fetchUsage(provider: ProviderName): Promise<StandardUsageResult> {
    return this.providers[provider].fetchUsage();
  }

  async fetchRawUsage(provider: ProviderName): Promise<any> {
    return this.providers[provider].fetchRawUsage();
  }

  async fetchSummary(provider: ProviderName): Promise<UsageSummary> {
    return this.providers[provider].fetchSummary();
  }

  async fetchAllUsage(): Promise<Record<ProviderName, StandardUsageResult>> {
    const names = Object.values(ProviderName);
    const results = await Promise.all(
      names.map(async (name) => {
        const res = await this.fetchUsage(name);
        return { name, res };
      })
    );
    return results.reduce((acc, curr) => {
      acc[curr.name] = curr.res;
      return acc;
    }, {} as Record<ProviderName, StandardUsageResult>);
  }

  async fetchAllRawUsage(): Promise<Record<ProviderName, any>> {
    const names = Object.values(ProviderName);
    const results = await Promise.all(
      names.map(async (name) => {
        try {
          const res = await this.fetchRawUsage(name);
          return { name, res };
        } catch (err: any) {
          this.logger.error(`Failed to fetch raw usage for ${name}: ${err.message || err}`);
          return { name, res: { error: err.message || err } };
        }
      })
    );
    return results.reduce((acc, curr) => {
      acc[curr.name] = curr.res;
      return acc;
    }, {} as Record<ProviderName, any>);
  }

  async fetchAllSummaries(): Promise<Record<ProviderName, UsageSummary>> {
    const names = Object.values(ProviderName);
    const results = await Promise.all(
      names.map(async (name) => {
        const res = await this.fetchSummary(name);
        return { name, res };
      })
    );
    return results.reduce((acc, curr) => {
      acc[curr.name] = curr.res;
      return acc;
    }, {} as Record<ProviderName, UsageSummary>);
  }
}
