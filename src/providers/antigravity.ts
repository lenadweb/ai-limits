import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { exec, execFile } from "child_process";
import * as http from "http";
import { AddressInfo } from "net";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { promisify } from "util";
import { BaseProvider } from "@/providers/base.js";
import { StandardUsageResult, ModelUsage, ProviderName, ProviderError, AntigravityOptions, AntigravityRawResponse } from "@/types.js";

const execFileAsync = promisify(execFile);

const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
];

const AGY_BINARY = os.platform() === "win32" ? "agy.exe" : "agy";
const AGY_USAGE_ARGS = ["--print", "/usage", "--print-timeout", "20s", "--output-format", "json"];
const AGY_TIMEOUT_MS = 30000;

const WINDOW_SECONDS: Record<string, number> = {
  weekly: 7 * 24 * 60 * 60,
};

type AgyFailure = "missing" | "timeout" | "failed";

type AgyResult =
  | { data: AntigravityRawResponse }
  | { error: AgyFailure; detail: string };

const AGY_ERRORS: Record<AgyFailure, ProviderError> = {
  missing: { code: "AUTH", message: "agy Not Found" },
  timeout: { code: "CONN", message: "Timeout" },
  failed: { code: "API", message: "API Error" },
};

interface StoredToken {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  id_token?: string;
  scope?: string;
  email?: string;
}

function parseAgyOutput(stdout: string): AgyResult {
  let output: any;
  try {
    output = JSON.parse(stdout);
  } catch {
    return { error: "failed", detail: "agy returned non-JSON output" };
  }
  if (output?.status !== "SUCCESS") {
    return { error: "failed", detail: `agy returned status ${output?.status ?? "unknown"}` };
  }
  const data = output.command?.data;
  if (!data || !Array.isArray(data.groups)) {
    return { error: "failed", detail: "agy output has no usage groups" };
  }
  return { data };
}

export function mapAntigravityUsage(data: AntigravityRawResponse, debug: (message: string) => void = () => {}): StandardUsageResult {
  const perModel: Record<string, ModelUsage> = {};
  let worst: ModelUsage | null = null;

  for (const group of data.groups ?? []) {
    const groupName = group.name?.trim() || "Antigravity";
    for (const bucket of group.buckets ?? []) {
      if (!bucket.id || typeof bucket.remaining_fraction !== "number") {
        debug(`Ignoring bucket without id or remaining fraction in "${groupName}"`);
        continue;
      }
      if (perModel[bucket.id]) {
        debug(`Duplicate bucket "${bucket.id}", keeping the first one`);
        continue;
      }

      const windowSeconds = bucket.window ? WINDOW_SECONDS[bucket.window] : undefined;
      const limitName = bucket.name?.replace(/\s*remaining$/i, "").trim() || bucket.window || bucket.id;
      const usage: ModelUsage = {
        usagePercent: Math.min(Math.max(Math.round((1 - bucket.remaining_fraction) * 100), 0), 100),
        resetTime: bucket.reset_time ?? null,
        displayName: windowSeconds ? groupName : `${groupName} ${limitName}`,
        windowSeconds,
      };
      perModel[bucket.id] = usage;

      if (!worst || (usage.usagePercent ?? -1) > (worst.usagePercent ?? -1)) {
        worst = usage;
      }
    }
  }

  return {
    provider: ProviderName.Antigravity,
    overallUsagePercent: worst?.usagePercent ?? null,
    overallResetTime: worst?.resetTime ?? null,
    perModel,
  };
}

export class AntigravityProvider extends BaseProvider {
  readonly name = ProviderName.Antigravity;
  private client: OAuth2Client;
  private tokenPath: string;
  private clientId: string | undefined;
  private clientSecret: string | undefined;
  private binaryPath: string | undefined;
  private isInitialized = false;
  private email: string | null = null;
  private pendingLogin: {
    server: http.Server;
    codeVerifier: string;
    redirectUri: string;
    state: string;
    resolve: (email: string) => void;
    reject: (err: Error) => void;
  } | null = null;

