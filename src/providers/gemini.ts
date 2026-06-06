import { OAuth2Client } from "google-auth-library";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { BaseProvider } from "@/providers/base.js";
import { StandardUsageResult, ModelUsage, ProviderName, ProviderErrorCode, GeminiRawResponse, UsageSummary } from "@/types.js";
import { buildSummary } from "@/utils.js";

const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal";
const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";

export type QuotaBucket = {
  resetTime: string;
  tokenType: string;
  modelId: string;
  remainingFraction: number;
  remainingAmount?: string;
};

export type QuotaResponse = {
  buckets?: QuotaBucket[];
};

interface LoadCodeAssistResponse {
  currentTier?: { id?: string; name?: string } | null;
  allowedTiers?: Array<{ id?: string; name?: string; isDefault?: boolean }> | null;
  cloudaicompanionProject?: string | null;
}

export class GeminiProvider extends BaseProvider {
  readonly name = ProviderName.Gemini;
  private client: OAuth2Client;
  private credentialsPath: string;
  private projectId: string | null = null;
  private clientId: string | undefined;
  private clientSecret: string | undefined;
  private isInitialized = false;
  private lastFetch: number = 0;
  private cache: StandardUsageResult | null = null;
  private readonly CACHE_TTL_MS = 60000;

  constructor(options?: { credentialsPath?: string; projectId?: string; clientId?: string; clientSecret?: string }) {
    super();
    this.credentialsPath = options?.credentialsPath || path.join(os.homedir(), ".gemini", "oauth_creds.json");
    this.projectId = options?.projectId || null;
    this.clientId = options?.clientId || process.env.GEMINI_CLIENT_ID || OAUTH_CLIENT_ID;
    this.clientSecret = options?.clientSecret || process.env.GEMINI_CLIENT_SECRET || OAUTH_CLIENT_SECRET;
    this.client = new OAuth2Client({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
  }

  async fetchUsage(): Promise<StandardUsageResult> {
    const now = Date.now();
    if (this.cache && (now - this.lastFetch) < this.CACHE_TTL_MS) {
      this.debug("Returning cached usage");
      return this.cache;
    }

    try {
      this.debug("Fetching usage from Gemini Code Assist API");
      await this.initialize();
      const projId = await this.resolveProjectId();
      this.debug(`Resolved project ${projId}`);
      const data = await this.apiPost<QuotaResponse>("retrieveUserQuota", {
        project: projId,
      });

      const perModel: Record<string, ModelUsage> = {};

      if (!data.buckets || data.buckets.length === 0) {
        const result: StandardUsageResult = {
          provider: this.name,
          overallUsagePercent: 0,
          overallResetTime: null,
          perModel,
        };
        this.cache = result;
        this.lastFetch = now;
        return result;
      }

      for (const bucket of data.buckets) {
        if (!bucket.modelId || bucket.remainingFraction == null) continue;
        if (bucket.modelId.endsWith("_vertex")) continue;

        const usage = Math.round((1 - bucket.remainingFraction) * 100);
        let remaining = 0;
        let limit = 0;

        if (bucket.remainingAmount) {
          remaining = parseInt(bucket.remainingAmount, 10);
          limit = bucket.remainingFraction > 0 ? Math.round(remaining / bucket.remainingFraction) : 0;
        }

        perModel[bucket.modelId] = {
          usagePercent: usage,
          remainingAmount: remaining || undefined,
          limitAmount: limit || undefined,
          resetTime: bucket.resetTime || null,
          displayName: bucket.modelId,
        };
      }

      const lowestFraction = Math.min(...data.buckets.map((b) => b.remainingFraction ?? 1));
      const overallUsagePercent = Math.min(Math.max(Math.round((1 - lowestFraction) * 100), 0), 100);

      const mostConstrained = data.buckets.reduce((prev, curr) =>
        (curr.remainingFraction ?? 1) < (prev.remainingFraction ?? 1) ? curr : prev
      );
      const overallResetTime = mostConstrained.resetTime || null;

      const result: StandardUsageResult = {
        provider: this.name,
        overallUsagePercent,
        overallResetTime,
        perModel,
      };

      this.cache = result;
      this.lastFetch = now;
      this.debug(`Usage fetched: ${overallUsagePercent}% used`);
      return result;
    } catch (err: any) {
      const msg = String(err?.message || err);
      this.logger.error(`[${this.name}] Fetch failed: ${msg}`);
      let code: ProviderErrorCode = "API";
      let message = "API Error";
      if (msg.includes("credentials") || msg.includes("ENOENT") || msg.includes("token") || msg.includes("401") || msg.includes("403")) {
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

  async fetchRawUsage(): Promise<GeminiRawResponse> {
    await this.initialize();
    const projId = await this.resolveProjectId();
    return await this.apiPost<GeminiRawResponse>("retrieveUserQuota", {
      project: projId,
    });
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

  private async initialize() {
    if (this.isInitialized) return;
    const credsStr = await fs.readFile(this.credentialsPath, "utf-8");
    const creds = JSON.parse(credsStr);
    this.client.setCredentials(creds);
    this.isInitialized = true;
  }

  private async reloadCredentials(): Promise<void> {
    this.isInitialized = false;
    await this.initialize();
  }

  private async getToken(): Promise<string> {
    const { token } = await this.client.getAccessToken();
    if (!token) {
      throw new Error("Failed to obtain access token");
    }
    const creds = this.client.credentials;
    if (creds.access_token) {
      await fs.writeFile(this.credentialsPath, JSON.stringify(creds, null, 2));
    }
    return token;
  }

  private async apiPost<T>(method: string, body: object): Promise<T> {
    const token = await this.getToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`${CODE_ASSIST_ENDPOINT}:${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 401) {
        await this.reloadCredentials();
        const newToken = await this.getToken();
        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => retryController.abort(), 10000);

        const retry = await fetch(`${CODE_ASSIST_ENDPOINT}:${method}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${newToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: retryController.signal,
        });

        clearTimeout(retryTimeout);

        if (!retry.ok) {
          throw new Error(`Google API ${method} returned ${retry.status}`);
        }
        return (await retry.json()) as T;
      }

      if (!response.ok) {
        throw new Error(`Google API ${method} returned ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  private async resolveProjectId(): Promise<string> {
    if (this.projectId) {
      return this.projectId;
    }

    const envProject = process.env["GOOGLE_CLOUD_PROJECT"] || process.env["GOOGLE_CLOUD_PROJECT_ID"];
    if (envProject) {
      this.projectId = envProject;
      return envProject;
    }

    const res = await this.apiPost<LoadCodeAssistResponse>("loadCodeAssist", {
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    });

    if (res.cloudaicompanionProject) {
      this.projectId = res.cloudaicompanionProject;
      return res.cloudaicompanionProject;
    }

    throw new Error("Could not resolve project ID");
  }
}
