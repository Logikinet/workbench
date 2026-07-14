/**
 * Open local documents with Microsoft Office / WPS (or OS default) — Task 42.
 * Injectable launchers for tests; production uses Windows start / shell open.
 * Preview layer never rewrites formats; external apps edit the real file.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { ExternalAppKind, ExternalOpenResult, OfficeAvailability } from "./artifactTypes.js";

export interface OfficeOpenOptions {
  /** Absolute path to the document (already safety-resolved). */
  absolutePath: string;
  relativePath: string;
  preferred?: ExternalAppKind;
  /** Injectable platform (default process.platform). */
  platform?: NodeJS.Platform;
  /** Injectable availability probe. */
  detect?: () => Promise<OfficeAvailability> | OfficeAvailability;
  /** Injectable process launcher. */
  launch?: (command: string, args: string[]) => Promise<{ ok: boolean; message: string }>;
}

const OFFICE_CANDIDATES = [
  "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
  "C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE",
  "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE",
  "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE"
];

const WPS_CANDIDATES = [
  "C:\\Users\\Public\\Desktop\\WPS Office.lnk",
  "C:\\Program Files\\Kingsoft\\WPS Office\\ksolaunch.exe",
  "C:\\Program Files (x86)\\Kingsoft\\WPS Office\\ksolaunch.exe"
];

export async function detectOfficeAvailability(
  exists: (path: string) => Promise<boolean> = pathExists
): Promise<OfficeAvailability> {
  let officePath: string | undefined;
  for (const candidate of OFFICE_CANDIDATES) {
    if (await exists(candidate)) {
      officePath = candidate;
      break;
    }
  }
  let wpsPath: string | undefined;
  for (const candidate of WPS_CANDIDATES) {
    if (await exists(candidate)) {
      wpsPath = candidate;
      break;
    }
  }
  const office = Boolean(officePath);
  const wps = Boolean(wpsPath);
  const detail = office || wps
    ? `Office=${office ? "yes" : "no"}; WPS=${wps ? "yes" : "no"}`
    : "Neither Microsoft Office nor WPS was detected on common install paths.";
  return { office, wps, detail, officePath, wpsPath };
}

export async function openWithExternalApp(options: OfficeOpenOptions): Promise<ExternalOpenResult> {
  const preferred = options.preferred ?? "auto";
  const platform = options.platform ?? process.platform;
  const detect = options.detect ?? detectOfficeAvailability;
  const launch = options.launch ?? defaultLaunch;
  const availability = await detect();

  let app: ExternalAppKind | "none" = preferred === "auto" ? "default" : preferred;
  let command = "";
  let args: string[] = [];
  let stub = false;

  if (preferred === "office" && !availability.office) {
    return {
      ok: false,
      relativePath: options.relativePath,
      absolutePath: options.absolutePath,
      app: "none",
      message: "Microsoft Office was not detected. Install Office or choose WPS/default.",
      stub: true
    };
  }
  if (preferred === "wps" && !availability.wps) {
    return {
      ok: false,
      relativePath: options.relativePath,
      absolutePath: options.absolutePath,
      app: "none",
      message: "WPS was not detected. Install WPS or choose Office/default.",
      stub: true
    };
  }

  if (preferred === "office" && availability.officePath) {
    app = "office";
    command = availability.officePath;
    // Prefer generic association via cmd start when we only have one EXE path
    args = [options.absolutePath];
  } else if (preferred === "wps" && availability.wpsPath) {
    app = "wps";
    command = availability.wpsPath;
    args = [options.absolutePath];
  } else if (preferred === "auto") {
    if (availability.office) app = "office";
    else if (availability.wps) app = "wps";
    else app = "default";
  }

  if (platform === "win32") {
    // `cmd /c start "" path` opens with file association (Office/WPS if registered).
    command = "cmd.exe";
    args = ["/c", "start", "", options.absolutePath];
  } else if (platform === "darwin") {
    command = "open";
    args = [options.absolutePath];
  } else {
    command = "xdg-open";
    args = [options.absolutePath];
  }

  try {
    const result = await launch(command, args);
    return {
      ok: result.ok,
      relativePath: options.relativePath,
      absolutePath: options.absolutePath,
      app,
      command: `${command} ${args.map(shellQuote).join(" ")}`,
      message: result.ok
        ? `Opened with ${app} (OS file association / external app).`
        : result.message,
      stub
    };
  } catch (error) {
    // Stub path for sandboxed CI / missing shell — still returns structured result.
    stub = true;
    return {
      ok: false,
      relativePath: options.relativePath,
      absolutePath: options.absolutePath,
      app,
      command: `${command} ${args.map(shellQuote).join(" ")}`,
      message: error instanceof Error ? error.message : String(error),
      stub: true
    };
  }
}

export async function revealInFileManager(options: {
  absolutePath: string;
  relativePath: string;
  platform?: NodeJS.Platform;
  launch?: (command: string, args: string[]) => Promise<{ ok: boolean; message: string }>;
}): Promise<{ ok: boolean; message: string; stub?: boolean; absolutePath: string; relativePath: string }> {
  const platform = options.platform ?? process.platform;
  const launch = options.launch ?? defaultLaunch;
  let command: string;
  let args: string[];

  if (platform === "win32") {
    command = "explorer.exe";
    args = ["/select,", options.absolutePath];
  } else if (platform === "darwin") {
    command = "open";
    args = ["-R", options.absolutePath];
  } else {
    command = "xdg-open";
    args = [options.absolutePath.replace(/[/\\][^/\\]+$/, "") || "."];
  }

  try {
    const result = await launch(command, args);
    return {
      ok: result.ok,
      message: result.ok ? "Revealed in file manager." : result.message,
      absolutePath: options.absolutePath,
      relativePath: options.relativePath
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stub: true,
      absolutePath: options.absolutePath,
      relativePath: options.relativePath
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultLaunch(command: string, args: string[]): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", (error) => {
      resolvePromise({ ok: false, message: error.message });
    });
    // Do not wait for exit — explorers/office stay open.
    child.unref?.();
    resolvePromise({ ok: true, message: "launched" });
  });
}

function shellQuote(value: string): string {
  if (/[\s"]/u.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}
