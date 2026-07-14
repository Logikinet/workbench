import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCredentialVaultRedaction,
  MemoryCredentialVault
} from "./credentialVaultGate.js";
import { checkFakeProviderPlanAndExecute } from "./fakeProviderGate.js";
import {
  checkInstallScriptsPresent,
  checkUninstallPreservesData,
  REQUIRED_WINDOWS_PACKAGING_SCRIPTS,
  resolveRepoRoot,
  type PlanUninstallLike
} from "./packagingGate.js";
import {
  formatAcceptanceReportMarkdown,
  writeAcceptanceReport,
  buildReport
} from "./reportWriter.js";
import { runReleaseGate } from "./releaseGateRunner.js";
import {
  RELEASE_GATE_ENVIRONMENT_RISKS,
  releaseGateOk,
  summarizeChecks,
  type ReleaseGateCheck
} from "./releaseGateTypes.js";

const repoRoot = resolveRepoRoot();

describe("packaging gate", () => {
  it("finds all required Windows install scripts under packaging/windows", async () => {
    const check = await checkInstallScriptsPresent(repoRoot);
    expect(check.status).toBe("pass");
    expect(check.code).toBe("INSTALL_SCRIPTS_OK");
    expect(check.meta?.present).toEqual(expect.arrayContaining([...REQUIRED_WINDOWS_PACKAGING_SCRIPTS]));
  });

  it("fails when a packaging script is missing", async () => {
    const check = await checkInstallScriptsPresent(join(repoRoot, "does-not-exist-root"));
    expect(check.status).toBe("fail");
    expect(check.code).toBe("INSTALL_SCRIPTS_MISSING");
  });

  it("validates planUninstall preserves data and refuses external workspaces", async () => {
    const check = await checkUninstallPreservesData({ repoRoot });
    expect(check.status).toBe("pass");
    expect(check.code).toBe("UNINSTALL_PRESERVES_DATA");
    expect(check.meta?.defaultPreserve).toEqual(
      expect.arrayContaining(["C:\\Users\\Ada\\AppData\\Local\\PersonalAIWorkbench"])
    );
  });

  it("fails when planUninstall wrongly deletes data by default", async () => {
    const badPlan: PlanUninstallLike = () => ({
      ok: true,
      removePaths: [
        "C:\\Users\\Ada\\AppData\\Local\\Programs\\PersonalAIWorkbench",
        "C:\\Users\\Ada\\AppData\\Local\\PersonalAIWorkbench"
      ],
      preservePaths: [],
      refusedPaths: []
    });
    const check = await checkUninstallPreservesData({ repoRoot, planUninstall: badPlan });
    expect(check.status).toBe("fail");
    expect(check.code).toMatch(/PLAN_UNINSTALL/);
  });
});

