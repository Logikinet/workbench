import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutomationService,
  type AutomationFlowPort,
  type AutomationRunPort,
  type AutomationTodoPort
} from "./automationService.js";

function createPorts() {
  const todosCreated: Array<{ title: string; description?: string }> = [];
  const runsCreated: Array<{ todoId: string; message?: string }> = [];
  const messages: Array<{ runId: string; content: string }> = [];
  const flows: Array<{ flowId: string }> = [];

  // Methods that MUST never be called by automation (human gates).
  const forbidden = {
    decidePlan: vi.fn(),
    decideExecutionApproval: vi.fn(),
    acceptReviewOutcome: vi.fn(),
    formalAccept: vi.fn()
  };

  const todos: AutomationTodoPort & typeof forbidden = {
    ...forbidden,
    async create(input) {
      const id = `todo-${todosCreated.length + 1}`;
      todosCreated.push(input);
      return { id, title: input.title };
    }
  };

  const runs: AutomationRunPort & typeof forbidden = {
    ...forbidden,
    async create(todoId, initialMessage) {
      const id = `run-${runsCreated.length + 1}`;
      runsCreated.push({ todoId, message: initialMessage });
      // Mimic RunService: new runs land in planning / awaiting_plan_approval path.
      return { id, status: "awaiting_plan_approval" };
    },
    async addUserMessage(runId, content) {
      messages.push({ runId, content });
      return { id: runId };
    }
  };

  const flowPort: AutomationFlowPort = {
    async trigger(flowId, _input, _meta) {
      flows.push({ flowId });
      return { accepted: true, todoId: "todo-flow", runId: "run-flow", summary: `flow ${flowId}` };
    }
  };

  return { todos, runs, flowPort, todosCreated, runsCreated, messages, flows, forbidden };
}

