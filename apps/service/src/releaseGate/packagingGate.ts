/**
 * Packaging / install-script release-gate checks.
 * Validates Windows packaging scripts exist and uninstall preserves data by default.
 */

import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ReleaseGateCheck } from "./releaseGateTypes.js";

/** Scripts required under packaging/windows for a single-user install flow. */
export const REQUIRED_WINDOWS_PACKAGING_SCRIPTS = [
  "Install-PersonalAIWorkbench.ps1",
  "Uninstall-PersonalAIWorkbench.ps1",
  "Upgrade-PersonalAIWorkbench.ps1",
  "paths.ps1",
  "TrayHost.ps1"
] as const;

export interface PlanUninstallLike {
  (input: {
    installRoot: string;
    dataDirectory: string;
    extraDeletePaths?: string[];
    confirmDeleteData?: boolean;
    confirmationToken?: string;
  }): {
    ok: boolean;
    removePaths: string[];
    preservePaths: string[];
    refusedPaths: Array<{ path: string; reason: string }>;
    clearAutostart?: { valueName: string; runKeyPath: string };
    error?: string;
  };
}

export interface PackagingGateOptions {
  /** Monorepo root containing packaging/ and apps/. */
  repoRoot: string;
  /** Injectable planUninstall (defaults to dynamic load of tray module). */
  planUninstall?: PlanUninstallLike;
}

/**
 * Resolve monorepo root from this module location:
 * apps/service/src/releaseGate → ../../../../
 */
export function resolveRepoRoot(fromUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../../../../", fromUrl));
}

export function packagingWindowsDir(repoRoot: string): string {
  return join(repoRoot, "packaging", "windows");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dynamic import of tray planUninstall so service tsc rootDir is not polluted.
 * Prefers source under vitest; falls back to dist after tray build.
 */
export async function loadPlanUninstall(repoRoot: string): Promise<PlanUninstallLike> {
  const candidates = [
    join(repoRoot, "apps", "tray", "src", "uninstallPlan.ts"),
    join(repoRoot, "apps", "tray", "dist", "uninstallPlan.js")
  ];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    const href = pathToFileURL(candidate).href;
    const mod = (await import(href)) as { planUninstall?: PlanUninstallLike };
    if (typeof mod.planUninstall === "function") {
      return mod.planUninstall;
    }
  }
  throw new Error(
    "planUninstall module not found under apps/tray/src or apps/tray/dist. Build tray or keep source available."
  );
}

/** Check that all required packaging scripts exist. */
export async function checkInstallScriptsPresent(repoRoot: string): Promise<ReleaseGateCheck> {
  const dir = packagingWindowsDir(repoRoot);
  const missing: string[] = [];
  const present: string[] = [];
  for (const name of REQUIRED_WINDOWS_PACKAGING_SCRIPTS) {
    const full = join(dir, name);
    if (await pathExists(full)) present.push(name);
    else missing.push(name);
  }

  if (missing.length > 0) {
    return {
      id: "install-scripts-present",
      name: "Windows install scripts present",
      category: "packaging",
      status: "fail",
      code: "INSTALL_SCRIPTS_MISSING",
      detail: `Missing packaging scripts under ${dir}: ${missing.join(", ")}`,
      remediation: "Restore packaging/windows/*.ps1 from source control and re-run the release gate.",
      meta: { dir, present, missing }
    };
  }

  return {
    id: "install-scripts-present",
    name: "Windows install scripts present",
    category: "packaging",
    status: "pass",
    code: "INSTALL_SCRIPTS_OK",
    detail: `All ${REQUIRED_WINDOWS_PACKAGING_SCRIPTS.length} packaging scripts present under packaging/windows.`,
    meta: { dir, present }
  };
}

/**
 * Validate uninstall preserves workbench data by default:
 * 1) planUninstall pure planner (install removed, data preserved)
 * 2) Uninstall-PersonalAIWorkbench.ps1 text contracts (confirmation token + preserve message)
 */
