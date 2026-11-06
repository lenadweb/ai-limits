import { BaseProvider } from "@/providers/base.js";
import {
  ModelUsage,
  OpenCodeBillingStatus,
  OpenCodeBudget,
  OpenCodeBudgetModel,
  OpenCodeGoMeter,
  OpenCodeGoRawResponse,
  OpenCodeOptions,
  OpenCodeRawResponse,
  ProviderErrorCode,
  ProviderName,
  StandardUsageResult,
} from "@/types.js";

const GO_USAGE_ENDPOINT = "https://opencode.ai/zen/go/v1/usage";
const BUDGETS_ENDPOINT = "https://opencode.ai/console/api/policies/current-budgets";
const BILLING_STATUS_ENDPOINT = "https://opencode.ai/console/api/billing/status";
const REQUEST_TIMEOUT_MS = 5000;
const MICROCENTS_PER_DOLLAR = 1_000_000;

const GO_WINDOWS: ReadonlyArray<{
  key: string;
  field: "rolling" | "weekly" | "monthly";
  label: string;
  seconds: number;
}> = [
  { key: "go_rolling", field: "rolling", label: "5-Hour Quota", seconds: 5 * 60 * 60 },
  { key: "go_weekly", field: "weekly", label: "Weekly Quota", seconds: 7 * 24 * 60 * 60 },
  { key: "go_monthly", field: "monthly", label: "Monthly Quota", seconds: 30 * 24 * 60 * 60 },
];

type RequestOutcome<T> =
  | { status: "ok"; data: T }
  | { status: "error"; code: number | null; message: string };

interface OpenCodeFailure {
  endpoint: "go" | "budgets";
  code: number | null;
  message: string;
}

