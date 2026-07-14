import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, RunStatus } from "../runs/runService.js";
import { ResourceGuardService, type DiskStatsProvider, type MemoryStatsProvider } from "./resourceGuardService.js";
import {
  defaultQueueConfig,
  leaseRequestFromRun,
  RunQueueService,
  type QueueLeaseRequest
} from "./runQueueService.js";

class FakeDisk implements DiskStatsProvider {
  constructor(public free = 10 * 1024 * 1024 * 1024) {}
  async freeBytes(): Promise<number> {
    return this.free;
  }
}

class FakeMemory implements MemoryStatsProvider {
  constructor(public free = 2 * 1024 * 1024 * 1024) {}
  freeBytes(): number {
    return this.free;
  }
}

function makeRun(overrides: Partial<Run> & Pick<Run, "id" | "todoId" | "status">): Run {
  return {
    attempt: 1,
    messages: [],
    planVersions: [],
    planning: {
      assessment: {
        taskType: "implementation",
        requiredCapabilities: [],
        criticalInputs: [],
        assumptions: [],
        complexity: "low"
      },
      approvalStatus: "approved",
      approvedPlanVersion: 1,
      verificationCommands: []
    },
    execution: {
      status: "idle",
      completedSteps: [],
      retryable: false,
      failureCounts: {},
      maxConsecutiveFailures: 2
    },
    logs: [],
    reviews: [],
    approvals: [],
    artifacts: [],
    checkpoints: [],
    timeline: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("RunQueueService", () => {
  let root: string;
  let statePath: string;
  let disk: FakeDisk;
  let memory: FakeMemory;
  let runs: {
    get: ReturnType<typeof vi.fn>;
    listAll: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    transition: ReturnType<typeof vi.fn>;
  };
  let pendingTimeouts: Array<{ runId: string; ms: number; fire: () => void }>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-queue-"));
    statePath = join(root, "queue.json");
    disk = new FakeDisk();
    memory = new FakeMemory();
    runs = {
      get: vi.fn(),
      listAll: vi.fn().mockResolvedValue([]),
      stop: vi.fn(),
      transition: vi.fn()
    };
    pendingTimeouts = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function openQueue(onTimeout?: (runId: string, reason: string) => Promise<void> | void) {
    const resourceGuard = new ResourceGuardService(root, {}, disk, memory);
    return RunQueueService.open({
      statePath,
      resourceGuard,
      runs,
      scheduleTimeout: (runId, ms, fire) => {
        pendingTimeouts.push({ runId, ms, fire });
        return () => {
          pendingTimeouts = pendingTimeouts.filter((entry) => entry.fire !== fire);
        };
      },
      onTimeout
    });
  }

  function writeRequest(runId: string, projectId = "project-a", isolated = false): QueueLeaseRequest {
    return {
      runId,
      todoId: `todo-${runId}`,
      projectId,
      taskType: "implementation",
      worktreeIsolated: isolated
    };
  }

  function researchRequest(runId: string): QueueLeaseRequest {
    return {
      runId,
      todoId: `todo-${runId}`,
      projectId: "project-a",
      taskType: "research"
    };
  }

  it("defaults to one write agent and two read-only agents", async () => {
    const queue = await openQueue();
    expect(queue.getConfig()).toMatchObject({
      maxWriteParallel: 1,
      maxReadOnlyParallel: 2,
      maxRetries: 2
    });
  });

  it("allows only one non-isolated write agent by default", async () => {
    const queue = await openQueue();
    const first = await queue.admit(writeRequest("run-1"));
    expect(first.allowed).toBe(true);
    const second = await queue.admit(writeRequest("run-2", "project-b"));
    expect(second.allowed).toBe(false);
    if (!second.allowed) {
      expect(second.code).toBe("concurrency");
      expect(second.reason).toMatch(/写入型代理已达并行上限/);
    }
  });

  it("allows read-only/research executions up to the configured parallel limit", async () => {
    const queue = await openQueue();
    expect((await queue.admit(researchRequest("r1"))).allowed).toBe(true);
    expect((await queue.admit(researchRequest("r2"))).allowed).toBe(true);
    const third = await queue.admit(researchRequest("r3"));
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.reason).toMatch(/只读\/调研型执行已达并行上限/);
    }
    queue.release("r1");
    expect((await queue.admit(researchRequest("r3"))).allowed).toBe(true);
  });

  it("classifies analysis and explicit read_only permissions as readonly lane", async () => {
    const queue = await openQueue();
    expect(queue.classify({ runId: "a", todoId: "t", taskType: "analysis" })).toBe("readonly");
    expect(queue.classify({ runId: "b", todoId: "t", taskType: "writing", readOnlyPermissions: true })).toBe("readonly");
    expect(queue.classify({ runId: "c", todoId: "t", taskType: "implementation" })).toBe("write");
  });

  it("allows same-project write tasks in parallel only when worktree isolation is met", async () => {
    const queue = await openQueue();
    expect((await queue.admit(writeRequest("iso-1", "project-a", true))).allowed).toBe(true);
    expect((await queue.admit(writeRequest("iso-2", "project-a", true))).allowed).toBe(true);

    const nonIsolatedSameProject = await queue.admit(writeRequest("plain", "project-a", false));
    expect(nonIsolatedSameProject.allowed).toBe(false);
    if (!nonIsolatedSameProject.allowed) {
      expect(nonIsolatedSameProject.reason).toMatch(/隔离/);
    }

    const otherProject = await queue.admit(writeRequest("other", "project-b", true));
    expect(otherProject.allowed).toBe(false);
  });

  it("blocks same-project non-isolated writes even when global write parallel is raised", async () => {
    const queue = await openQueue();
    await queue.updateConfig({ maxWriteParallel: 3 });
    expect((await queue.admit(writeRequest("w1", "project-a", false))).allowed).toBe(true);
    const blocked = await queue.admit(writeRequest("w2", "project-a", false));
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.reason).toMatch(/同一项目的写入任务只有在 Worktree 隔离条件满足时才允许并行/);
    }
    expect((await queue.admit(writeRequest("w3", "project-b", false))).allowed).toBe(true);
  });

  it("pauses admission when disk is short and exposes a clear reason", async () => {
    disk.free = 1024;
    const queue = await openQueue();
    await queue.updateConfig({ minFreeDiskBytes: 1024 * 1024 * 1024 });
    const denied = await queue.admit(writeRequest("disk-run"));
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.code).toBe("resource");
      expect(denied.reason).toMatch(/磁盘空间不足/);
    }
    const status = await queue.status();
    expect(status.newTasksPaused).toBe(true);
    expect(status.pauseReason).toMatch(/磁盘空间不足/);
  });

  it("clears the sticky pause banner on status() once free resources recover", async () => {
    disk.free = 1024;
    const queue = await openQueue();
    await queue.updateConfig({ minFreeDiskBytes: 1024 * 1024 * 1024 });
    await queue.admit(writeRequest("disk-starved"));
    expect((await queue.status()).newTasksPaused).toBe(true);
    disk.free = 8 * 1024 * 1024 * 1024;
    const recovered = await queue.status();
    expect(recovered.newTasksPaused).toBe(false);
    expect(recovered.pauseReason).toBeUndefined();
  });

  it("persists user-configurable timeout, retries, and parallel limits", async () => {
    const queue = await openQueue();
    const updated = await queue.updateConfig({
      maxWriteParallel: 2,
      maxReadOnlyParallel: 4,
      maxIsolatedSameProjectWriteParallel: 3,
      executionTimeoutMs: 60_000,
      maxRetries: 5,
      minFreeDiskBytes: 1000,
      minFreeMemoryBytes: 2000
    });
    expect(updated).toMatchObject({
      maxWriteParallel: 2,
      maxReadOnlyParallel: 4,
      maxIsolatedSameProjectWriteParallel: 3,
      executionTimeoutMs: 60_000,
      maxRetries: 5,
      minFreeDiskBytes: 1000,
      minFreeMemoryBytes: 2000
    });
    const raw = JSON.parse(await readFile(statePath, "utf8")) as { schemaVersion: number; config: unknown };
    expect(raw.schemaVersion).toBe(1);
    const reopened = await openQueue();
    expect(reopened.getConfig()).toEqual(updated);
  });

  it("rejects invalid config values without weakening guards", async () => {
    const queue = await openQueue();
    await expect(queue.updateConfig({ maxWriteParallel: 0 })).rejects.toThrow(/maxWriteParallel/);
    await expect(queue.updateConfig({ executionTimeoutMs: -1 })).rejects.toThrow(/executionTimeoutMs/);
    expect(queue.getConfig()).toEqual(defaultQueueConfig());
  });

  it("arms execution timeouts and releases the lease when they fire", async () => {
    const timedOut: string[] = [];
    const queue = await openQueue(async (runId, reason) => {
      timedOut.push(`${runId}:${reason}`);
    });
    await queue.updateConfig({ executionTimeoutMs: 12_000 });
    expect((await queue.admit(writeRequest("timeout-run"))).allowed).toBe(true);
    expect(pendingTimeouts).toHaveLength(1);
    expect(pendingTimeouts[0]?.ms).toBe(12_000);
    pendingTimeouts[0]?.fire();
    await vi.waitFor(() => expect(queue.hasLease("timeout-run")).toBe(false));
    expect(timedOut[0]).toMatch(/timeout-run:执行超过配置超时/);
  });

  it("stop-all reports per-process terminate results", async () => {
    const queue = await openQueue();
    const active = makeRun({ id: "run-active", todoId: "todo-1", status: "running", execution: {
      status: "running",
      completedSteps: [],
      retryable: false,
      failureCounts: {},
      maxConsecutiveFailures: 2
    } });
    const paused = makeRun({ id: "run-paused", todoId: "todo-2", status: "paused" });
    const completed = makeRun({ id: "run-done", todoId: "todo-3", status: "completed" });
    runs.listAll.mockResolvedValue([active, paused, completed]);
    runs.stop.mockImplementation(async (runId: string) => {
      if (runId === "run-active") {
        return { ...active, status: "cancelled" as RunStatus, execution: { ...active.execution, status: "failed" as const } };
      }
      if (runId === "run-paused") {
        return { ...paused, status: "cancelled" as RunStatus };
      }
      throw new Error("Only an unfinished Run can be stopped.");
    });

    const result = await queue.stopAll("紧急停止全部");
    expect(result.summary).toBe("紧急停止全部");
    expect(result.stopped).toBe(2);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "run-active",
        outcome: "cancelled",
        processTerminated: true,
        message: expect.stringMatching(/已终止|已取消/)
      }),
      expect.objectContaining({
        runId: "run-paused",
        outcome: "cancelled"
      })
    ]));
    // completed is not in stoppable filter... wait, completed is NOT in stoppableStatuses
    expect(result.results.find((entry) => entry.runId === "run-done")).toBeUndefined();
  });

  it("stop-all surfaces unconfirmed process termination without marking success", async () => {
    const queue = await openQueue();
    const sticky = makeRun({
      id: "run-sticky",
      todoId: "todo-s",
      status: "paused",
      execution: {
        status: "failed",
        completedSteps: [],
        retryable: false,
        failureCounts: {},
        maxConsecutiveFailures: 2,
        terminationUnconfirmed: true
      }
    });
    runs.listAll.mockResolvedValue([sticky]);
    runs.stop.mockRejectedValue(new Error("此前停止未确认执行进程已终止；Run 必须保持暂停，不能标记为已取消。"));
    const result = await queue.stopAll();
    expect(result.results[0]).toMatchObject({
      runId: "run-sticky",
      outcome: "paused",
      processTerminated: false
    });
  });

  it("builds lease requests from runs", () => {
    const run = makeRun({ id: "run-x", todoId: "todo-x", status: "queued" });
    expect(leaseRequestFromRun(run, { projectId: "p1", worktreeIsolated: true })).toEqual({
      runId: "run-x",
      todoId: "todo-x",
      projectId: "p1",
      taskType: "implementation",
      readOnlyPermissions: undefined,
      worktreeIsolated: true
    });
  });
});
