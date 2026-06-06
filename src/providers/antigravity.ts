import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { exec } from "child_process";
import * as http from "http";
import { AddressInfo } from "net";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { BaseProvider } from "@/providers/base.js";
import { StandardUsageResult, ModelUsage, ProviderName, ProviderErrorCode, AntigravityRawResponse, UsageSummary } from "@/types.js";
import { buildSummary } from "@/utils.js";

const CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
];

interface StoredToken {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  id_token?: string;
  scope?: string;
  email?: string;
}

interface ModelInfo {
  displayName?: string;
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
    isExhausted?: boolean;
  };
  [key: string]: any;
}

interface FetchAvailableModelsResponse {
  models?: Record<string, ModelInfo>;
}

interface RetrieveUserQuotaBucket {
  modelId?: string;
  remainingFraction?: number;
  resetTime?: string;
  [key: string]: any;
}

interface RetrieveUserQuotaResponse {
  buckets?: RetrieveUserQuotaBucket[];
}

export class AntigravityProvider extends BaseProvider {
  readonly name = ProviderName.Antigravity;
  private client: OAuth2Client;
  private tokenPath: string;
  private clientId: string | undefined;
  private clientSecret: string | undefined;
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

  constructor(options?: { tokenPath?: string; clientId?: string; clientSecret?: string }) {
    super();
    this.tokenPath = options?.tokenPath || path.join(os.homedir(), ".limits-streamdeck", "antigravity_oauth.json");
    this.clientId = options?.clientId || process.env.ANTIGRAVITY_CLIENT_ID || OAUTH_CLIENT_ID;
    this.clientSecret = options?.clientSecret || process.env.ANTIGRAVITY_CLIENT_SECRET || OAUTH_CLIENT_SECRET;
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

  async fetchUsage(): Promise<StandardUsageResult> {
    this.debug("Fetching usage from Antigravity API");
    try {
      await this.initialize();
    } catch (err: any) {
      this.logger.error(`[${this.name}] Initialization failed: ${err?.message || err}`);
      return {
        provider: this.name,
        overallUsagePercent: null,
        overallResetTime: null,
        error: { code: "AUTH", message: "Auth Required" },
      };
    }

    const perModel: Record<string, ModelUsage> = {};
    const fractions: number[] = [];
    let overallResetTime: string | null = null;

    try {
      const quota = await this.apiPost<RetrieveUserQuotaResponse>("retrieveUserQuota", {});
      const modelLabels = await this.fetchModelDisplayNames();

      for (const bucket of quota.buckets || []) {
        const modelId = bucket.modelId;
        const remainingFraction = bucket.remainingFraction;
        if (!modelId || typeof remainingFraction !== "number") continue;

        const usage = Math.min(Math.max(Math.round((1 - remainingFraction) * 100), 0), 100);
        perModel[modelId] = {
          usagePercent: usage,
          resetTime: bucket.resetTime || null,
          displayName: modelLabels[modelId] ?? modelId,
        };
        fractions.push(remainingFraction);
      }

      if (fractions.length > 0) {
        let mostConstrainedFraction = Infinity;
        for (const bucket of quota.buckets || []) {
          const f = bucket.remainingFraction;
          if (typeof f !== "number") continue;
          if (f < mostConstrainedFraction) {
            mostConstrainedFraction = f;
            overallResetTime = bucket.resetTime ?? null;
          }
        }
      }
    } catch (err: any) {
      this.debug(`retrieveUserQuota failed (${err?.message || err}), falling back to fetchAvailableModels`);
      try {
        const data = await this.apiPost<FetchAvailableModelsResponse>("fetchAvailableModels", {});
        for (const [modelId, info] of Object.entries(data.models || {})) {
          const qi = info.quotaInfo;
          if (!qi || typeof qi.remainingFraction !== "number") continue;

          const usage = Math.min(Math.max(Math.round((1 - qi.remainingFraction) * 100), 0), 100);
          perModel[modelId] = {
            usagePercent: usage,
            resetTime: qi.resetTime || null,
            displayName: info.displayName ?? modelId,
          };
          fractions.push(qi.remainingFraction);
        }

        if (fractions.length > 0) {
          let mostConstrainedFraction = Infinity;
          for (const info of Object.values(data.models || {})) {
            const f = info.quotaInfo?.remainingFraction;
            if (typeof f !== "number") continue;
            if (f < mostConstrainedFraction) {
              mostConstrainedFraction = f;
              overallResetTime = info.quotaInfo?.resetTime ?? null;
            }
          }
        }
      } catch (fallbackErr: any) {
        const msg = String(fallbackErr?.message || fallbackErr);
        this.logger.error(`[${this.name}] Fetch failed: ${msg}`);
        let code: ProviderErrorCode = "API";
        let message = "API Error";
        if (msg.includes("401") || msg.includes("403") || msg.includes("token")) {
          code = "AUTH";
          message = "Auth Required";
        } else if (msg.includes("429")) {
          code = 429;
          message = "Rate Limit";
        } else if (msg.includes("fetch") || msg.includes("CONN") || msg.includes("Network")) {
          code = "CONN";
          message = "Conn Error";
        }
        return {
          provider: this.name,
          overallUsagePercent: null,
          overallResetTime: null,
          error: { code, message },
        };
      }
    }

    let overallUsagePercent = null;
    if (fractions.length > 0) {
      const lowest = Math.min(...fractions);
      overallUsagePercent = Math.min(Math.max(Math.round((1 - lowest) * 100), 0), 100);
    }

    this.debug(`Usage fetched: ${overallUsagePercent ?? "n/a"}% used`);
    return {
      provider: this.name,
      overallUsagePercent,
      overallResetTime,
      perModel,
    };
  }

  async fetchRawUsage(): Promise<AntigravityRawResponse> {
    await this.initialize();
    try {
      const buckets = await this.apiPost<RetrieveUserQuotaResponse>("retrieveUserQuota", {});
      const models = await this.apiPost<FetchAvailableModelsResponse>("fetchAvailableModels", {});
      return {
        buckets: buckets.buckets,
        models: models.models,
      };
    } catch {
      const models = await this.apiPost<FetchAvailableModelsResponse>("fetchAvailableModels", {});
      return {
        models: models.models,
      };
    }
  }

  async fetchSummary(): Promise<UsageSummary> {
    const usage = await this.fetchUsage();
    return buildSummary(usage);
  }

  /** Usage of a specific model bucket, or `null` if the model is not reported. */
  getModelUsage(modelId: string): Promise<ModelUsage | null> {
    return this.bucket(modelId);
  }

  /** Model ids reported in the latest usage snapshot. */
  getModels(): Promise<string[]> {
    return this.listBuckets();
  }

  private async fetchModelDisplayNames(): Promise<Record<string, string>> {
    const labels: Record<string, string> = {};
    try {
      const data = await this.apiPost<FetchAvailableModelsResponse>("fetchAvailableModels", {});
      for (const [id, info] of Object.entries(data.models || {})) {
        labels[id] = info.displayName || id;
      }
    } catch {
    }
    return labels;
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

  private async apiPost<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${CODE_ASSIST_ENDPOINT}:${method}`;

    const send = async (bearer: string): Promise<Response> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        return await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    };

    let response = await send(token);

    if (response.status === 401 || response.status === 403) {
      this.isInitialized = false;
      await this.initialize();
      const newToken = await this.getAccessToken();
      response = await send(newToken);
    }

    if (!response.ok) {
      throw new Error(`Antigravity API ${method} returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async getAccessToken(): Promise<string> {
    const { token } = await this.client.getAccessToken();
    if (!token) {
      throw new Error("Failed to obtain access token");
    }
    const creds = this.client.credentials;
    if (creds.access_token) {
      await this.persistTokens(creds, this.email);
    }
    return token;
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
