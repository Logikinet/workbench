/**
 * Acceptance report markdown writer for the Windows E2E release gate.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  EnvironmentRisk,
  ReleaseGateCheck,
  ReleaseGateReport,
  ReleaseGateSummary
} from "./releaseGateTypes.js";

export const DEFAULT_REPORT_RELATIVE_PATH = join("reports", "release-gate-acceptance.md");
export const DEFAULT_REPORT_JSON_RELATIVE_PATH = join("reports", "release-gate-acceptance.json");

export interface WriteReportOptions {
  /** Monorepo root; report is written under reports/. */
  repoRoot: string;
  report: ReleaseGateReport;
  /** Override markdown path (absolute or relative to repoRoot). */
  markdownRelativePath?: string;
  /** Also write machine-readable JSON beside the markdown (default true). */
  writeJson?: boolean;
}

export function formatAcceptanceReportMarkdown(report: ReleaseGateReport): string {
  const lines: string[] = [];
  lines.push("# Personal AI Workbench — Windows E2E Release Gate Acceptance Report");
  lines.push("");
  lines.push(`- **Generated at:** ${report.generatedAt}`);
  lines.push(`- **Overall:** ${report.ok ? "PASS" : "FAIL"}`);
  lines.push(`- **CI-safe (no real OpenAI/Codex credentials required):** ${report.ciSafe ? "yes" : "no"}`);
  lines.push(
    `- **Summary:** pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} skip=${report.summary.skip} total=${report.summary.total}`
  );
  lines.push("");
  lines.push("## Checklist results");
  lines.push("");
  lines.push("| Status | Id | Code | Detail |");
  lines.push("| --- | --- | --- | --- |");
  for (const check of report.checks) {
    lines.push(
      `| ${statusBadge(check.status)} | \`${check.id}\` | \`${check.code}\` | ${escapeTable(check.detail)} |`
    );
  }
  lines.push("");
  lines.push("## Passed items");
  lines.push("");
  const passed = report.checks.filter((c) => c.status === "pass");
  if (passed.length === 0) {
    lines.push("_None._");
  } else {
    for (const check of passed) {
      lines.push(`- [x] **${check.name}** (\`${check.code}\`) — ${check.detail}`);
    }
  }
  lines.push("");
  lines.push("## Failed items");
  lines.push("");
  const failed = report.checks.filter((c) => c.status === "fail");
  if (failed.length === 0) {
    lines.push("_None._");
  } else {
    for (const check of failed) {
      lines.push(`- [ ] **${check.name}** (\`${check.code}\`) — ${check.detail}`);
      if (check.remediation) {
        lines.push(`  - Remediation: ${check.remediation}`);
      }
    }
  }
  lines.push("");
  lines.push("## Warnings / skips");
  lines.push("");
  const soft = report.checks.filter((c) => c.status === "warn" || c.status === "skip");
  if (soft.length === 0) {
    lines.push("_None._");
  } else {
    for (const check of soft) {
      lines.push(`- **${check.status.toUpperCase()}** **${check.name}** (\`${check.code}\`) — ${check.detail}`);
    }
  }
  lines.push("");
  lines.push("## Residual environment risks");
  lines.push("");
  lines.push(
    "These items are **not** CI failures. Full Windows desktop acceptance still depends on a real user environment."
  );
  lines.push("");
  for (const risk of report.environmentRisks) {
    lines.push(`### ${risk.title} (\`${risk.id}\`)`);
    lines.push("");
    lines.push(`- **Severity:** ${risk.severity}`);
    lines.push(`- ${risk.detail}`);
    lines.push("");
  }
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- Automated gate validates install scripts, uninstall data preservation (`planUninstall`), credential vault redaction, and FakeModelProvider plan+execute."
  );
  lines.push(
    "- **Real Codex CLI login** and **live OpenAI-compatible API keys** are environment risks and must never be required for CI green."
  );
  lines.push(
    "- Do not mark Firstmate Harness core complete until a real Windows session closes the residual risks above (see issue 31)."
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function writeAcceptanceReport(
  options: WriteReportOptions
): Promise<{ markdownPath: string; jsonPath?: string; markdown: string }> {
  const rel = options.markdownRelativePath ?? DEFAULT_REPORT_RELATIVE_PATH;
  const markdownPath = isAbsolutePath(rel) ? rel : join(options.repoRoot, rel);
  const markdown = formatAcceptanceReportMarkdown(options.report);

  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, markdown, "utf8");

  let jsonPath: string | undefined;
  if (options.writeJson !== false) {
    jsonPath = isAbsolutePath(rel)
      ? rel.replace(/\.md$/i, ".json")
      : join(options.repoRoot, DEFAULT_REPORT_JSON_RELATIVE_PATH);
    // Keep reportPath out of JSON body circularity — use the in-memory report as-is.
    const jsonBody = {
      ...options.report,
      reportPath: markdownPath
    };
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(jsonBody, null, 2)}\n`, "utf8");
  }

  return { markdownPath, jsonPath, markdown };
}

export function buildReport(input: {
  checks: ReleaseGateCheck[];
  environmentRisks: EnvironmentRisk[];
  summary: ReleaseGateSummary;
  ok: boolean;
  generatedAt?: string;
  reportPath?: string;
}): ReleaseGateReport {
  return {
    schemaVersion: 1,
    kind: "personal-ai-workbench-release-gate",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ok: input.ok,
    ciSafe: true,
    summary: input.summary,
    checks: input.checks,
    environmentRisks: input.environmentRisks,
    reportPath: input.reportPath
  };
}

function statusBadge(status: ReleaseGateCheck["status"]): string {
  switch (status) {
    case "pass":
      return "PASS";
    case "fail":
      return "FAIL";
    case "warn":
      return "WARN";
    case "skip":
      return "SKIP";
    default:
      return String(status);
  }
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function isAbsolutePath(pathValue: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(pathValue) || pathValue.startsWith("/") || pathValue.startsWith("\\\\");
}
