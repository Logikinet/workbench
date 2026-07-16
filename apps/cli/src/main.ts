#!/usr/bin/env node
/**
 * pawb — Personal AI Workbench CLI
 * Talks only to localhost Agent Service.
 */

import { stdout as output } from "node:process";
import { runProviderCommand } from "./providerCommands.js";
import { safeExit } from "./prompt.js";
import { assertNoApiKeyFlag } from "./redact.js";
import { apiJson, ServiceOfflineError, serviceBaseUrl } from "./client.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertNoApiKeyFlag(argv);
  const cmd = argv[0]?.toLowerCase();

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    printRootHelp();
    safeExit(0);
  }

  if (cmd === "provider" || cmd === "providers") {
    const code = await runProviderCommand(argv.slice(1));
    safeExit(code);
  }

  if (cmd === "health") {
    try {
      const health = await apiJson<{ status?: string; version?: string; capabilities?: string[] }>(
        "/api/health"
      );
      output.write(
        `online  version=${health.version ?? "?"}  url=${serviceBaseUrl()}\n` +
          `capabilities=${(health.capabilities ?? []).join(",")}\n`
      );
      safeExit(0);
    } catch (error) {
      if (error instanceof ServiceOfflineError) {
        output.write(`${error.message}\n`);
        safeExit(2);
      }
      output.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
      safeExit(1);
    }
  }

  if (cmd === "harness") {
    const sub = argv[1]?.toLowerCase();
    if (sub === "status") {
      const name = argv[2] || "codex";
      try {
        if (name === "codex") {
          const status = await apiJson<Record<string, unknown>>("/api/codex-cli/status");
          output.write(`${JSON.stringify(status, null, 2)}\n`);
          output.write("注意：Codex CLI 登录状态 ≠ OpenAI API Provider 凭据。\n");
          safeExit(0);
        }
        const status = await apiJson<Record<string, unknown>>(
          `/api/harness/status/${encodeURIComponent(name)}`
        );
        output.write(`${JSON.stringify(status, null, 2)}\n`);
        safeExit(0);
      } catch (error) {
        output.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
        safeExit(1);
      }
    }
  }

  output.write(`未知命令：${cmd}\n\n`);
  printRootHelp();
  safeExit(1);
}

function printRootHelp(): void {
  output.write(`pawb — Personal AI Workbench CLI

用法：
  pawb health
  pawb provider …
  pawb harness status codex

环境变量：
  PAW_SERVICE_URL   默认 http://127.0.0.1:41731
  PAW_SERVICE_PORT  默认 41731

所有命令仅访问本机 Agent Service，不直接读写数据库。
`);
}

void main();
