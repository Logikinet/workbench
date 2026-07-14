import { describe, expect, it } from "vitest";
import { InstallerErrorCode } from "./installerErrors.js";
import { planUninstall } from "./uninstallPlan.js";

describe("uninstall path preservation", () => {
  const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\PersonalAIWorkbench";
  const dataDirectory = "C:\\Users\\Ada\\AppData\\Local\\PersonalAIWorkbench";
  const projectWorkspace = "D:\\Projects\\customer-app";

  it("removes install bits but preserves the data directory by default", () => {
    const plan = planUninstall({ installRoot, dataDirectory });
    expect(plan.ok).toBe(true);
    expect(plan.removePaths).toEqual([installRoot]);
    expect(plan.preservePaths).toEqual([dataDirectory]);
    expect(plan.refusedPaths).toEqual([]);
  });

  it("always schedules HKCU Run autostart cleanup for PersonalAIWorkbench", () => {
    const plan = planUninstall({ installRoot, dataDirectory });
    expect(plan.clearAutostart).toEqual({
      valueName: "PersonalAIWorkbench",
      runKeyPath: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
    });
  });

  it("never deletes Project workspaces without explicit confirmation", () => {
    const plan = planUninstall({
      installRoot,
      dataDirectory,
      extraDeletePaths: [projectWorkspace]
    });
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain(InstallerErrorCode.UNINSTALL_REFUSED_DATA);
    expect(plan.removePaths).toEqual([installRoot]);
    expect(plan.refusedPaths.map((r) => r.path)).toContain(projectWorkspace);
    expect(plan.preservePaths).toEqual(expect.arrayContaining([dataDirectory, projectWorkspace]));
  });

  it("refuses to delete formal artifacts under the data directory without confirmation", () => {
    const artifact = `${dataDirectory}\\artifacts\\release-notes.md`;
    const plan = planUninstall({
      installRoot,
      dataDirectory,
      extraDeletePaths: [artifact]
    });
    expect(plan.ok).toBe(false);
    expect(plan.refusedPaths.some((r) => r.path === artifact)).toBe(true);
    expect(plan.preservePaths).toContain(dataDirectory);
  });

  it("allows data deletion only with the explicit confirmation token", () => {
    const denied = planUninstall({
      installRoot,
      dataDirectory,
      confirmDeleteData: true,
      confirmationToken: "nope"
    });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain(InstallerErrorCode.CONFIRMATION_REQUIRED);
    expect(denied.removePaths).toEqual([]);

    const allowed = planUninstall({
      installRoot,
      dataDirectory,
      confirmDeleteData: true,
      confirmationToken: "DELETE-WORKBENCH-DATA"
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.removePaths).toEqual(expect.arrayContaining([installRoot, dataDirectory]));
  });

  it("refuses when install root is nested under the data directory without data confirmation", () => {
    const nestedInstall = `${dataDirectory}\\app`;
    const plan = planUninstall({ installRoot: nestedInstall, dataDirectory });
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain(InstallerErrorCode.UNINSTALL_REFUSED_DATA);
  });
});
