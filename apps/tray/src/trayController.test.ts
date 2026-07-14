import { describe, expect, it, vi } from "vitest";
import { AutostartManager, MemoryAutostartStore } from "./autostart.js";
import type { ProcessManager, ServiceStatus } from "./processManager.js";
import { TrayController } from "./trayController.js";

function fakeStatus(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    state: "running",
    pid: 1,
    port: 41731,
    healthOk: true,
    detail: "服务在线",
    ...overrides
  };
}

function createController(overrides: {
  processManager?: Partial<ProcessManager>;
  emergencyStop?: ReturnType<typeof vi.fn>;
  browserOpen?: ReturnType<typeof vi.fn>;
  onQuit?: () => void;
} = {}) {
  const processManager = {
    start: vi.fn(async () => fakeStatus({ detail: "started" })),
    stop: vi.fn(async () => fakeStatus({ state: "stopped", healthOk: false, detail: "stopped" })),
    restart: vi.fn(async () => fakeStatus({ detail: "restarted" })),
    status: vi.fn(async () => fakeStatus()),
    ...overrides.processManager
  } as unknown as ProcessManager;

  const browserOpen = overrides.browserOpen ?? vi.fn(async () => undefined);
  const emergencyStop =
    overrides.emergencyStop ??
    vi.fn(async () => ({
      summary: "stop",
      results: [],
      stopped: 2,
      failed: 0,
      skipped: 1
    }));

  const controller = new TrayController({
    processManager,
    autostart: new AutostartManager({
      store: new MemoryAutostartStore(),
      launchCommand: "node tray.js --autostart-launch"
    }),
    browser: { open: browserOpen },
    serviceUrl: "http://127.0.0.1:41731",
    port: 41731,
    onQuit: overrides.onQuit,
    emergencyStop: emergencyStop as never
  });

  return { controller, processManager, browserOpen, emergencyStop };
}

describe("tray controller menu actions", () => {
  it("exposes the required tray menu actions", () => {
    const actions = TrayController.menuItems().map((item) => item.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "start",
        "stop",
        "restart",
        "emergency-stop",
        "open-pwa",
        "open-guide",
        "autostart-toggle",
        "quit"
      ])
    );
  });

  it("starts stops and restarts the service", async () => {
    const { controller, processManager } = createController();
    await expect(controller.handle("start")).resolves.toMatchObject({ ok: true, message: "started" });
    await expect(controller.handle("stop")).resolves.toMatchObject({ ok: true, message: "stopped" });
    await expect(controller.handle("restart")).resolves.toMatchObject({
      ok: true,
      message: "restarted"
    });
    expect(processManager.start).toHaveBeenCalledOnce();
    expect(processManager.stop).toHaveBeenCalledOnce();
    expect(processManager.restart).toHaveBeenCalledOnce();
  });

  it("invokes emergency stop-all against the local service", async () => {
    const { controller, emergencyStop } = createController();
    const result = await controller.handle("emergency-stop");
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/停止 2/);
    expect(emergencyStop).toHaveBeenCalledWith({
      serviceUrl: "http://127.0.0.1:41731",
      summary: "托盘紧急停止：停止全部任务。"
    });
  });

  it("opens the loopback PWA and install guide URLs", async () => {
    const { controller, browserOpen } = createController();
    await controller.handle("open-pwa");
    await controller.handle("open-guide");
    expect(browserOpen).toHaveBeenNthCalledWith(1, "http://127.0.0.1:41731/");
    expect(browserOpen).toHaveBeenNthCalledWith(2, "http://127.0.0.1:41731/#pwa-install-guide");
  });

  it("toggles autostart on and off", async () => {
    const { controller } = createController();
    await expect(controller.handle("autostart-on")).resolves.toMatchObject({
      ok: true,
      autostartEnabled: true
    });
    await expect(controller.handle("autostart-off")).resolves.toMatchObject({
      ok: true,
      autostartEnabled: false
    });
    await expect(controller.handle("autostart-toggle")).resolves.toMatchObject({
      ok: true,
      autostartEnabled: true
    });
  });

  it("returns process errors as actionable tray messages without throwing", async () => {
    const { controller } = createController({
      processManager: {
        start: vi.fn(async () => {
          throw new Error("无法启动本地 Agent Service。请确认 Node.js 与 service 构建产物可用。");
        })
      }
    });
    const result = await controller.handle("start");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/无法启动本地 Agent Service/);
  });

  it("invokes onQuit when the user chooses quit", async () => {
    const onQuit = vi.fn();
    const { controller } = createController({ onQuit });
    await controller.handle("quit");
    expect(onQuit).toHaveBeenCalledOnce();
  });
});
