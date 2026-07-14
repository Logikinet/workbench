import { join } from "node:path";

/** Product short name used for install/data folders and autostart entry. */
export const PRODUCT_NAME = "PersonalAIWorkbench";
export const PRODUCT_DISPLAY_NAME = "Personal AI Workbench";
export const DEFAULT_SERVICE_PORT = 41731;
export const AUTOSTART_VALUE_NAME = "PersonalAIWorkbench";
export const DEFAULT_BIND_HOST = "127.0.0.1";

export interface PathEnvironment {
  localAppData?: string;
  homeDir?: string;
  /** Override install root (e.g. PAW_INSTALL_ROOT). */
  installRoot?: string;
  /** Override data directory (e.g. PAW_DATA_DIR). */
  dataDirectory?: string;
}

/**
 * User-local install root (app binaries/scripts). Never stores Project workspaces.
 * Default: %LOCALAPPDATA%\\Programs\\PersonalAIWorkbench
 */
export function resolveInstallRoot(env: PathEnvironment): string {
  if (env.installRoot && env.installRoot.trim()) return env.installRoot.trim();
  const base = env.localAppData?.trim() || env.homeDir?.trim();
  if (!base) {
    throw new Error(
      "无法解析安装目录：缺少 LOCALAPPDATA 与主目录。请设置 PAW_INSTALL_ROOT 后重试。"
    );
  }
  return join(base, "Programs", PRODUCT_NAME);
}

/**
 * Durable workbench state (indexes, settings). Project workspaces live outside this tree
 * by design and must never be deleted by uninstall without explicit confirmation.
 * Default: %LOCALAPPDATA%\\PersonalAIWorkbench
 */
export function resolveDataDirectory(env: PathEnvironment): string {
  if (env.dataDirectory && env.dataDirectory.trim()) return env.dataDirectory.trim();
  const base = env.localAppData?.trim() || env.homeDir?.trim();
  if (!base) {
    throw new Error(
      "无法解析数据目录：缺少 LOCALAPPDATA 与主目录。请设置 PAW_DATA_DIR 后重试。"
    );
  }
  return join(base, PRODUCT_NAME);
}

export function resolveServiceEntry(installRoot: string): string {
  return join(installRoot, "service", "dist", "main.js");
}

export function resolveWebDist(installRoot: string): string {
  return join(installRoot, "web", "dist");
}

export function resolveTrayEntry(installRoot: string): string {
  return join(installRoot, "tray", "dist", "main.js");
}

export function resolvePidFile(dataDirectory: string): string {
  return join(dataDirectory, "service.pid");
}

export function resolvePwaUrl(port: number = DEFAULT_SERVICE_PORT): string {
  return `http://${DEFAULT_BIND_HOST}:${port}/`;
}

export function resolveServiceUrl(port: number = DEFAULT_SERVICE_PORT): string {
  return `http://${DEFAULT_BIND_HOST}:${port}`;
}

export function resolveInstallGuideUrl(port: number = DEFAULT_SERVICE_PORT): string {
  return `http://${DEFAULT_BIND_HOST}:${port}/#pwa-install-guide`;
}

/** Normalize for case-insensitive Windows path prefix checks. */
export function normalizePathForCompare(pathValue: string): string {
  return pathValue.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * True when `candidate` is the data directory or a path inside it.
 * Used to refuse silent deletion of workbench state / artifacts.
 */
export function isProtectedDataPath(candidate: string, dataDirectory: string): boolean {
  const target = normalizePathForCompare(candidate);
  const protectedRoot = normalizePathForCompare(dataDirectory);
  return target === protectedRoot || target.startsWith(`${protectedRoot}\\`);
}
