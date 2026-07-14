/**
 * Windows E2E release-gate checklist contracts (Task 31).
 *
 * Automated harness that can run in CI without real OpenAI / Codex credentials.
 * Real Codex CLI login and live OpenAI-compatible keys are documented as
 * residual environment risks — never required for gate pass in CI.
 */

/** Outcome of a single release-gate check. */
export type ReleaseGateCheckStatus = "pass" | "fail" | "warn" | "skip";

/** Stable check ids used by automation and the acceptance report. */
export const releaseGateCheckIds = [
  "install-scripts-present",
  "uninstall-preserves-data",
  "credential-vault-redaction",
  "fake-provider-plan-execute",
  "acceptance-report-written"
] as const;

export type ReleaseGateCheckId = (typeof releaseGateCheckIds)[number];

export type ReleaseGateCategory =
  | "packaging"
  | "credentials"
  | "ai-path"
  | "report"
  | "environment";

export interface ReleaseGateCheck {
  id: ReleaseGateCheckId | string;
  name: string;
  category: ReleaseGateCategory;
  status: ReleaseGateCheckStatus;
  /** Machine-oriented stable code. */
  code: string;
  detail: string;
  /** Optional remediation guidance. */
  remediation?: string;
  meta?: Record<string, unknown>;
}

export interface ReleaseGateSummary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
  total: number;
}

/** Residual risks that cannot be closed without a real Windows user environment. */
export interface EnvironmentRisk {
  id: string;
  severity: "info" | "warn" | "blocker-for-full-e2e";
  title: string;
  detail: string;
}

export interface ReleaseGateReport {
  schemaVersion: 1;
  kind: "personal-ai-workbench-release-gate";
  generatedAt: string;
  /** true only when no check has status fail. */
  ok: boolean;
  /** CI-safe gate: no real API keys / Codex login required. */
  ciSafe: true;
  summary: ReleaseGateSummary;
  checks: ReleaseGateCheck[];
  environmentRisks: EnvironmentRisk[];
  /** Absolute path of the written markdown report, when produced. */
  reportPath?: string;
}

export const RELEASE_GATE_ENVIRONMENT_RISKS: EnvironmentRisk[] = [
  {
    id: "real-openai-compatible-key",
    severity: "blocker-for-full-e2e",
    title: "Real OpenAI-compatible API key",
    detail:
      "Full Windows acceptance of live AI plan+execute requires a user-supplied OpenAI-compatible API key in Windows Credential Manager. CI uses FakeModelProvider only and must never require this secret."
  },
  {
    id: "real-codex-cli-login",
    severity: "blocker-for-full-e2e",
    title: "Real Codex CLI login session",
    detail:
      "Worktree modify / verify / review / apply against real Codex requires an already-logged-in Codex CLI on the target Windows machine. This is an environment risk, not a CI gate failure. Automated release-gate uses fake providers and never invokes real Codex."
  },
  {
    id: "clean-windows-user-profile",
    severity: "warn",
    title: "Clean Windows user profile install",
    detail:
      "Scripted packaging checks validate install/uninstall contracts and artifact presence. A full clean-profile install of Service + Tray + PWA still needs a real Windows desktop session."
  },
  {
    id: "windows-credential-manager-hardware",
    severity: "info",
    title: "Windows Credential Manager host",
    detail:
      "Credential redaction contracts are verified with an in-memory vault + public/backup snapshots. Live CredWrite/CredRead requires win32 and is covered by WindowsCredentialVault at runtime."
  }
];

export function summarizeChecks(checks: ReleaseGateCheck[]): ReleaseGateSummary {
  const summary: ReleaseGateSummary = { pass: 0, warn: 0, fail: 0, skip: 0, total: checks.length };
  for (const check of checks) {
    summary[check.status] += 1;
  }
  return summary;
}

export function releaseGateOk(checks: ReleaseGateCheck[]): boolean {
  return checks.every((check) => check.status !== "fail");
}
