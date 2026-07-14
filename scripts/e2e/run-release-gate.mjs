#!/usr/bin/env node
/**
 * CLI entry for the Windows E2E release-gate harness (Task 31).
 *
 * Recommended (CI / no build step):
 *   npx vitest run apps/service/src/releaseGate
 *
 * After building the service package:
 *   npm run build --workspace=@paw/service
 *   node scripts/e2e/run-release-gate.mjs
 *
 * CI-safe: does not require real OpenAI or Codex credentials.
 * Writes reports/release-gate-acceptance.md (+ .json).
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const require = createRequire(import.meta.url);

async function main() {
  let runReleaseGate;
  try {
    ({ runReleaseGate } = require(
      join(repoRoot, "apps/service/dist/releaseGate/releaseGateRunner.js")
    ));
  } catch {
    console.error(
      [
        "Compiled release gate not found.",
        "Use either:",
        "  npx vitest run apps/service/src/releaseGate",
        "or:",
        "  npm run build --workspace=@paw/service && node scripts/e2e/run-release-gate.mjs"
      ].join("\n")
    );
    process.exit(2);
  }

  const result = await runReleaseGate({ repoRoot, writeReport: true });
  const { report, markdownPath } = result;
  console.log(`Release gate: ${report.ok ? "PASS" : "FAIL"}`);
  console.log(
    `  pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} skip=${report.summary.skip}`
  );
  for (const check of report.checks) {
    console.log(`  [${check.status.toUpperCase()}] ${check.id} (${check.code})`);
  }
  if (markdownPath) {
    console.log(`Report: ${markdownPath}`);
  }
  console.log(
    "Environment risks (not CI failures): real OpenAI-compatible key, real Codex CLI login."
  );
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
