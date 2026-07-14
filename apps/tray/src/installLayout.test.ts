import { describe, expect, it } from "vitest";
import {
  buildTrayHostAutostartCommand,
  packagingTrayHostSources,
  resolveInstalledTraySurface,
  trayStartMenuLaunch,
  TRAY_HOST_LAUNCHER,
  TRAY_HOST_SCRIPT
} from "./installLayout.js";

describe("installed tray surface (S1)", () => {
  const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\PersonalAIWorkbench";

  it("requires TrayHost.ps1 and paths.ps1 under the install root", () => {
    expect(packagingTrayHostSources()).toEqual(["TrayHost.ps1", "paths.ps1"]);
    const surface = resolveInstalledTraySurface(installRoot);
    expect(surface.trayHostScript).toBe(`${installRoot}\\${TRAY_HOST_SCRIPT}`);
    expect(surface.pathsScript).toBe(`${installRoot}\\paths.ps1`);
    expect(surface.trayHostLauncher).toBe(`${installRoot}\\${TRAY_HOST_LAUNCHER}`);
  });

  it("points the Start Menu Tray shortcut at the NotifyIcon launcher, not CLI status", () => {
    const launch = trayStartMenuLaunch(installRoot);
    expect(launch.target).toBe(`${installRoot}\\${TRAY_HOST_LAUNCHER}`);
    expect(launch.arguments).not.toMatch(/status/i);
    expect(launch.target).not.toMatch(/paw-tray\.cmd$/i);
  });

  it("builds an autostart command that launches the tray host UI", () => {
    expect(buildTrayHostAutostartCommand(installRoot)).toBe(
      `${installRoot}\\${TRAY_HOST_LAUNCHER}`
    );
    expect(
      buildTrayHostAutostartCommand("C:\\Program Files\\PersonalAIWorkbench")
    ).toBe(`"C:\\Program Files\\PersonalAIWorkbench\\${TRAY_HOST_LAUNCHER}"`);
  });
});
