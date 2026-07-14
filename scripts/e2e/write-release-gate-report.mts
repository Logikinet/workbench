/**
 * Write reports/release-gate-acceptance.md for Task 31.
 * CI-safe — no real OpenAI/Codex credentials.
 *
 *   node --import tsx scripts/e2e/write-release-gate-report.mts
 *   npm run release-gate
 */

import { runReleaseGate, resolveRepoRoot } from "../../apps/service/src/releaseGate/index.ts";

const repoRoot = resolveRepoRoot();
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
