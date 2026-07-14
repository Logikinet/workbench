import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskType } from "../planning/planningService.js";
import type { Run, RunService, RunStatus } from "../runs/runService.js";
import {
  ResourceGuardService,
  type ResourceAdmission,
  type ResourceSnapshot
} from "./resourceGuardService.js";

export type ExecutionLane = "write" | "readonly";

export interface QueueConfig {
  /** Max concurrent write agents that are not worktree-isolated (default 1). */
  maxWriteParallel: number;
  /** Max concurrent read-only / research agents (default 2). */
  maxReadOnlyParallel: number;
  /**
   * Max concurrent worktree-isolated write agents for the same project.
   * Same-project write parallelism is only allowed when isolation conditions are met.
   */
  maxIsolatedSameProjectWriteParallel: number;
  /** Soft execution timeout; agents are interrupted when exceeded (ms). */
  executionTimeoutMs: number;
  /**
   * Same-step consecutive failure ceiling applied as `Run.execution.maxConsecutiveFailures`.
   * When a step fails this many times in a row the Run pauses (e.g. 2 → pause on the 2nd failure).
   */
  maxRetries: number;
  minFreeDiskBytes: number;
  minFreeMemoryBytes: number;
}

export interface QueueConfigUpdate {
  maxWriteParallel?: number;
  maxReadOnlyParallel?: number;
  maxIsolatedSameProjectWriteParallel?: number;
  executionTimeoutMs?: number;
  maxRetries?: number;
  minFreeDiskBytes?: number;
  minFreeMemoryBytes?: number;
}

export interface QueueLeaseRequest {
  runId: string;
  todoId: string;
  projectId?: string;
  taskType?: TaskType;
  /** True when the agent is limited to read_only workspace permissions. */
  readOnlyPermissions?: boolean;
  /**
   * True when this write execution will use isolated Git worktree isolation
   * (Codex on a Git Project). Required for same-project write parallelism.
   */
  worktreeIsolated?: boolean;
}

export interface QueueLease {
  runId: string;
  lane: ExecutionLane;
  projectId?: string;
  worktreeIsolated: boolean;
  acquiredAt: string;
  timeoutMs: number;
}

export type QueueAdmissionDecision =
  | { allowed: true; lease: QueueLease; resource: ResourceAdmission }
  | { allowed: false; reason: string; code: "resource" | "concurrency"; resource?: ResourceAdmission };

export interface QueueStatus {
  config: QueueConfig;
  active: QueueLease[];
  writeCount: number;
  readOnlyCount: number;
  resource?: ResourceSnapshot;
  newTasksPaused: boolean;
  pauseReason?: string;
}

export interface StopAllProcessResult {
  runId: string;
  todoId: string;
  previousStatus: RunStatus;
  outcome: "cancelled" | "paused" | "skipped" | "error";
  processTerminated: boolean | null;
  message: string;
}

export interface StopAllResult {
  summary: string;
  results: StopAllProcessResult[];
  stopped: number;
  failed: number;
  skipped: number;
}

interface QueueState {
  schemaVersion: 1;
  config: QueueConfig;
}

export interface RunQueueServiceOptions {
  statePath: string;
  resourceGuard: ResourceGuardService;
  runs: Pick<RunService, "get" | "listAll" | "stop" | "transition">;
  /** Optional clock for tests. */
  now?: () => Date;
  /** Optional timeout scheduler for tests. */
  scheduleTimeout?: (runId: string, ms: number, fire: () => void) => () => void;
  /** Called when an execution lease times out. */
  onTimeout?: (runId: string, reason: string) => Promise<void> | void;
}

export const defaultQueueConfig = (): QueueConfig => ({
  maxWriteParallel: 1,
  maxReadOnlyParallel: 2,
  maxIsolatedSameProjectWriteParallel: 2,
  executionTimeoutMs: 30 * 60 * 1000,
  maxRetries: 2,
  minFreeDiskBytes: 512 * 1024 * 1024,
  minFreeMemoryBytes: 256 * 1024 * 1024
});

const stoppableStatuses = new Set<RunStatus>([
  "created",
  "planning",
  "awaiting_plan_approval",
  "queued",
  "running",
  "paused",
  "awaiting_review",
  "awaiting_acceptance",
  "failed",
  "interrupted"
]);

/** Coordinates concurrency, resource admission, timeouts, and stop-all. */
export class RunQueueService {
  private readonly active = new Map<string, QueueLease>();
  private readonly timeoutCleanups = new Map<string, () => void>();
  private config: QueueConfig;
  private newTasksPaused = false;
  private pauseReason?: string;
  private readonly now: () => Date;
  private readonly scheduleTimeout: (runId: string, ms: number, fire: () => void) => () => void;

