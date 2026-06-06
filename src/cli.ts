#!/usr/bin/env node

import { Command } from "commander";
import pc from "picocolors";
import Table from "cli-table3";
import { LimitsClient } from "@/index.js";
import { ProviderName, StandardUsageResult, ModelUsage, Logger } from "@/types.js";
import { AntigravityProvider } from "@/providers/antigravity.js";

const client = new LimitsClient();
const program = new Command();

program
  .name("ai-limits")
  .description("CLI to check AI agent usage limits and quotas across multiple providers")
  .version("1.0.0");

function formatResetTime(resetStr: string | null): string {
  if (!resetStr) return pc.dim("-");
  try {
    const date = new Date(resetStr);
    if (isNaN(date.getTime())) return pc.dim(resetStr);
    
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    if (diffMs <= 0) return pc.green("Reset now");
    
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    
    if (diffHours > 0) {
      return pc.yellow(`in ${diffHours}h ${mins}m`);
    }
    return pc.yellow(`in ${diffMins}m`);
  } catch {
    return pc.dim(resetStr);
  }
}

function formatUsage(percent: number | null): string {
  if (percent === null) return pc.dim("-");
  const barLength = 10;
  const filledLength = Math.round((percent / 100) * barLength);
  const emptyLength = barLength - filledLength;
  const bar = pc.green("█".repeat(filledLength)) + pc.dim("░".repeat(emptyLength));
  
  let valStr = `${percent}%`;
  if (percent >= 90) {
    valStr = pc.red(valStr);
  } else if (percent >= 70) {
    valStr = pc.yellow(valStr);
  } else {
    valStr = pc.green(valStr);
  }
  return `${bar} ${valStr}`;
}

function renderResult(result: StandardUsageResult, logger: Logger) {
  if (result.error) {
    return;
  }

  logger.log(pc.bold(pc.cyan(`\nProvider: ${result.provider.toUpperCase()}`)));
  logger.log(`Overall Usage: ${formatUsage(result.overallUsagePercent)}`);
  logger.log(`Next Reset:    ${formatResetTime(result.overallResetTime)}`);

  if (result.perModel && Object.keys(result.perModel).length > 0) {
    const table = new Table({
      head: [pc.bold("Model/Bucket"), pc.bold("Usage"), pc.bold("Reset Time")],
      colWidths: [30, 20, 20],
    });

    const entries = Object.entries(result.perModel) as [string, ModelUsage][];
    for (const [modelId, info] of entries) {
      table.push([
        info.displayName || modelId,
        formatUsage(info.usagePercent),
        formatResetTime(info.resetTime || null),
      ]);
    }
    logger.log(table.toString());
  }
}

program
  .command("show")
  .description("Display usage and limits for AI providers")
  .argument("[provider]", "AI Provider name (antigravity, claude, chatgpt, gemini, minimax, openrouter)")
  .option("-a, --all", "Query all providers", false)
  .action(async (providerArg, options) => {
    try {
      if (providerArg) {
        const name = providerArg.toLowerCase() as ProviderName;
        const valid: ProviderName[] = [
          ProviderName.Antigravity,
          ProviderName.Claude,
          ProviderName.ChatGpt,
          ProviderName.Gemini,
          ProviderName.MiniMax,
          ProviderName.OpenRouter,
        ];
        if (!valid.includes(name)) {
          client.logger.error(pc.red(`Error: Invalid provider '${providerArg}'. Valid options: ${valid.join(", ")}`));
          process.exit(1);
        }
        client.logger.log(pc.dim(`Fetching usage details for ${name}...`));
        const res = await client.fetchUsage(name);
        renderResult(res, client.logger);
      } else {
        client.logger.log(pc.dim("Fetching usage details for all providers..."));
        const results = await client.fetchAllUsage();
        for (const res of Object.values(results)) {
          renderResult(res, client.logger);
        }
      }
    } catch (err: any) {
      client.logger.error(pc.red(`CLI Execution Error: ${err.message || err}`));
      process.exit(1);
    }
  });

program
  .command("login")
  .description("Authenticate with a provider (only 'antigravity' supported)")
  .argument("<provider>", "AI Provider name")
  .action(async (providerArg) => {
    const name = providerArg.toLowerCase();
    if (name !== "antigravity") {
      client.logger.error(pc.red("Error: Login is only supported and required for 'antigravity'"));
      process.exit(1);
    }

    client.logger.log(pc.cyan("Starting OAuth login flow for Antigravity. Opening browser..."));
    const provider = client.getProvider(ProviderName.Antigravity) as AntigravityProvider;
    try {
      const email = await provider.login();
      client.logger.log(pc.green(`Successfully authenticated as: ${email}`));
    } catch (err: any) {
      client.logger.error(pc.red(`Authentication failed: ${err.message || err}`));
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Clear authentication tokens for a provider (only 'antigravity' supported)")
  .argument("<provider>", "AI Provider name")
  .action(async (providerArg) => {
    const name = providerArg.toLowerCase();
    if (name !== "antigravity") {
      client.logger.error(pc.red("Error: Logout is only supported for 'antigravity'"));
      process.exit(1);
    }

    const provider = client.getProvider(ProviderName.Antigravity) as AntigravityProvider;
    try {
      await provider.logout();
      client.logger.log(pc.green("Successfully logged out and cleared local OAuth tokens."));
    } catch (err: any) {
      client.logger.error(pc.red(`Logout failed: ${err.message || err}`));
      process.exit(1);
    }
  });

program.parse(process.argv);