describe("credential vault redaction gate", () => {
  it("keeps API keys in the vault and out of public/backup/log surfaces", async () => {
    const check = await checkCredentialVaultRedaction({
      sampleSecret: "sk-test-release-gate-secret-xyz"
    });
    expect(check.status).toBe("pass");
    expect(check.code).toBe("CREDENTIAL_VAULT_REDACTION_OK");
    expect(check.meta?.vaultBackend).toBe("memory");
  });

  it("uses injectable memory vault when provided", async () => {
    const vault = new MemoryCredentialVault();
    const workDir = await mkdtemp(join(tmpdir(), "paw-rg-vault-"));
    try {
      const check = await checkCredentialVaultRedaction({
        vault,
        workDir,
        sampleSecret: "sk-injected-vault-secret-abc"
      });
      expect(check.status).toBe("pass");
      expect([...vault.values.values()]).toContain("sk-injected-vault-secret-abc");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe("fake-provider plan+execute gate", () => {
  it("completes AI plan and tool-loop execute without real API keys", async () => {
    const check = await checkFakeProviderPlanAndExecute();
    expect(check.status).toBe("pass");
    expect(check.code).toBe("FAKE_PROVIDER_PLAN_EXECUTE_OK");
    expect(check.meta?.realCredentialsRequired).toBe(false);
    expect(check.meta?.realCodexRequired).toBe(false);
    expect(check.meta?.toolTrace).toEqual(["read_file", "write_file"]);
  });
});

describe("acceptance report writer", () => {
  let tmp: string;

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("formats markdown with pass/fail sections and environment risks including real Codex", () => {
    const checks: ReleaseGateCheck[] = [
      {
        id: "install-scripts-present",
        name: "scripts",
        category: "packaging",
        status: "pass",
        code: "OK",
        detail: "all present"
      },
      {
        id: "x",
        name: "broken",
        category: "packaging",
        status: "fail",
        code: "NOPE",
        detail: "missing",
        remediation: "fix it"
      }
    ];
    const report = buildReport({
      checks,
      environmentRisks: RELEASE_GATE_ENVIRONMENT_RISKS,
      summary: summarizeChecks(checks),
      ok: releaseGateOk(checks),
      generatedAt: "2026-01-01T00:00:00.000Z"
    });
    const md = formatAcceptanceReportMarkdown(report);
    expect(md).toContain("# Personal AI Workbench — Windows E2E Release Gate Acceptance Report");
    expect(md).toContain("**Overall:** FAIL");
    expect(md).toContain("CI-safe");
    expect(md).toContain("Real Codex CLI login");
    expect(md).toContain("FakeModelProvider");
    expect(md).toContain("NOPE");
    expect(md).toContain("Remediation: fix it");
  });

  it("writes markdown and json under reports/", async () => {
    tmp = await mkdtemp(join(tmpdir(), "paw-rg-report-"));
    const checks: ReleaseGateCheck[] = [
      {
        id: "install-scripts-present",
        name: "scripts",
        category: "packaging",
        status: "pass",
        code: "OK",
        detail: "ok"
      }
    ];
    const report = buildReport({
      checks,
      environmentRisks: RELEASE_GATE_ENVIRONMENT_RISKS,
      summary: summarizeChecks(checks),
      ok: true
    });
    const written = await writeAcceptanceReport({ repoRoot: tmp, report });
    await access(written.markdownPath, constants.F_OK);
    expect(written.markdownPath.replace(/\\/g, "/")).toMatch(/reports\/release-gate-acceptance\.md$/);
    const body = await readFile(written.markdownPath, "utf8");
    expect(body).toContain("PASS");
    expect(body).toMatch(/Codex/i);
    expect(written.jsonPath).toBeTruthy();
    const json = JSON.parse(await readFile(written.jsonPath!, "utf8"));
    expect(json.ciSafe).toBe(true);
    expect(json.kind).toBe("personal-ai-workbench-release-gate");
  });
});

describe("runReleaseGate orchestrator", () => {
  let tmp: string;

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("runs the full CI-safe checklist and writes reports without real credentials", async () => {
    tmp = await mkdtemp(join(tmpdir(), "paw-rg-run-"));
    const result = await runReleaseGate({
      repoRoot,
      // Write report into temp so we do not clobber repo reports/ during unit tests.
      reportRelativePath: join(tmp, "release-gate-acceptance.md")
    });

    expect(result.report.ciSafe).toBe(true);
    expect(result.report.ok).toBe(true);
    expect(result.report.summary.fail).toBe(0);
    expect(result.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "install-scripts-present",
        "uninstall-preserves-data",
        "credential-vault-redaction",
        "fake-provider-plan-execute",
        "acceptance-report-written"
      ])
    );
    for (const id of [
      "install-scripts-present",
      "uninstall-preserves-data",
      "credential-vault-redaction",
      "fake-provider-plan-execute",
      "acceptance-report-written"
    ]) {
      const check = result.checks.find((c) => c.id === id);
      expect(check?.status, id).toBe("pass");
    }

    expect(result.markdownPath).toBeTruthy();
    const md = await readFile(result.markdownPath!, "utf8");
    expect(md).toContain("Real Codex CLI login");
    expect(md).toContain("FakeModelProvider");
    expect(md).toContain("**Overall:** PASS");
    expect(result.report.environmentRisks.some((r) => r.id === "real-codex-cli-login")).toBe(true);
    expect(result.report.environmentRisks.some((r) => r.id === "real-openai-compatible-key")).toBe(
      true
    );
  });

  it("can skip report write and mark acceptance-report-written as skip", async () => {
    const result = await runReleaseGate({ repoRoot, writeReport: false });
    const reportCheck = result.checks.find((c) => c.id === "acceptance-report-written");
    expect(reportCheck?.status).toBe("skip");
    expect(result.report.ok).toBe(true);
  });

  it("surfaces fail when an injected check fails", async () => {
    const result = await runReleaseGate({
      repoRoot,
      writeReport: false,
      checks: {
        installScripts: async () => ({
          id: "install-scripts-present",
          name: "scripts",
          category: "packaging",
          status: "fail",
          code: "INSTALL_SCRIPTS_MISSING",
          detail: "injected failure"
        })
      }
    });
    expect(result.report.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "install-scripts-present")?.status).toBe("fail");
  });
});
