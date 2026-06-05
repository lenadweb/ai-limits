import { ProviderName, LimitsClientOptions, StandardUsageResult } from "./types.js";
import { AntigravityProvider } from "./providers/antigravity.js";
import { ClaudeProvider } from "./providers/claude.js";
import { ChatGptProvider } from "./providers/chatgpt.js";
import { GeminiProvider } from "./providers/gemini.js";
import { MiniMaxProvider } from "./providers/minimax.js";
import { BaseProvider } from "./providers/base.js";

export * from "./types.js";
export { BaseProvider };
export { AntigravityProvider };
export { ClaudeProvider };
export { ChatGptProvider };
export { GeminiProvider };
export { MiniMaxProvider };

export class LimitsClient {
  private providers: Record<ProviderName, BaseProvider>;

  constructor(options?: LimitsClientOptions) {
    this.providers = {
      [ProviderName.Antigravity]: new AntigravityProvider(options?.antigravity),
      [ProviderName.Claude]: new ClaudeProvider(options?.claude),
      [ProviderName.ChatGpt]: new ChatGptProvider(options?.chatgpt),
      [ProviderName.Gemini]: new GeminiProvider(options?.gemini),
      [ProviderName.MiniMax]: new MiniMaxProvider(options?.minimax),
    };
  }

  getProvider(name: ProviderName): BaseProvider {
    return this.providers[name];
  }

  async fetchUsage(provider: ProviderName): Promise<StandardUsageResult> {
    return this.providers[provider].fetchUsage();
  }

  async fetchAllUsage(): Promise<Record<ProviderName, StandardUsageResult>> {
    const names: ProviderName[] = [
      ProviderName.Antigravity,
      ProviderName.Claude,
      ProviderName.ChatGpt,
      ProviderName.Gemini,
      ProviderName.MiniMax,
    ];
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
}
