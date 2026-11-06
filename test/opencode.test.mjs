import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOpenCodeUsage, OpenCodeProvider, ProviderName } from "../dist/index.js";

const silent = { log() {}, error() {} };

function provider(options = {}) {
  return new OpenCodeProvider({ cacheTtlMs: 0, ...options }).setLogger(silent);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function withoutApiKey(fn) {
  const original = process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = original;
  }
}

test("mapOpenCodeUsage maps the Go rolling, weekly and monthly windows", () => {
  const result = mapOpenCodeUsage({
    go: {
      usage: {
        rolling: { status: "ok", percent: 17, resetsAt: "2026-11-06T18:00:00.000Z" },
        weekly: { status: "ok", percent: 75, resetsAt: "2026-11-11T00:00:00.000Z" },
        monthly: { status: "rate-limited", percent: 91, resetsAt: "2026-12-01T00:00:00.000Z" },
      },
    },
    budgets: null,
    billing: null,
  });

  assert.equal(result.provider, ProviderName.OpenCode);
  assert.equal(result.overallUsagePercent, 100);
  assert.equal(result.overallResetTime, "2026-12-01T00:00:00.000Z");
  assert.deepEqual(result.perModel.go_rolling, {
    usagePercent: 17,
    resetTime: "2026-11-06T18:00:00.000Z",
    displayName: "5-Hour Quota",
    windowSeconds: 18000,
  });
  assert.equal(result.perModel.go_weekly.usagePercent, 75);
  assert.equal(result.perModel.go_weekly.windowSeconds, 604800);
  assert.equal(result.perModel.go_monthly.usagePercent, 100);
  assert.equal(result.perModel.go_monthly.windowSeconds, 2592000);
});

test("mapOpenCodeUsage maps whole-budget and per-model Console budgets", () => {
  const result = mapOpenCodeUsage({
    go: null,
    budgets: [
      {
        ruleID: "rule_models",
        limitDollars: 20,
        spentDollars: 15,
        scope: "each",
        per: "model",
        coverage: "models",
        models: [
          { providerID: "opencode", modelID: "gpt-6-astra", name: "GPT-6 Astra", spentDollars: 15 },
          { providerID: "opencode", modelID: "glm-5", name: "GLM-5", spentDollars: 5 },
        ],
        shared: false,
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
      {
        ruleID: "rule_workspace",
        limitDollars: 0,
        spentDollars: 0,
        scope: "combined",
        per: "set",
        coverage: "all",
        shared: true,
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
    ],
    billing: null,
  });

  assert.equal(result.overallUsagePercent, 100);
  assert.deepEqual(result.perModel["budget_rule_models_gpt-6-astra"], {
    usagePercent: 75,
    remainingAmount: 5,
    limitAmount: 20,
    resetTime: "2026-12-01T00:00:00.000Z",
    displayName: "GPT-6 Astra Budget ($20)",
  });
  assert.equal(result.perModel["budget_rule_models_glm-5"].usagePercent, 25);
  assert.equal(result.perModel["budget_rule_models_glm-5"].remainingAmount, 15);
  assert.equal(result.perModel.budget_rule_workspace.usagePercent, 100);
  assert.equal(result.perModel.budget_rule_workspace.displayName, "Workspace Budget ($0)");
});

test("mapOpenCodeUsage reports a Zen balance without inventing an overall percent", () => {
  const result = mapOpenCodeUsage({
    go: null,
    budgets: [],
    billing: { balanceMicroCents: 12_500_000, billingMode: "prepaid" },
  });

  assert.equal(result.overallUsagePercent, null);
  assert.equal(result.overallResetTime, null);
  assert.deepEqual(result.perModel.zen_balance, {
    usagePercent: null,
    resetTime: null,
    displayName: "Zen balance: $12.5",
  });
});

test("mapOpenCodeUsage ignores malformed rows", () => {
  const messages = [];
  const result = mapOpenCodeUsage(
    {
      go: { usage: { rolling: { status: "ok" } } },
      budgets: [{ ruleID: "no_limit" }, { ruleID: "ok", limitDollars: 10, spentDollars: 1 }],
      billing: { balanceMicroCents: "not-a-number" },
    },
    (message) => messages.push(message)
  );

  assert.equal(result.overallUsagePercent, 10);
  assert.deepEqual(Object.keys(result.perModel), ["budget_ok"]);
  assert.equal(messages.length, 2);
});

test("OpenCodeProvider reports auth when no API key is configured", async () => {
  await withoutApiKey(async () => {
    const usage = await provider({ apiKey: "" }).fetchUsage();
    assert.deepEqual(usage.error, { code: "AUTH", message: "Auth Required" });
    assert.equal(usage.overallUsagePercent, null);
    await assert.rejects(
      provider({ apiKey: "" }).fetchRawUsage(),
      /Authentication credentials missing/
    );
  });
});

test("OpenCodeProvider reads Go usage, budgets and a balance over the API", async () => {
  const requests = [];
  await withFetch(
    async (url) => {
      requests.push(String(url));
      if (String(url).includes("/zen/go/v1/usage")) {
        return jsonResponse({
          usage: {
            rolling: { status: "ok", percent: 20, resetsAt: "2026-11-06T18:00:00.000Z" },
            weekly: { status: "ok", percent: 60, resetsAt: "2026-11-11T00:00:00.000Z" },
            monthly: { status: "ok", percent: 30, resetsAt: "2026-12-01T00:00:00.000Z" },
          },
        });
      }
      if (String(url).includes("/current-budgets")) {
        return jsonResponse([
          {
            ruleID: "rule_zen",
            limitDollars: 20,
            spentDollars: 5,
            scope: "each",
            per: "set",
            coverage: "all",
            shared: false,
            resetsAt: "2026-12-01T00:00:00.000Z",
          },
        ]);
      }
      if (String(url).includes("/billing/status")) {
        return jsonResponse({ balanceMicroCents: 7_500_000 });
      }
      return jsonResponse({}, 404);
    },
    async () => {
      const p = provider({ apiKey: "oc_sk_test", workspaceId: "wrk_test", cacheTtlMs: 30_000 });
      const usage = await p.fetchUsage();

      assert.equal(usage.error, undefined);
      assert.equal(usage.overallUsagePercent, 60);
      assert.equal(usage.overallResetTime, "2026-11-11T00:00:00.000Z");
      assert.equal(usage.perModel.go_rolling.usagePercent, 20);
      assert.equal(usage.perModel.budget_rule_zen.usagePercent, 25);
      assert.equal(usage.perModel.zen_balance.displayName, "Zen balance: $7.5");
      assert.equal(await p.getBalance(), 7.5);
      assert.deepEqual((await p.getBudgets()).map((item) => item.usagePercent), [25]);
      assert.equal((await p.getRollingUsage()).usagePercent, 20);

      const raw = await p.fetchRawUsage();
      assert.equal(raw.go.usage.rolling.percent, 20);
      assert.equal(raw.budgets.length, 1);
      assert.equal(raw.billing.balanceMicroCents, 7_500_000);
      assert.equal(requests.length, 6);
    }
  );
});

test("OpenCodeProvider keeps budgets when the workspace has no Go subscription", async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes("/zen/go/v1/usage")) return jsonResponse({ error: "no go" }, 403);
      if (String(url).includes("/current-budgets")) {
        return jsonResponse([
          { ruleID: "rule_zen", limitDollars: 10, spentDollars: 4, coverage: "all", per: "set" },
        ]);
      }
      return jsonResponse({ _tag: "Unauthorized" }, 401);
    },
    async () => {
      const usage = await provider({ apiKey: "oc_sk_test" }).fetchUsage();
      assert.equal(usage.error, undefined);
      assert.equal(usage.overallUsagePercent, 40);
      assert.deepEqual(Object.keys(usage.perModel), ["budget_rule_zen"]);
    }
  );
});