  constructor(options?: AntigravityOptions) {
    super(options);
    this.tokenPath = options?.tokenPath || path.join(os.homedir(), ".limits-streamdeck", "antigravity_oauth.json");
    this.clientId = options?.clientId || process.env.ANTIGRAVITY_CLIENT_ID || OAUTH_CLIENT_ID;
    this.clientSecret = options?.clientSecret || process.env.ANTIGRAVITY_CLIENT_SECRET || OAUTH_CLIENT_SECRET;
    this.binaryPath = options?.binaryPath || process.env.AGY_BIN || undefined;
    this.client = new OAuth2Client({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
  }

  async isLoggedIn(): Promise<boolean> {
    try {
      await this.initialize();
      return this.isInitialized;
    } catch {
      return false;
    }
  }

  getLoggedInEmail(): string | null {
    return this.email;
  }

  async logout(): Promise<void> {
    this.isInitialized = false;
    this.email = null;
    this.client = new OAuth2Client({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
    try {
      await fs.unlink(this.tokenPath);
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        throw err;
      }
    }
  }

  async login(): Promise<string> {
    if (this.pendingLogin) {
      throw new Error("Login already in progress");
    }

    return new Promise<string>((resolve, reject) => {
      const codeVerifier = this.generateCodeVerifier();
      const codeChallenge = this.generateCodeChallenge(codeVerifier);
      const state = crypto.randomBytes(16).toString("hex");

      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url || "/", "http://127.0.0.1");
          if (url.pathname !== "/callback") {
            res.writeHead(404);
            res.end("Not found");
            return;
          }

          const code = url.searchParams.get("code");
          const returnedState = url.searchParams.get("state");
          const errParam = url.searchParams.get("error");

          if (errParam) {
            this.respondHtml(res, false, `Login failed: ${errParam}`);
            this.finishLogin(new Error(`OAuth error: ${errParam}`));
            return;
          }

          if (!code) {
            this.respondHtml(res, false, "Missing authorization code");
            this.finishLogin(new Error("Missing authorization code"));
            return;
          }

          if (!this.pendingLogin || returnedState !== this.pendingLogin.state) {
            this.respondHtml(res, false, "State mismatch — please retry");
            this.finishLogin(new Error("State mismatch"));
            return;
          }

          const tokens = await this.exchangeCode(code, this.pendingLogin.codeVerifier, this.pendingLogin.redirectUri);
          this.client.setCredentials(tokens);
          const email = await this.fetchUserEmail();
          this.email = email;
          await this.persistTokens(tokens, email);
          this.isInitialized = true;

          this.respondHtml(res, true, "You can close this tab and return to CLI.");
          this.finishLogin(null, email);
        } catch (err: any) {
          this.respondHtml(res, false, `Login failed: ${err?.message || err}`);
          this.finishLogin(err instanceof Error ? err : new Error(String(err)));
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;

        this.pendingLogin = {
          server,
          codeVerifier,
          redirectUri,
          state,
          resolve,
          reject,
        };

        const authUrl = this.client.generateAuthUrl({
          access_type: "offline",
          prompt: "consent",
          scope: OAUTH_SCOPES,
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: CodeChallengeMethod.S256,
        });

        const startCommand = os.platform() === "darwin" ? "open" : os.platform() === "win32" ? "start" : "xdg-open";
        if (os.platform() === "win32") {
          exec(`cmd /c start "" "${authUrl}"`);
        } else {
          exec(`${startCommand} "${authUrl}"`);
        }

        setTimeout(() => {
          if (this.pendingLogin && this.pendingLogin.server === server) {
            this.finishLogin(new Error("Login timed out"));
          }
        }, 5 * 60 * 1000);
      });

      server.on("error", (err) => {
        this.finishLogin(err);
      });
    });
  }

  protected async loadUsage(): Promise<StandardUsageResult> {
    this.debug("Fetching usage from agy CLI");
    const result = await this.runAgy();
    if ("error" in result) {
      if (result.error === "missing") {
        this.debug(`${result.detail}, returning auth error`);
      } else {
        this.logger.error(`[${this.name}] Fetch failed: ${result.detail}`);
      }
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: AGY_ERRORS[result.error],
      };
    }

