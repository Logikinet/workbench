/**
 * Automated Windows E2E release-gate checklist runner (Task 31).
 *
 * CI-safe: never requires real OpenAI / Codex credentials.
 */

import {
  checkInstallScriptsPresent,
  checkUninstallPreservesData,
  loadPlanUninstall,
  resolveRepoRoot,
  type PlanUninstallLike
} from "./packagingGate.js";
import { checkCredentialVaultRedaction } from "./credentialVaultGate.js";
import { checkFakeProviderPlanAndExecute } from "./fakeProviderGate.js";
import { buildReport, writeAcceptanceReport } from "./reportWriter.js";
import {
  RELEASE_GATE_ENVIRONMENT_RISKS,
  releaseGateOk,
  summarizeChecks,
  type EnvironmentRisk,
  type ReleaseGateCheck,
  type ReleaseGateReport
} from "./releaseGateTypes.js";

export interface ReleaseGateRunnerOptions {
  /** Monorepo root. Defaults to resolveRepoRoot() from this package. */
  repoRoot?: string;
  /** Skip writing reports/ markdown (tests that only assert checks). */
  writeReport?: boolean;
  /** Override markdown relative path under repoRoot. */
  reportRelativePath?: string;
  /** Injectable planUninstall for unit tests. */
  planUninstall?: PlanUninstallLike;
  /** Injectable check overrides (advanced tests). */
  checks?: {
    installScripts?: () => Promise<ReleaseGateCheck>;
    uninstallPreservesData?: () => Promise<ReleaseGateCheck>;
    credentialVault?: () => Promise<ReleaseGateCheck>;
    fakeProvider?: () => Promise<ReleaseGateCheck>;
  };
  /** Extra environment risks to append. */
  extraEnvironmentRisks?: EnvironmentRisk[];
}

export interface ReleaseGateRunnerResult {
  report: ReleaseGateReport;
  checks: ReleaseGateCheck[];
  markdownPath?: string;
  jsonPath?: string;
  markdown?: string;
}

/**
 * Run the automated release-gate checklist and optionally write reports/.
 */
export async function runReleaseGate(
  options: ReleaseGateRunnerOptions = {}
): Promise<ReleaseGateRunnerResult> {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const writeReport = options.writeReport !== false;

  const planUninstall =
    options.planUninstall ??
    (await loadPlanUninstall(repoRoot).catch(() => undefined));

  const checks: ReleaseGateCheck[] = [];

  checks.push(
    await (options.checks?.installScripts?.() ?? checkInstallScriptsPresent(repoRoot))
  );

  checks.push(
    await (options.checks?.uninstallPreservesData?.() ??
      checkUninstallPreservesData({
        repoRoot,
        planUninstall
      }))
  );

  checks.push(
    await (options.checks?.credentialVault?.() ?? checkCredentialVaultRedaction())
  );

  checks.push(
    await (options.checks?.fakeProvider?.() ?? checkFakeProviderPlanAndExecute())
  );

  const summary = summarizeChecks(checks);
  // Report check is appended after write so summary of core checks is stable;
  // final summary includes the report check.
  let report = buildReport({
    checks: [...checks],
    environmentRisks: [
      ...RELEASE_GATE_ENVIRONMENT_RISKS,
      ...(options.extraEnvironmentRisks ?? [])
    ],
    summary,
    ok: releaseGateOk(checks)
  });

  let markdownPath: string | undefined;
  let jsonPath: string | undefined;
  let markdown: string | undefined;

  if (writeReport) {
    const written = await writeAcceptanceReport({
      repoRoot,
      report,
      markdownRelativePath: options.reportRelativePath
    });
    markdownPath = written.markdownPath;
    jsonPath = written.jsonPath;
    markdown = written.markdown;

    const reportCheck: ReleaseGateCheck = {
      id: "acceptance-report-written",
      name: "Acceptance report written",
      category: "report",
      status: "pass",
      code: "ACCEPTANCE_REPORT_WRITTEN",
      detail: `Wrote acceptance report to ${markdownPath}`,
      meta: { markdownPath, jsonPath }
    };
    checks.push(reportCheck);
    const finalSummary = summarizeChecks(checks);
    report = buildReport({
      checks: [...checks],
      environmentRisks: report.environmentRisks,
      summary: finalSummary,
      ok: releaseGateOk(checks),
      generatedAt: report.generatedAt,
      reportPath: markdownPath
    });
    // Rewrite with final check list + reportPath.
    const rewritten = await writeAcceptanceReport({
      repoRoot,
      report,
      markdownRelativePath: options.reportRelativePath
    });
    markdown = rewritten.markdown;
  } else {
    const reportCheck: ReleaseGateCheck = {
      id: "acceptance-report-written",
      name: "Acceptance report written",
      category: "report",
      status: "skip",
      code: "ACCEPTANCE_REPORT_SKIPPED",
      detail: "Report write skipped (writeReport=false)."
    };
    checks.push(reportCheck);
    report = buildReport({
      checks: [...checks],
      environmentRisks: report.environmentRisks,
      summary: summarizeChecks(checks),
      ok: releaseGateOk(checks),
      generatedAt: report.generatedAt
    });
  }

  return { report, checks, markdownPath, jsonPath, markdown };
}
