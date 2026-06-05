# ai-limits

An enterprise-grade CLI and TypeScript/JavaScript SDK to fetch and monitor usage limits and quotas across multiple AI coding assistants and agent providers.

Supports:
- **Antigravity (Cloud Code Code Assist)**
- **Claude (Anthropic API / Claude Code CLI)**
- **ChatGPT / Codex (ChatGPT Web API)**
- **Gemini (Google Cloud Code Assist)**
- **MiniMax (OpenPlatform Coding Plan API)**

## Installation

```bash
npm install -g ai-limits
```

Or install locally in your project:

```bash
npm install ai-limits
```

## CLI Usage

Verify and display current limits from any terminal.

### Show Quotas

```bash
# Query all providers
ai-limits show

# Query a specific provider
ai-limits show gemini
ai-limits show claude
ai-limits show chatgpt
ai-limits show minimax
ai-limits show antigravity
```

### Authentication for Antigravity

Antigravity requires OAuth2 authentication. You can authenticate directly via the CLI:

```bash
# Start OAuth flow
ai-limits login antigravity

# Remove credentials
ai-limits logout antigravity
```

## Programmatic Library Usage

```typescript
import { LimitsClient } from "ai-limits";

const client = new LimitsClient();

// Fetch usage for all configured providers
const allLimits = await client.fetchAllUsage();
console.log(allLimits);

// Fetch usage for a single provider
const claudeUsage = await client.fetchUsage("claude");
console.log(claudeUsage);
```

### Custom Client Configurations

```typescript
import { LimitsClient } from "ai-limits";

const client = new LimitsClient({
  antigravity: {
    tokenPath: "/custom/path/to/antigravity_oauth.json"
  },
  claude: {
    credentialsPath: "/custom/path/to/.credentials.json",
    useKeychain: false
  },
  chatgpt: {
    authPath: "/custom/path/to/auth.json"
  },
  gemini: {
    credentialsPath: "/custom/path/to/oauth_creds.json"
  },
  minimax: {
    apiKey: "your-minimax-api-key"
  }
});
```

## Provider Credentials Setup

### Antigravity
The CLI initiates OAuth via Google and saves the tokens to `~/.limits-streamdeck/antigravity_oauth.json`.

### Claude
Reads the token automatically from the macOS Keychain (`Claude Code-credentials`) or the credentials file `~/.claude/.credentials.json` created by the Claude Code CLI.

### ChatGPT / Codex
Reads the access token and account ID from `~/.codex/auth.json` (as created by standard Codex extensions).

### Gemini
Reads Google OAuth credentials from `~/.gemini/oauth_creds.json` (created by Gemini CLI plugins).

### MiniMax
Configure via the `MINIMAX_API_KEY` environment variable or pass the `apiKey` directly to the client constructor.

## License

MIT