describe("AutomationService", () => {
  let root: string;
  let clock: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-auto-"));
    clock = Date.parse("2026-07-15T10:00:00.000Z");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates once / every / manual jobs, exposes nextRunAt, enables and disables", async () => {
    const { todos, runs } = createPorts();
    const service = await AutomationService.createMemory({
      todos,
      runs,
      now: () => clock
    });

    const once = await service.createJob({
      name: "one shot",
      schedule: { kind: "once", at: "2026-07-15T12:00:00.000Z" },
      action: { type: "create_todo", title: "from once" }
    });
    expect(once.enabled).toBe(true);
    expect(once.state.nextRunAt).toBe("2026-07-15T12:00:00.000Z");
    expect(once.deleteAfterRun).toBe(true);

    const every = await service.createJob({
      name: "interval",
      schedule: { kind: "every", everyMs: 60_000 },
      action: { type: "create_todo", title: "tick" },
      missedRunPolicy: "skip"
    });
    expect(every.state.nextRunAt).toBeTruthy();

    const manual = await service.createJob({
      name: "manual only",
      schedule: { kind: "manual" },
      action: { type: "create_todo", title: "manual" },
      enabled: true
    });
    expect(manual.state.nextRunAt).toBeNull();

    await service.setJobEnabled(every.id, false);
    expect(service.getJob(every.id).enabled).toBe(false);
    expect(service.getJob(every.id).state.nextRunAt).toBeNull();

    await service.setJobEnabled(every.id, true);
    expect(service.getJob(every.id).enabled).toBe(true);
    expect(service.getJob(every.id).state.nextRunAt).toBeTruthy();

    expect(service.listJobs()).toHaveLength(3);
    await service.deleteJob(manual.id);
    expect(service.listJobs()).toHaveLength(2);
  });

  it("runs jobs manually and never calls plan/danger/accept APIs", async () => {
    const ports = createPorts();
    const service = await AutomationService.createMemory({
      todos: ports.todos,
      runs: ports.runs,
      now: () => clock
    });

    const job = await service.createJob({
      name: "manual create run",
      schedule: { kind: "manual" },
      action: { type: "create_todo", title: "Auto todo", startRun: true, initialMessage: "go" },
      enabled: true
    });

    const result = await service.runJobNow(job.id);
    expect(result.status).toBe("ok");
    expect(result.requiresHumanGates).toBe(true);
    expect(result.todoId).toBe("todo-1");
    expect(result.runId).toBe("run-1");
    expect(result.summary).toMatch(/plan approval/i);

    expect(ports.todosCreated).toHaveLength(1);
    expect(ports.runsCreated).toEqual([{ todoId: "todo-1", message: "go" }]);
    expect(ports.forbidden.decidePlan).not.toHaveBeenCalled();
    expect(ports.forbidden.decideExecutionApproval).not.toHaveBeenCalled();
    expect(ports.forbidden.acceptReviewOutcome).not.toHaveBeenCalled();
    expect(ports.forbidden.formalAccept).not.toHaveBeenCalled();

    const history = service.listHistory({ jobId: job.id });
    expect(history.some((e) => e.kind === "job_executed")).toBe(true);
    expect(history.find((e) => e.kind === "job_executed")?.result?.requiresHumanGates).toBe(true);
  });

  it("appends run messages without approving anything", async () => {
    const ports = createPorts();
    const service = await AutomationService.createMemory({
      runs: ports.runs,
      now: () => clock
    });
    const job = await service.createJob({
      name: "append",
      schedule: { kind: "manual" },
      action: { type: "append_run_message", runId: "run-existing", message: "ping from cron" },
      enabled: true
    });
    const result = await service.runJobNow(job.id);
    expect(result.status).toBe("ok");
    expect(ports.messages).toEqual([{ runId: "run-existing", content: "ping from cron" }]);
    expect(ports.forbidden.decidePlan).not.toHaveBeenCalled();
  });

  it("catch_up_one executes a single overdue once-job on start", async () => {
    const ports = createPorts();
    const catchUp = await AutomationService.createMemory({
      todos: ports.todos,
      now: () => clock
    });
    const job = await catchUp.createJob({
      name: "catch",
      schedule: { kind: "once", at: "2026-07-15T09:00:00.000Z" },
      action: { type: "create_todo", title: "catch me" },
      missedRunPolicy: "catch_up_one"
    });
    // once retains absolute at even when overdue
    expect(job.state.nextRunAt).toBe("2026-07-15T09:00:00.000Z");
    expect(Date.parse(job.state.nextRunAt!)).toBeLessThan(clock);
    await catchUp.start();
    expect(ports.todosCreated.some((t) => t.title === "catch me")).toBe(true);
    expect(catchUp.listHistory({ jobId: job.id }).some((e) => e.kind === "job_executed")).toBe(true);
    catchUp.stop();
  });

  it("skips missed runs by default and does not batch-fire", async () => {
    const ports = createPorts();
    let t = clock;
    const service = await AutomationService.createMemory({
      todos: ports.todos,
      now: () => t
    });

    const job = await service.createJob({
      name: "every minute",
      schedule: { kind: "every", everyMs: 60_000 },
      action: { type: "create_todo", title: "tick" },
      missedRunPolicy: "skip"
    });
    // Simulate offline: advance far past many intervals without ticking.
    const originalNext = Date.parse(job.state.nextRunAt!);
    // Manually set nextRunAt into the past by updating via disable/enable trick:
    // create with past-facing every using anchor through reconcile:
    t = originalNext + 10 * 60_000; // 10 intervals later
    await service.start();
    // skip policy should NOT create 10 todos
    const createdAfterSkip = ports.todosCreated.filter((c) => c.title === "tick").length;
    expect(createdAfterSkip).toBe(0);
    const after = service.getJob(job.id);
    expect(after.state.lastStatus).toBe("skipped");
    expect(after.state.nextRunAt).toBeTruthy();
    expect(Date.parse(after.state.nextRunAt!)).toBeGreaterThan(t - 1);
    service.stop();
  });

  it("dedupes the same scheduled slot", async () => {
    const ports = createPorts();
    const service = await AutomationService.createMemory({
      todos: ports.todos,
      now: () => clock
    });
    const job = await service.createJob({
      name: "once dedupe",
      schedule: { kind: "once", at: new Date(clock).toISOString() },
      action: { type: "create_todo", title: "only once" },
      missedRunPolicy: "catch_up_one"
    });
    await service.start();
    const count1 = ports.todosCreated.filter((c) => c.title === "only once").length;
    expect(count1).toBe(1);
    // Re-inject same slot and tick again should not create another
    const still = service.listJobs().find((j) => j.id === job.id);
    // once job is deleted or disabled after run
    expect(still === undefined || still.enabled === false).toBe(true);
    service.stop();
  });

  it("webhook requires token, rejects unknown types, enforces source, and is idempotent", async () => {
    const ports = createPorts();
    const service = await AutomationService.createMemory({
      todos: ports.todos,
      runs: ports.runs,
      flows: ports.flowPort,
      now: () => clock
    });

    const { webhook, token } = await service.createWebhook({
      name: "local tools",
      allowedEventTypes: ["create_todo", "append_run_message", "create_run", "trigger_flow"]
    });
    expect(webhook.path).toBe(`/api/hooks/${webhook.id}`);
    expect(token.length).toBeGreaterThan(10);
    // token not stored in public view
    expect(JSON.stringify(service.listWebhooks())).not.toContain(token);

    await expect(
      service.processWebhook({
        webhookId: webhook.id,
        token: "wrong",
        sourceAddress: "127.0.0.1",
        body: { type: "create_todo", title: "x" }
      })
    ).rejects.toThrow(/token/i);

    await expect(
      service.processWebhook({
        webhookId: webhook.id,
        token,
        sourceAddress: "10.0.0.5",
        body: { type: "create_todo", title: "x" }
      })
    ).rejects.toThrow(/not allowed/i);

    await expect(
      service.processWebhook({
        webhookId: webhook.id,
        token,
        sourceAddress: "127.0.0.1",
        body: { type: "not_a_real_event" as "create_todo", title: "x" }
      })
    ).rejects.toThrow(/event type/i);

    const ok = await service.processWebhook({
      webhookId: webhook.id,
      token,
      sourceAddress: "127.0.0.1",
      body: {
        type: "create_todo",
        title: "from webhook",
        startRun: true,
        initialMessage: "hi",
        idempotencyKey: "evt-1"
      }
    });
    expect(ok.status).toBe("ok");
    expect(ok.requiresHumanGates).toBe(true);
    expect(ok.todoId).toBeTruthy();
    expect(ok.runId).toBeTruthy();

    const dup = await service.processWebhook({
      webhookId: webhook.id,
      token,
      sourceAddress: "127.0.0.1",
      body: {
        type: "create_todo",
        title: "from webhook",
        idempotencyKey: "evt-1"
      }
    });
    expect(dup.status).toBe("deduped");
    expect(ports.todosCreated.filter((t) => t.title === "from webhook")).toHaveLength(1);

    const msg = await service.processWebhook({
      webhookId: webhook.id,
      token,
      sourceAddress: "::1",
      body: { type: "append_run_message", runId: "run-9", message: "more context", eventId: "e2" }
    });
    expect(msg.status).toBe("ok");
    expect(ports.messages).toContainEqual({ runId: "run-9", content: "more context" });

    const flow = await service.processWebhook({
      webhookId: webhook.id,
      token,
      sourceAddress: "127.0.0.1",
      body: { type: "trigger_flow", flowId: "nightly-review" }
    });
    expect(flow.status).toBe("ok");
    expect(flow.flowId).toBe("nightly-review");
    expect(ports.flows).toEqual([{ flowId: "nightly-review" }]);

    // All webhook outcomes audited
    const hist = service.listHistory({ webhookId: webhook.id });
    expect(hist.some((e) => e.kind === "webhook_executed")).toBe(true);
    expect(hist.some((e) => e.kind === "webhook_rejected" || e.kind === "webhook_deduped")).toBe(true);
  });

  it("persists jobs and webhooks to disk", async () => {
    const ports = createPorts();
    const path = join(root, "automation.json");
    const service = await AutomationService.open({
      statePath: path,
      todos: ports.todos,
      now: () => clock
    });
    await service.createJob({
      name: "persist me",
      schedule: { kind: "every", everyMs: 120_000 },
      action: { type: "create_todo", title: "p" }
    });
    const { webhook } = await service.createWebhook({ name: "wh" });
    await service.flush();

    const raw = JSON.parse(await readFile(path, "utf8")) as { jobs: unknown[]; webhooks: unknown[] };
    expect(raw.jobs).toHaveLength(1);
    expect(raw.webhooks).toHaveLength(1);

    const reopened = await AutomationService.open({
      statePath: path,
      todos: ports.todos,
      now: () => clock
    });
    expect(reopened.listJobs()[0]?.name).toBe("persist me");
    expect(reopened.getWebhook(webhook.id).name).toBe("wh");
  });

  it("rotates webhook tokens and disables endpoints", async () => {
    const ports = createPorts();
    const service = await AutomationService.createMemory({
      todos: ports.todos,
      now: () => clock
    });
    const created = await service.createWebhook({ name: "rot" });
    const rotated = await service.rotateWebhookToken(created.webhook.id);
    expect(rotated.token).not.toBe(created.token);

    await expect(
      service.processWebhook({
        webhookId: created.webhook.id,
        token: created.token,
        sourceAddress: "127.0.0.1",
        body: { type: "create_todo", title: "nope" }
      })
    ).rejects.toThrow(/token/i);

    await service.setWebhookEnabled(created.webhook.id, false);
    await expect(
      service.processWebhook({
        webhookId: created.webhook.id,
        token: rotated.token,
        sourceAddress: "127.0.0.1",
        body: { type: "create_todo", title: "nope" }
      })
    ).rejects.toThrow(/disabled/i);
  });
});
