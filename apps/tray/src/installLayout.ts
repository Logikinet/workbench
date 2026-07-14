import { join } from "node:path";

/**
 * Files that the Windows installer must deploy for a real NotifyIcon tray UI.
 * Pure list used by tests so packaging stays honest about the post-install surface.
 */
export const TRAY_HOST_SCRIPT = "TrayHost.ps1";
export const TRAY_HOST_PATHS_SCRIPT = "paths.ps1";
export const TRAY_HOST_LAUNCHER = "start-tray-host.cmd";
export const TRAY_CLI_LAUNCHER = "paw-tray.cmd";

export interface InstalledTraySurface {
  /** PowerShell NotifyIcon host (persistent system tray). */
  trayHostScript: string;
  /** Shared path helpers required by TrayHost.ps1. */
  pathsScript: string;
  /** CMD launcher for Start Menu / autostart (WindowStyle Hidden). */
  trayHostLauncher: string;
  /** One-shot CLI for scripting (start/stop/status/…). */
  trayCliLauncher: string;
}

export function resolveInstalledTraySurface(installRoot: string): InstalledTraySurface {
  return {
    trayHostScript: join(installRoot, TRAY_HOST_SCRIPT),
    pathsScript: join(installRoot, TRAY_HOST_PATHS_SCRIPT),
    trayHostLauncher: join(installRoot, TRAY_HOST_LAUNCHER),
    trayCliLauncher: join(installRoot, TRAY_CLI_LAUNCHER)
  };
}

/** Packaging source files relative to packaging/windows/. */
export function packagingTrayHostSources(): string[] {
  return [TRAY_HOST_SCRIPT, TRAY_HOST_PATHS_SCRIPT];
}

/**
 * Start Menu "Tray" shortcut must launch the NotifyIcon host, not a one-shot CLI status.
 */
export function trayStartMenuLaunch(installRoot: string): { target: string; arguments: string } {
  const surface = resolveInstalledTraySurface(installRoot);
  return {
    target: surface.trayHostLauncher,
    arguments: ""
  };
}

/**
 * Autostart should relaunch the NotifyIcon host (which starts the service), not only CLI --autostart-launch.
 */
export function buildTrayHostAutostartCommand(installRoot: string): string {
  const launcher = resolveInstalledTraySurface(installRoot).trayHostLauncher;
  if (!/[ \t"]/u.test(launcher)) return launcher;
  return `"${launcher.replace(/"/g, '\\"')}"`;
}