    const usage = mapAntigravityUsage(result.data, (message) => this.debug(message));
    this.debug(`Usage fetched: ${usage.overallUsagePercent ?? "n/a"}% used`);
    return usage;
  }

  async fetchRawUsage(): Promise<AntigravityRawResponse> {
    const result = await this.runAgy();
    if ("error" in result) {
      throw new Error(result.detail);
    }
    return result.data;
  }

  /** Usage of a quota bucket reported by `agy /usage` (e.g. `gemini-weekly`, `3p-weekly`), or `null` if absent. */
  getModelUsage(modelId: string): Promise<ModelUsage | null> {
    return this.bucket(modelId);
  }

  /** Bucket ids reported in the latest usage snapshot. */
  getModels(): Promise<string[]> {
    return this.listBuckets();
  }

  private agyCandidates(): string[] {
    if (this.binaryPath) return [this.binaryPath];
    return [AGY_BINARY, path.join(os.homedir(), ".local", "bin", AGY_BINARY)];
  }

  private async runAgy(): Promise<AgyResult> {
    for (const binary of this.agyCandidates()) {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(binary, AGY_USAGE_ARGS, { timeout: AGY_TIMEOUT_MS, windowsHide: true }));
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          this.debug(`agy not found at ${binary}`);
          continue;
        }
        if (err?.killed) {
          return { error: "timeout", detail: `agy timed out after ${AGY_TIMEOUT_MS}ms` };
        }
        const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
        return { error: "failed", detail: stderr || err?.message || String(err) };
      }
      return parseAgyOutput(stdout);
    }
    return { error: "missing", detail: "agy CLI not found" };
  }

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    const tokens = await this.loadTokens();
    if (!tokens) {
      throw new Error("No saved credentials");
    }
    this.client.setCredentials(tokens);
    this.email = tokens.email ?? null;
    this.isInitialized = true;
  }

  private async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<StoredToken> {
    const params = new URLSearchParams({
      code,
      client_id: this.clientId || "",
      client_secret: this.clientSecret || "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    });

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    const data = await response.json() as any;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expiry_date: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      token_type: data.token_type,
      id_token: data.id_token,
      scope: data.scope,
    };
  }

  private async fetchUserEmail(): Promise<string> {
    try {
      const { token } = await this.client.getAccessToken();
      const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return "";
      const data = await response.json() as any;
      return data.email || "";
    } catch {
      return "";
    }
  }

  private async loadTokens(): Promise<StoredToken | null> {
    try {
      const raw = await fs.readFile(this.tokenPath, "utf-8");
      return JSON.parse(raw) as StoredToken;
    } catch {
      return null;
    }
  }

  private async persistTokens(tokens: StoredToken | Record<string, any>, email: string | null): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
      const merged: StoredToken = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date,
        token_type: tokens.token_type,
        id_token: tokens.id_token,
        scope: tokens.scope,
        email: email || undefined,
      };
      await fs.writeFile(this.tokenPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    } catch {
    }
  }

  private finishLogin(err: Error | null, email?: string): void {
    if (!this.pendingLogin) return;
    const { server, resolve, reject } = this.pendingLogin;
    this.pendingLogin = null;
    try {
      server.close();
    } catch { }
    if (err) reject(err);
    else resolve(email || "");
  }

  private respondHtml(res: http.ServerResponse, ok: boolean, message: string): void {
    const color = ok ? "#10b981" : "#ef4444";
    const title = ok ? "Signed in" : "Sign-in error";
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f1115;color:#eee}
.card{padding:32px 40px;border-radius:12px;background:#1a1d24;border:1px solid #2a2f39;text-align:center;max-width:480px}
h1{margin:0 0 12px;color:${color};font-size:20px}p{margin:0;color:#9ca3af;font-size:14px;line-height:1.5}
</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString("base64url");
  }

  private generateCodeChallenge(verifier: string): string {
    return crypto.createHash("sha256").update(verifier).digest("base64url");
  }
}
