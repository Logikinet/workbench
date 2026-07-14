import { describe, expect, it } from "vitest";
import {
  AutostartManager,
  buildAutostartLaunchCommand,
  MemoryAutostartStore
} from "./autostart.js";

describe("Windows autostart toggle", () => {
  it("enables and disables the Run-key style autostart entry", async () => {
    const store = new MemoryAutostartStore();
    const manager = new AutostartManager({
      store,
      launchCommand: `"C:\\\\Node\\\\node.exe" "C:\\\\Install\\\\tray\\\\dist\\\\main.js" --autostart-launch`
    });

    expect(await manager.isEnabled()).toBe(false);
    await manager.enable();
    expect(await manager.isEnabled()).toBe(true);
    expect(await store.get("PersonalAIWorkbench")).toContain("--autostart-launch");

    await manager.disable();
    expect(await manager.isEnabled()).toBe(false);
    expect(await store.get("PersonalAIWorkbench")).toBeUndefined();
  });

  it("toggles autostart and reports the new state", async () => {
    const manager = new AutostartManager({
      store: new MemoryAutostartStore(),
      launchCommand: "node tray.js --autostart-launch"
    });
    expect(await manager.toggle()).toBe(true);
    expect(await manager.toggle()).toBe(false);
  });

  it("refuses to enable autostart without a launch command", async () => {
    const manager = new AutostartManager({
      store: new MemoryAutostartStore(),
      launchCommand: "   "
    });
    await expect(manager.enable()).rejects.toThrow(/启动命令为空/);
  });

  it("quotes Windows paths that contain spaces", () => {
    expect(
      buildAutostartLaunchCommand(
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Users\\Ada App\\tray\\main.js"
      )
    ).toBe(
      `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ada App\\tray\\main.js" --autostart-launch`
    );
  });
});
