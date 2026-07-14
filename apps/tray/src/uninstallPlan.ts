import { AUTOSTART_VALUE_NAME, isProtectedDataPath, normalizePathForCompare } from "./paths.js";
import { formatInstallerFailure, InstallerErrorCode } from "./installerErrors.js";

export interface UninstallPlanInput {
  installRoot: string;
  dataDirectory: string;
  /** Optional extra paths the user asked to delete (workspaces / artifacts). */
  extraDeletePaths?: string[];
  /** When true, allows deleting dataDirectory itself (still refuses unknown workspace paths unless listed). */
  confirmDeleteData?: boolean;
  /** Explicit confirmation token required to delete protected data or extra paths. */
  confirmationToken?: string;
  requiredConfirmationToken?: string;
}

export interface AutostartCleanupStep {
  /** HKCU Run value name to delete (best-effort). */
  valueName: string;
  runKeyPath: string;
}

export interface UninstallPlan {
  removePaths: string[];
  preservePaths: string[];
  refusedPaths: Array<{ path: string; reason: string }>;
  /** Always clear the product autostart entry so logon does not resurrect a missing path. */
  clearAutostart: AutostartCleanupStep;
  ok: boolean;
  error?: string;
}

export function planAutostartCleanup(
  valueName: string = AUTOSTART_VALUE_NAME
): AutostartCleanupStep {
  return {
    valueName,
    runKeyPath: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
  };
}

/**
 * Pure uninstall planner: removes app bits under installRoot only by default.
 * Never schedules dataDirectory or arbitrary Project workspace paths without confirmation.
 */
export function planUninstall(input: UninstallPlanInput): UninstallPlan {
  const preservePaths: string[] = [];
  const removePaths: string[] = [];
  const refusedPaths: Array<{ path: string; reason: string }> = [];
  const clearAutostart = planAutostartCleanup();

  const install = input.installRoot.trim();
  const data = input.dataDirectory.trim();
  if (!install || !data) {
    return {
      removePaths: [],
      preservePaths: [],
      refusedPaths: [],
      clearAutostart,
      ok: false,
      error: formatInstallerFailure(InstallerErrorCode.PATH_RESOLVE_FAILED)
    };
  }

  // Always preserve data directory unless explicitly confirmed.
  if (input.confirmDeleteData) {
    const token = input.requiredConfirmationToken ?? "DELETE-WORKBENCH-DATA";
    if (input.confirmationToken !== token) {
      return {
        removePaths: [],
        preservePaths: [data],
        refusedPaths: [{ path: data, reason: "缺少删除工作台数据的显式确认。" }],
        clearAutostart,
        ok: false,
        error: formatInstallerFailure(InstallerErrorCode.CONFIRMATION_REQUIRED, `需要确认令牌 ${token}`)
      };
    }
    removePaths.push(data);
  } else {
    preservePaths.push(data);
  }

  // Install root is removable unless it is nested under protected data (misconfiguration).
  if (isProtectedDataPath(install, data) && !input.confirmDeleteData) {
    refusedPaths.push({
      path: install,
      reason: "安装目录位于受保护的数据目录内，拒绝在未确认时删除。"
    });
    return {
      removePaths: [],
      preservePaths,
      refusedPaths,
      clearAutostart,
      ok: false,
      error: formatInstallerFailure(InstallerErrorCode.UNINSTALL_REFUSED_DATA, install)
    };
  }
  removePaths.push(install);

  for (const raw of input.extraDeletePaths ?? []) {
    const pathValue = raw.trim();
    if (!pathValue) continue;
    if (isProtectedDataPath(pathValue, data) && !input.confirmDeleteData) {
      refusedPaths.push({
        path: pathValue,
        reason: "路径位于工作台数据目录内，卸载默认保留。"
      });
      continue;
    }
    // Project workspaces are outside install/data by design — never delete without confirm.
    const isInstallChild =
      normalizePathForCompare(pathValue) === normalizePathForCompare(install) ||
      normalizePathForCompare(pathValue).startsWith(`${normalizePathForCompare(install)}\\`);
    if (!isInstallChild) {
      const token = input.requiredConfirmationToken ?? "DELETE-WORKBENCH-DATA";
      if (input.confirmationToken !== token) {
        refusedPaths.push({
          path: pathValue,
          reason: "外部 Project 工作区/Artifact 路径需要显式确认才会删除。"
        });
        continue;
      }
    }
    removePaths.push(pathValue);
  }

  if (refusedPaths.length > 0 && (input.extraDeletePaths?.length ?? 0) > 0) {
    return {
      removePaths: removePaths.filter((p) => normalizePathForCompare(p) === normalizePathForCompare(install)),
      preservePaths: [...new Set([...preservePaths, ...refusedPaths.map((r) => r.path)])],
      refusedPaths,
      clearAutostart,
      ok: false,
      error: formatInstallerFailure(
        InstallerErrorCode.UNINSTALL_REFUSED_DATA,
        refusedPaths.map((r) => r.path).join("; ")
      )
    };
  }

  return {
    removePaths: [...new Set(removePaths)],
    preservePaths: [...new Set(preservePaths)],
    refusedPaths,
    clearAutostart,
    ok: true
  };
}
