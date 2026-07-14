import { describe, expect, it, vi } from "vitest";
import { RuntimeWatchdog, type ManagedRuntimeHandle, type RuntimeProcessController } from "./runtimeWatchdog.js";

function createController(options: {
  failStarts?: number;
  healthFails?: number;
  pidStart?: number;
}): RuntimeProcessController & {
  starts: number;
  stops: number;
  lastHandle: ManagedRuntimeHandle | null;
} {
  let starts = 0;
  let stops = 0;
  let healthCalls = 0;
  let lastHandle: ManagedRuntimeHandle | null = null;
  const pidStart = options.pidStart ?? 1000;
  const failStarts = options.failStarts ?? 0;
  const healthFails = options.healthFails ?? 0;

  return {
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    get lastHandle() {
      return lastHandle;
    },
    async start() {
      starts += 1;
      if (starts <= failStarts) {
        throw new Error("spawn failed");
      }
      const handle: ManagedRuntimeHandle = {
        pid: pidStart + starts,
        async stop() {
          stops += 1;
        }
      };
      lastHandle = handle;
      return handle;
    },
    async probeHealth() {
      healthCalls += 1;
      // Count health probes after a successful spawn only for fail simulation:
      if (healthFails > 0 && healthCalls <= healthFails) {
        return { ok: false, detail: "not ready" };
      }
      return { ok: true, detail: "ok", port: 41731 };
    }
  };
}

describe("RuntimeWatchdog", () => {
  it("starts and waits for health before running; exposes actual port", async () => {
    const controller = createController({ healthFails: 1 });
    const watchdog = new RuntimeWatchdog({
      controller,
      port: 41731,
      sleep: async () => undefined,
      startupTimeoutMs: 5_000,
      healthPollIntervalMs: 1
    });

    const snap = await watchdog.start();
    expect(snap.processState).toBe("running");
    expect(snap.healthOk).toBe(true);
    expect(snap.port).toBe(41731);
    expect(snap.baseUrl).toBe("http://127.0.0.1:41731");
    expect(snap.healthUrl).toBe("http://127.0.0.1:41731/api/health");
    expect(controller.starts).toBe(1);
  });

  it("fails start when health never becomes ok and stops the child", async () => {
    const controller = createController({});
    // Always unhealthy
    controller.probeHealth = async () => ({ ok: false, detail: "down" });

    const watchdog = new RuntimeWatchdog({
      controller,
      sleep: async () => undefined,
      startupTimeoutMs: 20,
      healthPollIntervalMs: 1,
      now: (() => {
        let t = 0;
        return () => {
          t += 10;
          return t;
        };
      })()
    });

    await expect(watchdog.start()).rejects.toThrow(/健康检查/);
    expect(controller.stops).toBe(1);
    expect(watchdog.getSnapshot().processState).toBe("failed");
  });

  it("schedules exponential recovery after unexpected exit and can stop recovery", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const controller = createController({});
    const events: string[] = [];

    const watchdog = new RuntimeWatchdog({
      controller,
      policy: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 15_000 },
      sleep: async () => undefined,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
      now: () => 1_000,
      onEvent: (e) => events.push(e.type)
    });

    await watchdog.start();
    expect(watchdog.getSnapshot().processState).toBe("running");

    watchdog.notifyProcessExit({ code: 1, signal: null });
    expect(watchdog.getSnapshot().recoveryState).toBe("scheduled");
    expect(watchdog.getSnapshot().restartAttempt).toBe(1);
    expect(timers[0]?.ms).toBe(500);
    expect(watchdog.getSnapshot().canStopRecovery).toBe(true);

    const stopped = watchdog.stopRecovery();
    expect(stopped.recoveryState).toBe("stopped-by-user");
    expect(events).toContain("recovery-stopped");

    // Timer should not restart after stop
    const startsBefore = controller.starts;
    timers[0]?.fn();
    await Promise.resolve();
    expect(controller.starts).toBe(startsBefore);
  });

  it("exhausts recovery after maxAttempts", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let healthy = false;
    const controller: RuntimeProcessController = {
      async start() {
        return {
          pid: 1,
          async stop() {
            /* noop */
          }
        };
      },
      async probeHealth() {
        return healthy ? { ok: true, detail: "ok", port: 9 } : { ok: false, detail: "down" };
      }
    };

    const watchdog = new RuntimeWatchdog({
      controller,
      policy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1_000 },
      sleep: async () => undefined,
      startupTimeoutMs: 5,
      healthPollIntervalMs: 1,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
      now: (() => {
        let t = 0;
        return () => {
          t += 10;
          return t;
        };
      })()
    });

    // Directly drive unexpected exit without successful start
    watchdog.notifyProcessExit({ code: 1, signal: null, expected: false });
    expect(watchdog.getSnapshot().restartAttempt).toBe(1);
    expect(timers).toHaveLength(1);

    // attempt 1 fails health → schedules attempt 2
    await timers[0]!.fn();
    // allow microtasks from recoverInBackground
    await vi.waitFor(() => expect(timers.length).toBeGreaterThanOrEqual(2));

    await timers[1]!.fn();
    await vi.waitFor(() => expect(watchdog.getSnapshot().recoveryState).toBe("exhausted"));
    expect(watchdog.getSnapshot().processState).toBe("failed");
    expect(watchdog.getSnapshot().canStopRecovery).toBe(true);
  });

  it("stop() cancels recovery and stops process", async () => {
    const controller = createController({});
    const watchdog = new RuntimeWatchdog({
      controller,
      sleep: async () => undefined
    });
    await watchdog.start();
    const snap = await watchdog.stop();
    expect(snap.processState).toBe("stopped");
    expect(controller.stops).toBe(1);
    expect(snap.port).toBeNull();
  });

  it("does not restart on expected exit", async () => {
    const controller = createController({});
    const watchdog = new RuntimeWatchdog({
      controller,
      sleep: async () => undefined,
      setTimer: () => {
        throw new Error("should not schedule");
      }
    });
    await watchdog.start();
    watchdog.notifyProcessExit({ code: 0, signal: null, expected: true });
    expect(watchdog.getSnapshot().recoveryState).toBe("idle");
    expect(watchdog.getSnapshot().processState).toBe("stopped");
  });
});
