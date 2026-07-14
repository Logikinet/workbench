/**
 * Runtime process recovery watchdog.
 *
 * Control plane (Tray/Launcher) owns this; Agent Service crash must not kill it.
 * Unexpected exits: limited exponential backoff restarts + one-click stop recovery.
 * Successful start always requires waitForHealth before "running".
 */

import {
  DEFAULT_RESTART_POLICY,
  type RuntimeProcessExitInfo,
  type WatchdogProcessState,
  type WatchdogRecoveryState,
  type WatchdogRestartPolicy,
  type WatchdogRuntimeSnapshot
} from "./watchdogTypes.js";
import { canAttemptRestart, computeRuntimeRestartDelayMs, nextRestartAttempt } from "./restartPolicy.js";

export interface HealthProbeResult {
  ok: boolean;
  detail: string;
  /** Optional discovered port from health payload (overrides configured port). */
  port?: number;
}

export interface ManagedRuntimeHandle {
  readonly pid?: number;
  /** Request graceful stop; watchdog does not kill the control plane. */
  stop(): Promise<void>;
}

export interface RuntimeProcessController {
  /**
   * Start Agent Service for the given bind host/port.
   * Must not throw after spawning without cleaning up — prefer throwing only on hard spawn failure.
   */
  start(options: { host: string; port: number }): Promise<ManagedRuntimeHandle>;
  /**
   * Probe health endpoint. Used after start and for status.
   */
  probeHealth(options: { host: string; port: number; timeoutMs?: number }): Promise<HealthProbeResult>;
}

export interface RuntimeWatchdogOptions {
  controller: RuntimeProcessController;
  bindHost?: string;
  /** Preferred port; actual port is confirmed via health. */
  port?: number;
  policy?: Partial<WatchdogRestartPolicy>;
  startupTimeoutMs?: number;
  healthPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  onEvent?: (event: RuntimeWatchdogEvent) => void;
}

export type RuntimeWatchdogEvent =
  | { type: "started"; pid: number | null; port: number }
  | { type: "health-ok"; port: number }
  | { type: "exit"; info: RuntimeProcessExitInfo }
  | { type: "recovery-scheduled"; attempt: number; delayMs: number }
  | { type: "recovery-attempt"; attempt: number }
  | { type: "recovery-stopped" }
  | { type: "recovery-exhausted"; attempts: number }
  | { type: "error"; message: string };

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 41731;

export class RuntimeWatchdog {
  private readonly host: string;
  private readonly preferredPort: number;
  private readonly policy: WatchdogRestartPolicy;
  private readonly startupTimeoutMs: number;
  private readonly healthPollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly onEvent?: (event: RuntimeWatchdogEvent) => void;

  private processState: WatchdogProcessState = "stopped";
  private recoveryState: WatchdogRecoveryState = "idle";
  private handle: ManagedRuntimeHandle | null = null;
  private actualPort: number | null = null;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRestartAt: string | null = null;
  private lastExit: RuntimeProcessExitInfo | null = null;
  private lastError: string | null = null;
  private stopping = false;
  /** Child exits during intentional stop/start-fail must not trigger recovery. */
  private suppressRestartForHandle: ManagedRuntimeHandle | null = null;

  constructor(private readonly options: RuntimeWatchdogOptions) {
    this.host = options.bindHost ?? DEFAULT_HOST;
    this.preferredPort = options.port ?? DEFAULT_PORT;
    this.policy = { ...DEFAULT_RESTART_POLICY, ...options.policy };
    this.startupTimeoutMs = options.startupTimeoutMs ?? 25_000;
    this.healthPollIntervalMs = options.healthPollIntervalMs ?? 350;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.onEvent = options.onEvent;
  }

  /**
   * Start Agent Service and wait for health. Does not arm recovery until running.
   */
  async start(): Promise<WatchdogRuntimeSnapshot> {
    if (this.processState === "running" && this.handle) {
      const health = await this.probe();
      if (health.ok) {
        return this.snapshot("服务已在运行");
      }
    }

    this.stopping = false;
    this.restartAttempt = 0;
    this.clearRestartTimer();
    this.recoveryState = "idle";
    this.lastError = null;

    await this.startOnce({ reason: "manual-start" });
    return this.snapshot("服务已启动并通过健康检查");
  }