export async function checkUninstallPreservesData(
  options: PackagingGateOptions
): Promise<ReleaseGateCheck> {
  const { repoRoot } = options;
  const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\PersonalAIWorkbench";
  const dataDirectory = "C:\\Users\\Ada\\AppData\\Local\\PersonalAIWorkbench";
  const projectWorkspace = "D:\\Projects\\customer-app";

  let planUninstall = options.planUninstall;
  try {
    planUninstall ??= await loadPlanUninstall(repoRoot);
  } catch (error) {
    return {
      id: "uninstall-preserves-data",
      name: "Uninstall preserves data by default",
      category: "packaging",
      status: "fail",
      code: "PLAN_UNINSTALL_UNAVAILABLE",
      detail: error instanceof Error ? error.message : String(error),
      remediation: "Ensure apps/tray/src/uninstallPlan.ts is present or build tray (apps/tray/dist)."
    };
  }

  const defaultPlan = planUninstall({ installRoot, dataDirectory });
  if (!defaultPlan.ok) {
    return failUninstall("PLAN_UNINSTALL_DEFAULT_FAILED", `Default planUninstall failed: ${defaultPlan.error ?? "unknown"}`, {
      defaultPlan
    });
  }
  if (!defaultPlan.removePaths.includes(installRoot)) {
    return failUninstall("PLAN_UNINSTALL_MISSING_INSTALL", "Default plan must schedule install root removal.", {
      defaultPlan
    });
  }
  if (!defaultPlan.preservePaths.includes(dataDirectory)) {
    return failUninstall("PLAN_UNINSTALL_DATA_NOT_PRESERVED", "Default plan must preserve the data directory.", {
      defaultPlan
    });
  }
  if (defaultPlan.removePaths.some((p) => p === dataDirectory)) {
    return failUninstall("PLAN_UNINSTALL_DATA_SCHEDULED", "Default plan must not schedule data directory deletion.", {
      defaultPlan
    });
  }

  const workspacePlan = planUninstall({
    installRoot,
    dataDirectory,
    extraDeletePaths: [projectWorkspace]
  });
  if (workspacePlan.ok) {
    return failUninstall(
      "PLAN_UNINSTALL_WORKSPACE_ALLOWED",
      "planUninstall must refuse external Project workspaces without confirmation.",
      { workspacePlan }
    );
  }
  if (!workspacePlan.refusedPaths.some((r) => r.path === projectWorkspace)) {
    return failUninstall(
      "PLAN_UNINSTALL_WORKSPACE_NOT_REFUSED",
      "External Project workspace was not listed in refusedPaths.",
      { workspacePlan }
    );
  }

  const deniedDelete = planUninstall({
    installRoot,
    dataDirectory,
    confirmDeleteData: true,
    confirmationToken: "nope"
  });
  if (deniedDelete.ok || deniedDelete.removePaths.includes(dataDirectory)) {
    return failUninstall(
      "PLAN_UNINSTALL_TOKEN_BYPASS",
      "Data deletion without the correct confirmation token must be refused.",
      { deniedDelete }
    );
  }

  const allowedDelete = planUninstall({
    installRoot,
    dataDirectory,
    confirmDeleteData: true,
    confirmationToken: "DELETE-WORKBENCH-DATA"
  });
  if (!allowedDelete.ok || !allowedDelete.removePaths.includes(dataDirectory)) {
    return failUninstall(
      "PLAN_UNINSTALL_TOKEN_REJECTED",
      "Confirmed data deletion with DELETE-WORKBENCH-DATA must include the data directory.",
      { allowedDelete }
    );
  }

  const uninstallScript = join(packagingWindowsDir(repoRoot), "Uninstall-PersonalAIWorkbench.ps1");
  if (!(await pathExists(uninstallScript))) {
    return failUninstall("UNINSTALL_SCRIPT_MISSING", `Missing ${uninstallScript}`, {});
  }
  const scriptText = await readFile(uninstallScript, "utf8");
  const requiredSnippets = [
    "DELETE-WORKBENCH-DATA",
    "ConfirmDeleteData",
    "Preserved data directory",
    "UNINSTALL_REFUSED_DATA"
  ];
  const missingSnippets = requiredSnippets.filter((snippet) => !scriptText.includes(snippet));
  if (missingSnippets.length > 0) {
    return failUninstall(
      "UNINSTALL_SCRIPT_CONTRACT",
      `Uninstall script missing required contracts: ${missingSnippets.join(", ")}`,
      { missingSnippets }
    );
  }

  // paths.ps1 must keep install root separate from data directory helpers.
  const pathsScript = join(packagingWindowsDir(repoRoot), "paths.ps1");
  const pathsText = await readFile(pathsScript, "utf8");
  if (!pathsText.includes("Get-PawInstallRoot") || !pathsText.includes("Get-PawDataDirectory")) {
    return failUninstall(
      "PATHS_SCRIPT_CONTRACT",
      "paths.ps1 must expose Get-PawInstallRoot and Get-PawDataDirectory.",
      {}
    );
  }
  if (!pathsText.includes("Test-PawIsProtectedDataPath")) {
    return failUninstall(
      "PATHS_PROTECTED_HELPER_MISSING",
      "paths.ps1 must expose Test-PawIsProtectedDataPath for uninstall safety.",
      {}
    );
  }

  return {
    id: "uninstall-preserves-data",
    name: "Uninstall preserves data by default",
    category: "packaging",
    status: "pass",
    code: "UNINSTALL_PRESERVES_DATA",
    detail:
      "planUninstall removes install bits only by default; data directory and external Project workspaces require DELETE-WORKBENCH-DATA. Packaging Uninstall script mirrors the same contracts.",
    meta: {
      installRoot,
      dataDirectory,
      defaultPreserve: defaultPlan.preservePaths,
      defaultRemove: defaultPlan.removePaths
    }
  };
}

function failUninstall(
  code: string,
  detail: string,
  meta: Record<string, unknown>
): ReleaseGateCheck {
  return {
    id: "uninstall-preserves-data",
    name: "Uninstall preserves data by default",
    category: "packaging",
    status: "fail",
    code,
    detail,
    remediation:
      "Fix apps/tray/src/uninstallPlan.ts and packaging/windows/Uninstall-PersonalAIWorkbench.ps1 so uninstall never deletes data without explicit confirmation.",
    meta
  };
}

/** Convenience: dirname of a file URL (tests). */
export function dirnameFromUrl(url: string): string {
  return dirname(fileURLToPath(url));
}
