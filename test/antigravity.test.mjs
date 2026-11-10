import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityProvider, mapAntigravityUsage, ProviderName } from "../dist/index.js";

const RAW = {
  description: "Within each group, models share a weekly limit.",
  groups: [
    {
      name: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      buckets: [
        {
          id: "gemini-weekly",
          name: "Weekly Limit Remaining",
          window: "weekly",
          remaining_fraction: 0.4906303882598877,
          reset_time: "2026-11-11T05:53:17Z",
        },
      ],
    },
    {
      name: "Claude and GPT models",
      description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
      buckets: [
        {
          id: "3p-weekly",
          name: "Weekly Limit Remaining",
          window: "weekly",
          remaining_fraction: 1,
          reset_time: "2026-11-11T06:17:49Z",
        },
      ],
    },
  ],
};

const SUCCESS_OUTPUT = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t49%\t2026-11-11T05:53:17Z\n",
  command: { name: "usage", data: RAW },
});

const silent = { log() {}, error() {} };
const posixOnly = { skip: process.platform === "win32" ? "fake agy is a shell script" : false };

function fakeAgy(script) {
  const dir = mkdtempSync(join(tmpdir(), "ai-limits-agy-"));
  const bin = join(dir, "agy");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function providerWith(binaryPath) {
  return new AntigravityProvider({ binaryPath, cacheTtlMs: 0 }).setLogger(silent);
}

test("mapAntigravityUsage keys buckets by agy id and picks the most constrained one", () => {
  const result = mapAntigravityUsage(RAW);

  assert.equal(result.provider, ProviderName.Antigravity);
  assert.equal(result.overallUsagePercent, 51);
  assert.equal(result.overallResetTime, "2026-11-11T05:53:17Z");
  assert.deepEqual(Object.keys(result.perModel), ["gemini-weekly", "3p-weekly"]);
  assert.deepEqual(result.perModel["gemini-weekly"], {
    usagePercent: 51,
    resetTime: "2026-11-11T05:53:17Z",
    displayName: "Gemini Models",
    windowSeconds: 604800,
  });
  assert.equal(result.perModel["3p-weekly"].usagePercent, 0);
  assert.equal(result.perModel["3p-weekly"].displayName, "Claude and GPT models");
});

test("mapAntigravityUsage labels unknown windows from the bucket name", () => {
  const result = mapAntigravityUsage({
    groups: [
      {
        name: "Gemini Models",
        buckets: [{ id: "gemini-5h", name: "Five Hour Limit Remaining", window: "five_hour", remaining_fraction: 0.25 }],
      },
    ],
  });

  assert.equal(result.perModel["gemini-5h"].displayName, "Gemini Models Five Hour Limit");
  assert.equal(result.perModel["gemini-5h"].usagePercent, 75);
  assert.equal(result.perModel["gemini-5h"].windowSeconds, undefined);
  assert.equal(result.perModel["gemini-5h"].resetTime, null);
});

test("mapAntigravityUsage skips malformed and duplicate buckets", () => {
  const messages = [];
  const result = mapAntigravityUsage(
    {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { name: "No id", remaining_fraction: 0.5 },
            { id: "no-fraction" },
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.9 },
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.1 },
          ],
        },
      ],
    },
    (message) => messages.push(message)
  );

  assert.deepEqual(Object.keys(result.perModel), ["gemini-weekly"]);
  assert.equal(result.perModel["gemini-weekly"].usagePercent, 10);
  assert.equal(messages.length, 3);
});

test("mapAntigravityUsage returns null overall usage when no buckets are reported", () => {
  const result = mapAntigravityUsage({ groups: [] });
  assert.equal(result.overallUsagePercent, null);
  assert.equal(result.overallResetTime, null);
  assert.deepEqual(result.perModel, {});
});

test("AntigravityProvider reads usage from agy", posixOnly, async () => {
  const bin = fakeAgy(`[ "$*" = "--print /usage --print-timeout 20s --output-format json" ] || exit 9\ncat <<'JSON'\n${SUCCESS_OUTPUT}\nJSON`);
  const provider = providerWith(bin);

  const usage = await provider.fetchUsage();
  assert.equal(usage.error, undefined);
  assert.equal(usage.overallUsagePercent, 51);
  assert.deepEqual(await provider.getModels(), ["gemini-weekly", "3p-weekly"]);
  assert.equal((await provider.getModelUsage("3p-weekly")).usagePercent, 0);
  assert.equal(await provider.getModelUsage("unknown"), null);
  assert.deepEqual(await provider.fetchRawUsage(), RAW);
});

test("AntigravityProvider runs agy with its background auto-updater disabled", posixOnly, async () => {
  const bin = fakeAgy(`[ "$AGY_CLI_DISABLE_AUTO_UPDATE" = "true" ] || exit 9\ncat <<'JSON'\n${SUCCESS_OUTPUT}\nJSON`);

  const usage = await providerWith(bin).fetchUsage();
  assert.equal(usage.error, undefined);
  assert.equal(usage.overallUsagePercent, 51);
});

test("AntigravityProvider reports a missing agy binary as an auth error", async () => {
  const provider = providerWith(join(tmpdir(), "ai-limits-missing", "agy"));

  const usage = await provider.fetchUsage();
  assert.deepEqual(usage.error, { code: "AUTH", message: "agy Not Found" });
  assert.equal(usage.overallUsagePercent, null);
  await assert.rejects(provider.fetchRawUsage(), /agy CLI not found/);
});

test("AntigravityProvider reports a failing agy run as an API error", posixOnly, async () => {
  const provider = providerWith(fakeAgy(`echo "error: /usage failed" >&2\nexit 1`));

  const usage = await provider.fetchUsage();
  assert.deepEqual(usage.error, { code: "API", message: "API Error" });
  await assert.rejects(provider.fetchRawUsage(), /\/usage failed/);
});

test("AntigravityProvider rejects unexpected agy output instead of reporting 0%", posixOnly, async () => {
  const cases = [
    "echo 'Gemini Models\tWeekly Limit Remaining\t49%'",
    `echo '{"status":"ERROR"}'`,
    `echo '{"status":"SUCCESS","command":{"name":"usage"}}'`,
  ];
  for (const script of cases) {
    const usage = await providerWith(fakeAgy(script)).fetchUsage();
    assert.deepEqual(usage.error, { code: "API", message: "API Error" }, script);
    assert.equal(usage.overallUsagePercent, null);
  }
});