  /**
   * Stop Agent Service and cancel any recovery loop (one-click stop recovery).
   */
  async stop(): Promise<WatchdogRuntimeSnapshot> {
    this.stopping = true;
    this.clearRestartTimer();
    this.recoveryState = this.recoveryState === "scheduled" || this.recoveryState === "attempting"
      ? "stopped-by-user"
      : "idle";
    this.nextRestartAt = null;
    this.onEvent?.({ type: "recovery-stopped" });

    const handle = this.handle;
    this.processState = "stopping";
    if (handle) {
      this.suppressRestartForHandle = handle;
      try {
        await handle.stop();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.handle = null;
    this.actualPort = null;
    this.processState = "stopped";
    return this.snapshot("服务已停止；自动恢复循环已取消");
  }

  /**
   * One-click stop of the recovery loop without necessarily stopping a healthy process.
   * If currently recovering/scheduled, cancels timers; if a start is mid-flight, marks stop.
   */
  stopRecovery(): WatchdogRuntimeSnapshot {
    this.clearRestartTimer();
    this.stopping = true;
    if (this.recoveryState === "scheduled" || this.recoveryState === "attempting" || this.recoveryState === "exhausted") {
      this.recoveryState = "stopped-by-user";
    }
    this.nextRestartAt = null;
    this.onEvent?.({ type: "recovery-stopped" });
    return this.snapshot("已停止自动恢复循环");
  }

  /**
   * Clear exhausted / user-stopped recovery so future exits can schedule again.
   */
  resetRecovery(): WatchdogRuntimeSnapshot {
    this.stopping = false;
    this.restartAttempt = 0;
    this.clearRestartTimer();
    this.recoveryState = "idle";
    this.nextRestartAt = null;
    this.lastError = null;
    return this.snapshot("恢复状态已重置");
  }

  /**
   * Notify watchdog that the managed process exited (from tray/process manager exit hook).
   */
  notifyProcessExit(info: Omit<RuntimeProcessExitInfo, "expected"> & { expected?: boolean }): void {
    const expected = info.expected ?? this.stopping;
    const exitInfo: RuntimeProcessExitInfo = {
      code: info.code,
      signal: info.signal,
      expected
    };
    this.lastExit = exitInfo;
    this.onEvent?.({ type: "exit", info: exitInfo });

    const handle = this.handle;
    this.handle = null;
    this.actualPort = null;

    // Only suppress when we have a concrete handle that was intentionally stopped.
    // (null === null must not suppress recovery after an unexpected crash.)
    if (expected || (handle != null && this.suppressRestartForHandle === handle)) {
      this.suppressRestartForHandle = null;
      if (this.processState !== "stopped" && this.processState !== "failed") {
        this.processState = "stopped";
      }
      return;
    }

    this.processState = "recovering";
    void this.scheduleRestart(exitInfo);
  }

  async status(): Promise<WatchdogRuntimeSnapshot> {
    if (this.handle && this.processState === "running") {
      const health = await this.probe();
      if (!health.ok) {
        return this.snapshot(`进程在管但健康检查失败：${health.detail}`);
      }
      return this.snapshot("服务在线");
    }
    return this.snapshot(this.defaultDetail());
  }

  getSnapshot(): WatchdogRuntimeSnapshot {
    return this.snapshot(this.defaultDetail());
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async startOnce(meta: { reason: string }): Promise<void> {
    this.processState = "starting";
    const port = this.preferredPort;
    let handle: ManagedRuntimeHandle;
    try {
      handle = await this.options.controller.start({ host: this.host, port });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.processState = "failed";
      this.onEvent?.({ type: "error", message });
      throw new Error(`无法启动 Agent Service：${message}`);
    }

    this.handle = handle;
    this.onEvent?.({ type: "started", pid: handle.pid ?? null, port });

    try {
      const health = await this.waitForHealth(port);
      if (!health.ok) {
        throw new Error(health.detail);
      }
      this.actualPort = health.port ?? port;
      this.processState = "running";
      this.restartAttempt = 0;
      this.recoveryState = "idle";
      this.lastError = null;
      this.onEvent?.({ type: "health-ok", port: this.actualPort });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.suppressRestartForHandle = handle;
      try {
        await handle.stop();
      } catch {
        // ignore stop errors after failed health
      }
      if (this.handle === handle) {
        this.handle = null;
      }
      this.actualPort = null;
      this.processState = "failed";
      this.onEvent?.({ type: "error", message: `health gate failed (${meta.reason}): ${message}` });
      throw new Error(`服务启动未通过健康检查：${message}`);
    }
  }

  private async waitForHealth(port: number): Promise<HealthProbeResult> {
    const deadline = this.now() + this.startupTimeoutMs;
    let last: HealthProbeResult = { ok: false, detail: "not started" };
    while (this.now() < deadline) {
      if (this.stopping) {
        return { ok: false, detail: "startup aborted (recovery stopped)" };
      }
      last = await this.options.controller.probeHealth({
        host: this.host,
        port,
        timeoutMs: Math.min(1_500, this.startupTimeoutMs)
      });
      if (last.ok) return last;
      await this.sleep(this.healthPollIntervalMs);
    }
    return {
      ok: false,
      detail: `health timeout after ${this.startupTimeoutMs}ms: ${last.detail}`
    };
  }

  private async probe(): Promise<HealthProbeResult> {
    const port = this.actualPort ?? this.preferredPort;
    return this.options.controller.probeHealth({ host: this.host, port, timeoutMs: 1_500 });
  }

  private async scheduleRestart(info: RuntimeProcessExitInfo): Promise<void> {
    if (this.stopping) {
      this.recoveryState = "stopped-by-user";
      return;
    }
    if (this.restartTimer) return;

    const attempt = nextRestartAttempt(this.restartAttempt);
    if (!canAttemptRestart(attempt, this.policy)) {
      this.recoveryState = "exhausted";
      this.processState = "failed";
      this.lastError = `automatic recovery exhausted after ${this.policy.maxAttempts} attempts`;
      this.onEvent?.({ type: "recovery-exhausted", attempts: this.policy.maxAttempts });
      return;
    }

    this.restartAttempt = attempt;
    const delayMs = computeRuntimeRestartDelayMs(attempt, this.policy);
    this.recoveryState = "scheduled";
    this.processState = "recovering";
    this.nextRestartAt = new Date(this.now() + delayMs).toISOString();
    this.onEvent?.({ type: "recovery-scheduled", attempt, delayMs });
    this.onEvent?.({
      type: "error",
      message: `scheduling recovery attempt ${attempt} in ${delayMs}ms after exit code=${String(info.code)} signal=${String(info.signal)}`
    });

    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      this.nextRestartAt = null;
      void this.recoverInBackground();
    }, delayMs);
  }

  private async recoverInBackground(): Promise<void> {
    if (this.stopping) {
      this.recoveryState = "stopped-by-user";
      return;
    }
    this.recoveryState = "attempting";
    this.onEvent?.({ type: "recovery-attempt", attempt: this.restartAttempt });
    try {
      await this.startOnce({ reason: `auto-recovery-${this.restartAttempt}` });
      this.recoveryState = "idle";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      await this.scheduleRestart({
        code: null,
        signal: null,
        expected: false
      });
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    this.nextRestartAt = null;
  }

  private defaultDetail(): string {
    if (this.recoveryState === "exhausted") return "自动恢复次数已耗尽；请手动检查日志后 reset recovery";
    if (this.recoveryState === "stopped-by-user") return "自动恢复已被用户停止";
    if (this.recoveryState === "scheduled") return `已计划自动恢复（attempt ${this.restartAttempt}）`;
    if (this.recoveryState === "attempting") return `正在自动恢复（attempt ${this.restartAttempt}）`;
    if (this.processState === "running") return "服务在线";
    if (this.processState === "starting") return "服务启动中";
    if (this.processState === "failed") return this.lastError ?? "服务启动失败";
    return "服务已停止";
  }

  private snapshot(detail: string): WatchdogRuntimeSnapshot {
    const port = this.actualPort;
    const baseUrl = port != null ? `http://${this.host}:${port}` : null;
    const healthUrl = baseUrl ? `${baseUrl}/api/health` : null;
    const canStopRecovery =
      this.recoveryState === "scheduled" ||
      this.recoveryState === "attempting" ||
      this.recoveryState === "exhausted";

    return {
      generatedAt: new Date(this.now()).toISOString(),
      processState: this.processState,
      recoveryState: this.recoveryState,
      pid: this.handle?.pid ?? null,
      port,
      bindHost: this.host,
      baseUrl,
      healthUrl,
      healthOk: this.processState === "running" && port != null,
      restartAttempt: this.restartAttempt,
      maxAttempts: this.policy.maxAttempts,
      nextRestartAt: this.nextRestartAt,
      lastExit: this.lastExit,
      lastError: this.lastError,
      canStopRecovery,
      detail
    };
  }
}