test("OpenCodeProvider reports auth when both endpoints reject the key", async () => {
  await withFetch(
    async (url) => jsonResponse({ error: { message: "Unauthorized" } }, String(url).includes("/current-budgets") ? 403 : 401),
    async () => {
      const usage = await provider({ apiKey: "oc_sk_bad" }).fetchUsage();
      assert.deepEqual(usage.error, { code: "AUTH", message: "Auth Required" });
    }
  );
});

test("OpenCodeProvider reports connection errors and partial failures", async () => {
  await withFetch(
    async () => {
      throw new Error("network down");
    },
    async () => {
      const usage = await provider({ apiKey: "oc_sk_test" }).fetchUsage();
      assert.deepEqual(usage.error, { code: "CONN", message: "Conn Error" });
    }
  );

  await withFetch(
    async (url) => {
      if (String(url).includes("/zen/go/v1/usage")) return jsonResponse({ error: "boom" }, 500);
      if (String(url).includes("/current-budgets")) {
        return jsonResponse([{ ruleID: "rule_zen", limitDollars: 10, spentDollars: 2 }]);
      }
      return jsonResponse({}, 500);
    },
    async () => {
      const usage = await provider({ apiKey: "oc_sk_test" }).fetchUsage();
      assert.equal(usage.error, undefined);
      assert.equal(usage.overallUsagePercent, 20);
      assert.equal(usage.perModel.budget_rule_zen.usagePercent, 20);
    }
  );
});

test("OpenCodeProvider reports when the key has no OpenCode subscription data", async () => {
  await withFetch(
    async (url) => (String(url).includes("/current-budgets") ? jsonResponse([]) : jsonResponse({}, 403)),
    async () => {
      const usage = await provider({ apiKey: "oc_sk_unknown" }).fetchUsage();
      assert.deepEqual(usage.error, { code: "API", message: "No subscription data" });
    }
  );
});
