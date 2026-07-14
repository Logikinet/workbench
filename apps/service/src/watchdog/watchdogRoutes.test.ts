import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createWatchdogRouteApp } from "./watchdogRoutes.js";
import { WatchdogService } from "./watchdogService.js";
import { RuntimeWatchdog, type RuntimeProcessController } from "./runtimeWatchdog.js";
import { WATCHDOG_OPERATION_CONTRACT } from "./watchdogTypes.js";

function healthyController(): RuntimeProcessController {
  return {
    async start() {
      return { pid: 42, async stop() {} };
    },
    async probeHealth() {
      return { ok: true, detail: "ok", port: 41731 };
    }
  };
}

describe("watchdog routes", () => {
  it("exposes contract and runtime status with discovered port", async () => {
    const runtime = new RuntimeWatchdog({
      controller: healthyController(),
      sleep: async () => undefined
    });
    await runtime.start();
    const watchdog = new WatchdogService({ runtime });
    const app = createWatchdogRouteApp({ watchdog });

    const contract = await request(app).get("/api/watchdog/contract");
    expect(contract.status).toBe(200);
    expect(contract.body.name).toBe(WATCHDOG_OPERATION_CONTRACT.name);

    const status = await request(app).get("/api/watchdog/runtime");
    expect(status.status).toBe(200);
    expect(status.body.processState).toBe("running");
    expect(status.body.port).toBe(41731);
    expect(status.body.baseUrl).toBe("http://127.0.0.1:41731");
    expect(status.body.healthUrl).toContain("/api/health");
  });

  it("stops and resets recovery via POST", async () => {
    const timers: Array<() => void> = [];
    const runtime = new RuntimeWatchdog({
      controller: healthyController(),
      sleep: async () => undefined,
      policy: { maxAttempts: 5 },
      setTimer: (fn) => {
        timers.push(fn);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
      now: () => 0
    });
    await runtime.start();
    runtime.notifyProcessExit({ code: 1, signal: null });

    const watchdog = new WatchdogService({ runtime });
    const app = createWatchdogRouteApp({ watchdog });

    const stop = await request(app).post("/api/watchdog/recovery/stop");
    expect(stop.status).toBe(200);
    expect(stop.body.recoveryState).toBe("stopped-by-user");

    const reset = await request(app).post("/api/watchdog/recovery/reset");
    expect(reset.status).toBe(200);
    expect(reset.body.recoveryState).toBe("idle");
    expect(reset.body.restartAttempt).toBe(0);
  });

  it("returns blocked update snapshot when coordinator missing", async () => {
    const runtime = new RuntimeWatchdog({
      controller: healthyController(),
      sleep: async () => undefined
    });
    const watchdog = new WatchdogService({ runtime });
    const app = createWatchdogRouteApp({ watchdog });

    const update = await request(app).get("/api/watchdog/update");
    expect(update.status).toBe(200);
    expect(update.body.status).toBe("blocked");
  });

  it("mark-healthy requires version body", async () => {
    const runtime = new RuntimeWatchdog({
      controller: healthyController(),
      sleep: async () => undefined
    });
    const markHealthy = vi.fn(async (version: string) => ({
      generatedAt: new Date().toISOString(),
      status: "idle" as const,
      channel: "stable",
      launcherVersion: "0.1.0",
      currentVersion: version,
      lastKnownGoodVersion: version,
      candidateVersion: null,
      availableVersion: null,
      downloadedVersion: null,
      releaseNotesUrl: null,
      lastCheckedAt: null,
      progress: null,
      canCheck: false,
      canDownload: false,
      canApply: false,
      requiresRestart: false,
      badVersions: [],
      blockReason: null,
      errorMessage: null,
      detail: "ok"
    }));

    const watchdog = {
      contract: () => WATCHDOG_OPERATION_CONTRACT,
      runtimeStatus: async () => runtime.getSnapshot(),
      stopRecovery: () => runtime.stopRecovery(),
      resetRecovery: () => runtime.resetRecovery(),
      updateSnapshot: () => ({ status: "idle" }),
      checkForUpdates: async () => ({ status: "idle" }),
      downloadUpdate: async () => ({ status: "idle" }),
      applyUpdate: async () => ({ status: "idle" }),
      markHealthy,
      recoverCandidate: async () => ({ status: "idle" }),
      failCandidate: async () => ({ status: "idle" })
    };

    const app = createWatchdogRouteApp({ watchdog: watchdog as unknown as WatchdogService });
    const bad = await request(app).post("/api/watchdog/bundle/mark-healthy").send({});
    expect(bad.status).toBe(400);

    const ok = await request(app).post("/api/watchdog/bundle/mark-healthy").send({ version: "1.2.3" });
    expect(ok.status).toBe(200);
    expect(markHealthy).toHaveBeenCalledWith("1.2.3");
  });
});