  private constructor(
    private readonly options: RunQueueServiceOptions,
    state: QueueState
  ) {
    this.config = state.config;
    this.now = options.now ?? (() => new Date());
    this.scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
    this.options.resourceGuard.setLimits({
      minFreeDiskBytes: this.config.minFreeDiskBytes,
      minFreeMemoryBytes: this.config.minFreeMemoryBytes
    });
  }

  static async open(options: RunQueueServiceOptions): Promise<RunQueueService> {
    const defaults = defaultQueueConfig();
    try {
      const decoded = JSON.parse(await readFile(options.statePath, "utf8")) as Partial<QueueState>;
      if (decoded.schemaVersion !== 1 || !decoded.config || typeof decoded.config !== "object") {
        throw new Error("Queue state is not compatible with this service version.");
      }
      const config = normalizeConfig({ ...defaults, ...decoded.config });
      return new RunQueueService(options, { schemaVersion: 1, config });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return new RunQueueService(options, { schemaVersion: 1, config: defaults });
      }
      throw error;
    }
  }

  getConfig(): QueueConfig {
    return { ...this.config };
  }

  async updateConfig(update: QueueConfigUpdate): Promise<QueueConfig> {
    const next = normalizeConfig({ ...this.config, ...sanitizeUpdate(update) });
    this.config = next;
    this.options.resourceGuard.setLimits({
      minFreeDiskBytes: next.minFreeDiskBytes,
      minFreeMemoryBytes: next.minFreeMemoryBytes
    });
    await this.persist();
    return this.getConfig();
  }

  async status(): Promise<QueueStatus> {
    // Recompute pause flag from live resources so the operator banner matches free disk/memory.
    const admission = await this.options.resourceGuard.admitNewTask();
    if (admission.allowed) {
      this.newTasksPaused = false;
      this.pauseReason = undefined;
    } else {
      this.newTasksPaused = true;
      this.pauseReason = admission.reason;
    }
    const resource = admission.snapshot;
    const active = [...this.active.values()];
    return {
      config: this.getConfig(),
      active,
      writeCount: active.filter((lease) => lease.lane === "write").length,
      readOnlyCount: active.filter((lease) => lease.lane === "readonly").length,
      resource,
      newTasksPaused: this.newTasksPaused,
      pauseReason: this.pauseReason
    };
  }

  classify(request: QueueLeaseRequest): ExecutionLane {
    if (request.readOnlyPermissions) return "readonly";
    if (request.taskType === "research" || request.taskType === "analysis") return "readonly";
    return "write";
  }

  async admit(request: QueueLeaseRequest): Promise<QueueAdmissionDecision> {
    if (this.active.has(request.runId)) {
      return {
        allowed: false,
        reason: "This Run already holds an execution queue lease.",
        code: "concurrency"
      };
    }

    const resource = await this.options.resourceGuard.admitNewTask();
    if (!resource.allowed) {
      this.newTasksPaused = true;
      this.pauseReason = resource.reason;
      return { allowed: false, reason: resource.reason ?? "资源不足，已暂停新任务。", code: "resource", resource };
    }
    this.newTasksPaused = false;
    this.pauseReason = undefined;

    const lane = this.classify(request);
    const concurrencyReason = this.concurrencyBlockReason(request, lane);
    if (concurrencyReason) {
      return { allowed: false, reason: concurrencyReason, code: "concurrency", resource };
    }

    const lease: QueueLease = {
      runId: request.runId,
      lane,
      projectId: request.projectId,
      worktreeIsolated: request.worktreeIsolated === true && lane === "write",
      acquiredAt: this.now().toISOString(),
      timeoutMs: this.config.executionTimeoutMs
    };
    this.active.set(request.runId, lease);
    this.armTimeout(lease);
    return { allowed: true, lease, resource };
  }

  release(runId: string): void {
    this.clearTimeout(runId);
    this.active.delete(runId);
  }

  hasLease(runId: string): boolean {
    return this.active.has(runId);
  }

  getLease(runId: string): QueueLease | undefined {
    return this.active.get(runId);
  }

  /**
   * Consecutive same-step failure ceiling applied when an execution begins
   * (`Run.execution.maxConsecutiveFailures`).
   */
  configuredMaxRetries(): number {
    return this.config.maxRetries;
  }

  async stopAll(summary = "用户一键停止全部 Run。"): Promise<StopAllResult> {
    const normalized = summary.trim() || "用户一键停止全部 Run。";
    const runs = await this.options.runs.listAll();
    // Terminal completed/cancelled runs are excluded by stoppableStatuses.
    const targets = runs.filter((run) => stoppableStatuses.has(run.status));
    const results: StopAllProcessResult[] = [];

    for (const run of targets) {
      const previousStatus = run.status;
      const hadActiveLease = this.active.has(run.id);
      const hadRunningProcess = run.execution.status === "running" || hadActiveLease;
      try {
        const stopped = await this.options.runs.stop(run.id, normalized);
        this.release(run.id);
        const processTerminated = hadRunningProcess
          ? stopped.execution.terminationUnconfirmed !== true
          : null;
        if (stopped.status === "cancelled") {
          results.push({
            runId: run.id,
            todoId: run.todoId,
            previousStatus,
            outcome: "cancelled",
            processTerminated,
            message: processTerminated === false
              ? "Run 已请求停止，但进程终止未确认，已保持保护状态。"
              : "Run 已取消；关联进程已终止。"
          });
        } else if (stopped.status === "paused") {
          results.push({
            runId: run.id,
            todoId: run.todoId,
            previousStatus,
            outcome: "paused",
            processTerminated: processTerminated === true,
            message: stopped.execution.terminationUnconfirmed
              ? "停止未确认进程已终止；Run 保持暂停。"
              : "Run 已暂停。"
          });
        } else {
          results.push({
            runId: run.id,
            todoId: run.todoId,
            previousStatus,
            outcome: "error",
            processTerminated,
            message: `停止后状态为 ${stopped.status}。`
          });
        }
      } catch (error) {
        this.release(run.id);
        const message = error instanceof Error ? error.message : "停止 Run 失败。";
        // Termination-unconfirmed runs must stay paused — surface that clearly.
        if (/未确认|termination/i.test(message)) {
          results.push({
            runId: run.id,
            todoId: run.todoId,
            previousStatus,
            outcome: "paused",
            processTerminated: false,
            message
          });
        } else {
          results.push({
            runId: run.id,
            todoId: run.todoId,
            previousStatus,
            outcome: "error",
            processTerminated: hadRunningProcess ? false : null,
            message
          });
        }
      }
    }

    return {
      summary: normalized,
      results,
      stopped: results.filter((entry) => entry.outcome === "cancelled" || entry.outcome === "paused").length,
      failed: results.filter((entry) => entry.outcome === "error").length,
      skipped: results.filter((entry) => entry.outcome === "skipped").length
    };
  }

  private concurrencyBlockReason(request: QueueLeaseRequest, lane: ExecutionLane): string | undefined {
    const active = [...this.active.values()];
    if (lane === "readonly") {
      const readOnlyCount = active.filter((lease) => lease.lane === "readonly").length;
      if (readOnlyCount >= this.config.maxReadOnlyParallel) {
        return `只读/调研型执行已达并行上限（${this.config.maxReadOnlyParallel}）；请等待现有任务完成或提高并行上限。`;
      }
      return undefined;
    }

    const writes = active.filter((lease) => lease.lane === "write");
    const isolated = request.worktreeIsolated === true;
    if (writes.length === 0) return undefined;

    // Non-isolated write agents serialize to maxWriteParallel (default 1).
    if (!isolated) {
      // Prefer isolation messaging when the same project already has a write lease.
      // Even under raised maxWriteParallel, never share an unisolated project workspace.
      const sameProject = writes.filter((lease) => lease.projectId && lease.projectId === request.projectId);
      if (sameProject.length > 0) {
        return "同一项目的写入任务只有在 Worktree 隔离条件满足时才允许并行。";
      }
      if (writes.length >= this.config.maxWriteParallel) {
        return `写入型代理已达并行上限（${this.config.maxWriteParallel}）；默认同一时间仅运行一个写入型代理。`;
      }
      return undefined;
    }

    // Isolated write: may only parallel with other isolated writes on the same project.
    const blockers = writes.filter((lease) => {
      if (!lease.worktreeIsolated) return true;
      if (lease.projectId && request.projectId && lease.projectId !== request.projectId) return true;
      return false;
    });
    if (blockers.length > 0) {
      if (blockers.some((lease) => !lease.worktreeIsolated)) {
        return "已有未隔离的写入型代理在运行；Worktree 隔离任务需等待其完成。";
      }
      return "不同项目的写入型代理默认不可与当前隔离任务并行；请等待或调整并行上限。";
    }

    const sameProjectIsolated = writes.filter(
      (lease) => lease.worktreeIsolated && lease.projectId === request.projectId
    );
    if (sameProjectIsolated.length >= this.config.maxIsolatedSameProjectWriteParallel) {
      return `同一项目的隔离写入任务已达并行上限（${this.config.maxIsolatedSameProjectWriteParallel}）。`;
    }
    return undefined;
  }

  private armTimeout(lease: QueueLease): void {
    this.clearTimeout(lease.runId);
    if (lease.timeoutMs <= 0) return;
    const cancel = this.scheduleTimeout(lease.runId, lease.timeoutMs, () => {
      void this.fireTimeout(lease.runId);
    });
    this.timeoutCleanups.set(lease.runId, cancel);
  }

  private async fireTimeout(runId: string): Promise<void> {
    if (!this.active.has(runId)) return;
    const reason = `执行超过配置超时（${this.config.executionTimeoutMs} ms）；已中断。`;
    try {
      if (this.options.onTimeout) {
        await this.options.onTimeout(runId, reason);
      } else {
        await this.options.runs.transition(runId, "paused", reason);
      }
    } catch {
      // Preserve queue bookkeeping even if the Run already left the running state.
    } finally {
      this.release(runId);
    }
  }

  private clearTimeout(runId: string): void {
    const cancel = this.timeoutCleanups.get(runId);
    if (cancel) {
      cancel();
      this.timeoutCleanups.delete(runId);
    }
  }

  private async persist(): Promise<void> {
    const payload: QueueState = { schemaVersion: 1, config: this.config };
    await mkdir(dirname(this.options.statePath), { recursive: true });
    const tempPath = `${this.options.statePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempPath, this.options.statePath);
  }
}

function defaultScheduleTimeout(_runId: string, ms: number, fire: () => void): () => void {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
}

function sanitizeUpdate(update: QueueConfigUpdate): QueueConfigUpdate {
  const next: QueueConfigUpdate = {};
  if (update.maxWriteParallel !== undefined) next.maxWriteParallel = update.maxWriteParallel;
  if (update.maxReadOnlyParallel !== undefined) next.maxReadOnlyParallel = update.maxReadOnlyParallel;
  if (update.maxIsolatedSameProjectWriteParallel !== undefined) {
    next.maxIsolatedSameProjectWriteParallel = update.maxIsolatedSameProjectWriteParallel;
  }
  if (update.executionTimeoutMs !== undefined) next.executionTimeoutMs = update.executionTimeoutMs;
  if (update.maxRetries !== undefined) next.maxRetries = update.maxRetries;
  if (update.minFreeDiskBytes !== undefined) next.minFreeDiskBytes = update.minFreeDiskBytes;
  if (update.minFreeMemoryBytes !== undefined) next.minFreeMemoryBytes = update.minFreeMemoryBytes;
  return next;
}

function normalizeConfig(input: QueueConfig): QueueConfig {
  return {
    maxWriteParallel: requirePositiveInt(input.maxWriteParallel, "maxWriteParallel"),
    maxReadOnlyParallel: requirePositiveInt(input.maxReadOnlyParallel, "maxReadOnlyParallel"),
    maxIsolatedSameProjectWriteParallel: requirePositiveInt(
      input.maxIsolatedSameProjectWriteParallel,
      "maxIsolatedSameProjectWriteParallel"
    ),
    executionTimeoutMs: requireNonNegativeInt(input.executionTimeoutMs, "executionTimeoutMs"),
    maxRetries: requirePositiveInt(input.maxRetries, "maxRetries"),
    minFreeDiskBytes: requireNonNegativeInt(input.minFreeDiskBytes, "minFreeDiskBytes"),
    minFreeMemoryBytes: requireNonNegativeInt(input.minFreeMemoryBytes, "minFreeMemoryBytes")
  };
}

function requirePositiveInt(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function requireNonNegativeInt(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

/** Shared helper: build a lease request from a Run + workspace context. */
export function leaseRequestFromRun(
  run: Pick<Run, "id" | "todoId" | "planning" | "execution">,
  context: {
    projectId?: string;
    readOnlyPermissions?: boolean;
    worktreeIsolated?: boolean;
  } = {}
): QueueLeaseRequest {
  return {
    runId: run.id,
    todoId: run.todoId,
    projectId: context.projectId,
    taskType: run.planning?.assessment.taskType,
    readOnlyPermissions: context.readOnlyPermissions,
    worktreeIsolated: context.worktreeIsolated
  };
}
