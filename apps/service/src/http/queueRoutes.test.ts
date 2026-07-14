import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { ResourceGuardService, type DiskStatsProvider, type MemoryStatsProvider } from "../queue/resourceGuardService.js";
import { RunQueueService } from "../queue/runQueueService.js";
import type { Run } from "../runs/runService.js";

class FakeDisk implements DiskStatsProvider {
  free = 8 * 1024 * 1024 * 1024;
  async freeBytes(): Promise<number> {
    return this.free;
  }
}

class FakeMemory implements MemoryStatsProvider {
  free = 4 * 1024 * 1024 * 1024;
  freeBytes(): number {
    return this.free;
  }
}

describe("queue and stop-all HTTP routes", () => {
  let root: string;
  let queue: RunQueueService;
  let disk: FakeDisk;
  let runs: {
    get: ReturnType<typeof vi.fn>;
    listAll: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    transition: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-queue-http-"));
    disk = new FakeDisk();
    runs = {
      get: vi.fn(),
      listAll: vi.fn().mockResolvedValue([]),
      stop: vi.fn(),
      transition: vi.fn()
    };
    queue = await RunQueueService.open({
      statePath: join(root, "queue.json"),
      resourceGuard: new ResourceGuardService(root, {}, disk, new FakeMemory()),
      runs
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads and updates queue concurrency/timeout/retry config", async () => {
    const app = createApp({ version: "0.1.0", queue });
    const initial = await request(app).get("/api/queue/config").expect(200);
    expect(initial.body).toMatchObject({ maxWriteParallel: 1, maxReadOnlyParallel: 2, maxRetries: 2 });

    const updated = await request(app)
      .put("/api/queue/config")
      .send({
        maxWriteParallel: 2,
        maxReadOnlyParallel: 3,
        executionTimeoutMs: 120000,
        maxRetries: 4,
        minFreeDiskBytes: 1024
      })
      .expect(200);
    expect(updated.body).toMatchObject({
      maxWriteParallel: 2,
      maxReadOnlyParallel: 3,
      executionTimeoutMs: 120000,
      maxRetries: 4,
      minFreeDiskBytes: 1024
    });

    await request(app)
      .put("/api/queue/config")
      .send({ maxWriteParallel: 0 })
      .expect(400);
  });

  it("exposes queue status with resource snapshot", async () => {
    const app = createApp({ version: "0.1.0", queue });
    const status = await request(app).get("/api/queue/status").expect(200);
    expect(status.body).toMatchObject({
      writeCount: 0,
      readOnlyCount: 0,
      newTasksPaused: false,
      resource: { freeDiskBytes: expect.any(Number) }
    });
  });

  it("stops all unfinished Runs and returns per-process terminate results", async () => {
    const running: Run = {
      id: "run-1",
      todoId: "todo-1",
      attempt: 1,
      status: "running",
      messages: [],
      planVersions: [],
      execution: {
        status: "running",
        completedSteps: [],
        retryable: false,
        failureCounts: {},
        maxConsecutiveFailures: 2
      },
      logs: [],
      reviews: [],
      approvals: [],
      artifacts: [],
      askUserRequests: [],
      checkpoints: [],
      timeline: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    runs.listAll.mockResolvedValue([running]);
    runs.stop.mockResolvedValue({
      ...running,
      status: "cancelled",
      execution: { ...running.execution, status: "failed" }
    });
    const app = createApp({ version: "0.1.0", queue });
    const response = await request(app)
      .post("/api/runs/stop-all")
      .send({ summary: "全部停止" })
      .expect(200);
    expect(response.body).toMatchObject({
      summary: "全部停止",
      stopped: 1,
      results: [
        expect.objectContaining({
          runId: "run-1",
          outcome: "cancelled",
          processTerminated: true
        })
      ]
    });
  });

  it("advertises queue capability on health", async () => {
    const response = await request(createApp({ version: "0.1.0", queue }))
      .get("/api/health")
      .expect(200);
    expect(response.body.capabilities).toEqual(expect.arrayContaining(["queue"]));
  });

  it("allows local PWA preflight for PUT queue config", async () => {
    const app = createApp({ version: "0.1.0", queue });
    const preflight = await request(app)
      .options("/api/queue/config")
      .set("Origin", "http://127.0.0.1:5173")
      .set("Access-Control-Request-Method", "PUT")
      .expect(204);
    expect(preflight.headers["access-control-allow-methods"]).toMatch(/\bPUT\b/);

    await request(app)
      .put("/api/queue/config")
      .set("Origin", "http://127.0.0.1:5173")
      .send({ maxWriteParallel: 1 })
      .expect(200)
      .expect("access-control-allow-origin", "http://127.0.0.1:5173");
  });
});
