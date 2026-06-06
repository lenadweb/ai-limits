# ai-limits

[![npm version](https://img.shields.io/npm/v/@lenadweb/ai-limits.svg)](https://www.npmjs.com/package/@lenadweb/ai-limits)
[![license](https://img.shields.io/npm/l/@lenadweb/ai-limits.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@lenadweb/ai-limits.svg)](https://nodejs.org)

A CLI and TypeScript SDK to check usage limits and quotas across multiple AI coding assistants from one place.

It reuses the credentials that the official tools already store on your machine, so for most providers there is nothing to configure. Run one command and see how much of your plan is left and when it resets.

```
Provider: CLAUDE
Overall Usage: ████████░░ 78%
Next Reset:    in 2h 14m

┌──────────────────────────────┬────────────────────┬────────────────────┐
│ Model/Bucket                 │ Usage              │ Reset Time         │
├──────────────────────────────┼────────────────────┼────────────────────┤
│ 5-hour window                │ ████████░░ 78%     │ in 2h 14m          │
│ 7-day window                 │ ███░░░░░░░ 31%      │ in 5d 3h           │
└──────────────────────────────┴────────────────────┴────────────────────┘
```

## Supported providers

| Provider | Source | Where credentials come from |
| --- | --- | --- |
| Claude | Anthropic / Claude Code CLI | macOS Keychain or `~/.claude/.credentials.json` |
| ChatGPT / Codex | ChatGPT backend API | `~/.codex/auth.json` |
| Gemini | Google Cloud Code Assist | `~/.gemini/oauth_creds.json` |
| Antigravity | Google Cloud Code Assist | OAuth login built into this CLI |
| MiniMax | MiniMax OpenPlatform API | `MINIMAX_API_KEY` environment variable |
| OpenRouter | OpenRouter API key endpoint | `OPENROUTER_API_KEY` environment variable |

For Claude, ChatGPT and Gemini the credentials are created by the providers' own CLIs and IDE plugins. If those tools already work on your machine, this one works too. Antigravity is the only provider that needs an explicit login through this CLI.

OpenRouter has no plan-based quota. Instead it reports the per-key spend limit (e.g. `$3 / month`): if the key has a limit set, you get an overall usage bar and reset time; if the key is unlimited, the spend is shown for information only.

## Installation

Install globally to use the CLI anywhere:

```bash
npm install -g @lenadweb/ai-limits
```

Or add it to a project to use the SDK:

```bash
npm install @lenadweb/ai-limits
```

Requires Node.js 18 or newer.

## CLI usage

### Show usage

```bash
# All providers at once
ai-limits show

# A single provider
ai-limits show claude
ai-limits show chatgpt
ai-limits show gemini
ai-limits show minimax
ai-limits show openrouter
ai-limits show antigravity
```

Each provider is printed with an overall usage bar, the next reset time, and a per-model or per-window breakdown when the provider exposes one.

### Antigravity login

Antigravity uses Google OAuth. Authenticate once and the tokens are cached locally:

```bash
# Open the browser and complete the OAuth flow
ai-limits login antigravity

# Remove the cached tokens
ai-limits logout antigravity
```

## SDK usage

```typescript
import { LimitsClient } from "@lenadweb/ai-limits";

const client = new LimitsClient();

// Usage for every provider, keyed by provider name
const all = await client.fetchAllUsage();
console.log(all.claude.overallUsagePercent);

// Usage for a single provider
const claude = await client.fetchUsage("claude");
console.log(claude.overallUsagePercent, claude.overallResetTime);
```

### Available methods

| Method | Returns | Description |
| --- | --- | --- |
| `fetchUsage(provider)` | `StandardUsageResult` | Normalized usage for one provider. |
| `fetchAllUsage()` | `Record<Provider, StandardUsageResult>` | Normalized usage for every provider in parallel. |
| `fetchSummary(provider)` | `UsageSummary` | Compact status with flags and a ready to print line. |
| `fetchAllSummaries()` | `Record<Provider, UsageSummary>` | Summaries for every provider. |
| `fetchRawUsage(provider)` | `any` | The provider's raw API response, unmodified. |
| `fetchAllRawUsage()` | `Record<Provider, any>` | Raw responses for every provider, errors captured per provider. |
| `getProvider(name)` | `BaseProvider` | The underlying provider instance, for example to call `login()` on Antigravity. |

### Response shapes

`fetchUsage` returns a normalized result that is the same for every provider:

```typescript
interface StandardUsageResult {
  provider: string;
  overallUsagePercent: number | null;
  overallResetTime: string | null; // ISO timestamp
  perModel?: Record<string, {
    usagePercent: number;
    remainingAmount?: number;
    limitAmount?: number;
    resetTime?: string | null;
    displayName?: string;
  }>;
  error?: { code: string | number; message: string };
}
```

`fetchSummary` returns a smaller object that is handy for status bars and alerts:

```typescript
interface UsageSummary {
  provider: string;
  overallUsagePercent: number | null;
  overallResetTime: string | null;
  isExhausted: boolean;
  isRateLimited: boolean;
  needsAuthentication: boolean;
  formattedText: string;
}
```

When a provider fails, `fetchUsage` resolves with the `error` field set instead of throwing, so a single broken provider never breaks the whole batch.

### Custom configuration

Every provider accepts overrides, which is useful for non standard credential locations, custom OAuth clients, or passing a key directly:

```typescript
import { LimitsClient } from "@lenadweb/ai-limits";

const client = new LimitsClient({
  antigravity: {
    tokenPath: "/custom/path/antigravity_oauth.json",
    clientId: process.env.ANTIGRAVITY_CLIENT_ID,
    clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET,
  },
  claude: {
    credentialsPath: "/custom/path/.credentials.json",
    useKeychain: false,
  },
  chatgpt: {
    authPath: "/custom/path/auth.json",
  },
  gemini: {
    credentialsPath: "/custom/path/oauth_creds.json",
    projectId: "your-gcp-project",
  },
  minimax: {
    apiKey: process.env.MINIMAX_API_KEY,
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
  },
});
```

## How it reads credentials

This tool never asks for your passwords and never sends your tokens anywhere except to the matching provider's official API.

- Claude: reads the token from the macOS Keychain entry `Claude Code-credentials`, or from `~/.claude/.credentials.json`. Set `useKeychain: false` to force the file.
- ChatGPT / Codex: reads the access token and account id from `~/.codex/auth.json`.
- Gemini: reads Google OAuth credentials from `~/.gemini/oauth_creds.json`.
- Antigravity: runs a local OAuth flow and caches tokens in `~/.limits-streamdeck/antigravity_oauth.json`. Tokens are refreshed automatically.
- MiniMax: uses the `MINIMAX_API_KEY` environment variable, or the `apiKey` option.
- OpenRouter: uses the `OPENROUTER_API_KEY` environment variable, or the `apiKey` option. Calls `GET /api/v1/key` to read the key's spend limit and usage.

For Gemini and Antigravity the package uses the same public OAuth client identifiers that the official Google CLIs ship with. These are public desktop clients protected by PKCE, not private secrets. You can swap in your own client through the configuration options above.

## Development

```bash
npm install
npm run build      # bundle with tsup
npm run dev        # rebuild on change
```

## License

MIT