interface OpenCodeData {
  go: OpenCodeGoRawResponse | null;
  budgets: OpenCodeBudget[] | null;
  billing: OpenCodeBillingStatus | null;
  failures: OpenCodeFailure[];
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function microCentsToDollars(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null;
  if (parsed === null || !Number.isFinite(parsed)) return null;
  return parsed / MICROCENTS_PER_DOLLAR;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  const absolute = Math.abs(value);
  const formatted = absolute.toFixed(2).replace(/\.?0+$/, "") || "0";
  return `${value < 0 ? "-" : ""}$${formatted}`;
}

function resetTime(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sanitizeKey(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "item";
}

function uniqueKey(perModel: Record<string, ModelUsage>, base: string): string {
  if (!perModel[base]) return base;
  let suffix = 2;
  while (perModel[`${base}_${suffix}`]) suffix += 1;
  return `${base}_${suffix}`;
}

function meterPercent(meter: OpenCodeGoMeter): number | null {
  if (meter.status === "rate-limited") return 100;
  const percent = numberOrNull(meter.percent);
  return percent === null ? null : clampPercent(Math.round(percent));
}

function budgetUsage(
  limit: number,
  spent: number,
  displayName: string,
  resetsAt: string | null
): ModelUsage {
  // A $0 budget blocks all spend, so it is treated as fully used rather than as 0%.
  const usagePercent = limit > 0 ? clampPercent(Math.round((spent / limit) * 100)) : 100;
  return {
    usagePercent,
    remainingAmount: Math.max(0, limit - spent),
    limitAmount: limit,
    resetTime: resetsAt,
    displayName,
  };
}

function budgetLabel(limit: number, shared: boolean, coverage: string | undefined): string {
  if (coverage === "all") {
    return `${shared ? "Workspace Budget" : "Budget"} (${formatUsd(limit)})`;
  }
  return `${shared ? "Shared " : ""}Budget (${formatUsd(limit)})`;
}

function modelBudgetLabel(model: OpenCodeBudgetModel, limit: number, shared: boolean): string {
  const name = model.name || model.modelID || "Model";
  return `${shared ? "Shared " : ""}${name} Budget (${formatUsd(limit)})`;
}

/**
 * Normalizes the two OpenCode Console responses into the common usage shape.
 *
 * Go subscriptions (Go, Go Plus, Go Teams) report rolling, weekly and monthly
 * percentages. Zen / pay-as-you-go workspaces report dollar budgets instead,
 * and may also expose a prepaid balance.
 */
export function mapOpenCodeUsage(
  raw: Pick<OpenCodeRawResponse, "go" | "budgets" | "billing">,
  debug: (message: string) => void = () => {}
): StandardUsageResult {
  const perModel: Record<string, ModelUsage> = {};

  for (const window of GO_WINDOWS) {
    const meter = raw.go?.usage?.[window.field];
    if (!meter) continue;
    const usagePercent = meterPercent(meter);
    if (usagePercent === null) {
      debug(`Ignoring Go ${window.field} window without a percent`);
      continue;
    }
    perModel[window.key] = {
      usagePercent,
      resetTime: resetTime(meter.resetsAt),
      displayName: window.label,
      windowSeconds: window.seconds,
    };
  }

  const budgets = raw.budgets ?? [];
  budgets.forEach((budget, index) => {
    const limit = numberOrNull(budget.limitDollars);
    if (limit === null) {
      debug(`Ignoring budget ${budget.ruleID || index} without a dollar limit`);
      return;
    }

    const shared = budget.shared === true || budget.scope === "combined";
    const resetsAt = resetTime(budget.resetsAt);
    const ruleID = sanitizeKey(budget.ruleID || `budget_${index}`);
    const models = Array.isArray(budget.models) ? budget.models : [];

    if (budget.per === "model" && models.length > 0) {
      models.forEach((model, modelIndex) => {
        const spent = numberOrNull(model.spentDollars) ?? 0;
        const modelID = sanitizeKey(model.modelID || model.providerID || `model_${modelIndex}`);
        const key = uniqueKey(perModel, `budget_${ruleID}_${modelID}`);
        perModel[key] = budgetUsage(limit, spent, modelBudgetLabel(model, limit, shared), resetsAt);
      });
      return;
    }

    const spent = numberOrNull(budget.spentDollars) ?? 0;
    const key = uniqueKey(perModel, `budget_${ruleID}`);
    perModel[key] = budgetUsage(limit, spent, budgetLabel(limit, shared, budget.coverage), resetsAt);
  });

  const balance = microCentsToDollars(raw.billing?.balanceMicroCents);
  if (balance !== null) {
    perModel.zen_balance = {
      usagePercent: null,
      resetTime: null,
      displayName: `Zen balance: ${formatUsd(balance)}`,
    };
  }

  let worst: ModelUsage | null = null;
  for (const usage of Object.values(perModel)) {
    if (usage.usagePercent === null) continue;
    if (worst === null || usage.usagePercent > (worst.usagePercent ?? -1)) {
      worst = usage;
    }
  }

  return {
    provider: ProviderName.OpenCode,
    overallUsagePercent: worst?.usagePercent ?? null,
    overallResetTime: worst?.resetTime ?? null,
    perModel,
  };
}

export class OpenCodeProvider extends BaseProvider {
  readonly name = ProviderName.OpenCode;
  private readonly apiKey: string | null;
  private readonly workspaceId: string | undefined;
  private billingStatus: OpenCodeBillingStatus | null = null;

  constructor(options?: OpenCodeOptions) {
    super(options);
    this.apiKey = options?.apiKey || process.env.OPENCODE_API_KEY || null;
    this.workspaceId = options?.workspaceId || process.env.OPENCODE_WORKSPACE_ID || undefined;
  }

  protected async loadUsage(): Promise<StandardUsageResult> {
    if (!this.apiKey) {
      this.debug("No API key configured, returning auth error");
      return this.errorResult("AUTH", "Auth Required");
    }

    try {
      const data = await this.loadData();
      this.billingStatus = data.billing;
      const result = mapOpenCodeUsage(
        { go: data.go, budgets: data.budgets, billing: data.billing },
        (message) => this.debug(message)
      );

      if (Object.keys(result.perModel ?? {}).length > 0) {
        for (const failure of data.failures) {
          this.debug(`${failure.endpoint} request failed: ${failure.message}`);
        }
        this.debug(`Usage fetched: ${result.overallUsagePercent ?? "n/a"}% used`);
        return result;
      }

      return this.errorResultFromFailures(data.failures);
    } catch (err: any) {
      this.logger.error(`[${this.name}] Connection error: ${err?.message || err}`);
      return this.errorResult("CONN", "Conn Error");
    }
  }

  async fetchRawUsage(): Promise<OpenCodeRawResponse> {
    if (!this.apiKey) {
      throw new Error("Authentication credentials missing");
    }

    const data = await this.loadData();
    const hasBudgets = Array.isArray(data.budgets) && data.budgets.length > 0;
    if (!data.go && !hasBudgets && !data.billing) {
      const failure = data.failures[0];
      if (failure) {
        throw new Error(
          failure.code
            ? `OpenCode API returned status ${failure.code}: ${failure.message}`
            : `OpenCode API request failed: ${failure.message}`
        );
      }
      throw new Error("No OpenCode usage data returned");
    }

    return {
      go: data.go,
      budgets: data.budgets,
      billing: data.billing,
    };
  }

  /** Usage of the OpenCode Go rolling 5-hour window. */
  getRollingUsage(): Promise<ModelUsage | null> {
    return this.bucket("go_rolling");
  }

  /** Usage of the OpenCode Go weekly window. */
  getWeeklyUsage(): Promise<ModelUsage | null> {
    return this.bucket("go_weekly");
  }

  /** Usage of the OpenCode Go monthly window. */
  getMonthlyUsage(): Promise<ModelUsage | null> {
    return this.bucket("go_monthly");
  }

  /** Every Console budget bucket, both whole-workspace and per-model. */
  async getBudgets(): Promise<ModelUsage[]> {
    const usage = await this.fetchUsage();
    return Object.entries(usage.perModel ?? {})
      .filter(([key]) => key.startsWith("budget_"))
      .map(([, value]) => value);
  }

  /** Budget buckets belonging to one Console budget rule. */
  async getBudgetUsage(ruleID: string): Promise<ModelUsage[]> {
    const prefix = `budget_${sanitizeKey(ruleID)}`;
    const usage = await this.fetchUsage();
    return Object.entries(usage.perModel ?? {})
      .filter(([key]) => key === prefix || key.startsWith(`${prefix}_`))
      .map(([, value]) => value);
  }

  /** Remaining Zen prepaid balance in dollars, or `null` when billing is unavailable. */
  async getBalance(): Promise<number | null> {
    await this.fetchUsage();
    return microCentsToDollars(this.billingStatus?.balanceMicroCents);
  }

  protected onClearCache(): void {
    this.billingStatus = null;
  }

  private async loadData(): Promise<OpenCodeData> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      return { go: null, budgets: null, billing: null, failures: [] };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    const goHeaders = { ...headers };
    const budgetHeaders = { ...headers };
    if (this.workspaceId) {
      goHeaders["x-opencode-org-id"] = this.workspaceId;
      budgetHeaders["x-org-id"] = this.workspaceId;
    }

    const [goOutcome, budgetOutcome, billingOutcome] = await Promise.all([
      this.request<OpenCodeGoRawResponse>(GO_USAGE_ENDPOINT, goHeaders),
      this.request<OpenCodeBudget[]>(BUDGETS_ENDPOINT, budgetHeaders),
      this.request<OpenCodeBillingStatus>(BILLING_STATUS_ENDPOINT, headers),
    ]);

    const failures: OpenCodeFailure[] = [];
    const billing =
      billingOutcome.status === "ok"
        ? billingOutcome.data
        : (() => {
            if (billingOutcome.status === "error" && billingOutcome.code !== 401 && billingOutcome.code !== 403) {
              this.debug(`Billing status unavailable: ${billingOutcome.message}`);
            }
            return null;
          })();

    return {
      go: this.accept(goOutcome, "go", failures),
      budgets: this.accept(budgetOutcome, "budgets", failures),
      billing,
      failures,
    };
  }

  private accept<T>(
    outcome: RequestOutcome<T>,
    endpoint: "go" | "budgets",
    failures: OpenCodeFailure[]
  ): T | null {
    if (outcome.status === "ok") return outcome.data;
    // 403 means the workspace has no such subscription (no Go plan, no budgets).
    if (outcome.code !== 403) {
      failures.push({ endpoint, code: outcome.code, message: outcome.message });
    }
    return null;
  }

  private async request<T>(url: string, headers: Record<string, string>): Promise<RequestOutcome<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      const text = await response.text();

      if (!response.ok) {
        return {
          status: "error",
          code: response.status,
          message: extractErrorMessage(text, response.status),
        };
      }

      try {
        return { status: "ok", data: JSON.parse(text) as T };
      } catch {
        return { status: "error", code: response.status, message: "Invalid JSON response" };
      }
    } catch (err: any) {
      return { status: "error", code: null, message: err?.message || String(err) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private errorResultFromFailures(failures: OpenCodeFailure[]): StandardUsageResult {
    const auth = failures.find((failure) => failure.code === 401);
    if (auth) return this.errorResult("AUTH", "Auth Required");

    const rateLimit = failures.find((failure) => failure.code === 429);
    if (rateLimit) return this.errorResult(429, "Rate Limit");

    const connection = failures.find((failure) => failure.code === null);
    if (connection) {
      this.logger.error(`[${this.name}] Connection error: ${connection.message}`);
      return this.errorResult("CONN", "Conn Error");
    }

    const failure = failures[0];
    if (failure) {
      this.logger.error(
        `[${this.name}] ${failure.endpoint} request failed with status ${failure.code}: ${failure.message}`
      );
      return this.errorResult(failure.code ?? "API", `Error ${failure.code}`);
    }

    return this.errorResult("API", "No subscription data");
  }

  private errorResult(code: ProviderErrorCode, message: string): StandardUsageResult {
    return {
      provider: this.name,
      overallUsagePercent: null,
      overallResetTime: null,
      error: { code, message },
    };
  }
}

function extractErrorMessage(text: string, status: number): string {
  const trimmed = text.trim();
  if (!trimmed) return `HTTP ${status}`;

  try {
    const body = JSON.parse(trimmed) as any;
    const message =
      body?.error?.message ??
      body?.message ??
      (typeof body?.error === "string" ? body.error : undefined) ??
      body?._tag;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // Fall through to the raw body.
  }

  return trimmed.slice(0, 200);
}
