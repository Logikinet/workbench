import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { AutomationService } from "./automationService.js";
import { createAutomationRouteApp } from "./automationRoutes.js";

describe("automation routes (Task 43)", () => {
  let automation: AutomationService;
  let app: Awaited<ReturnType<typeof createAutomationRouteApp>>;
  let todos: Array<{ id: string; title: string }>;
  let runs: Array<{ id: string; todoId: string; status: string }>;
  let clock: number;

  beforeEach(async () => {
    clock = Date.parse("2026-07-15T10:00:00.000Z");
    todos = [];
    runs = [];
    automation = await AutomationService.createMemory({
      now: () => clock,
      todos: {
        async create(input) {
          const todo = { id: `todo-${todos.length + 1}`, title: input.title };
          todos.push(todo);
          return todo;
        }
      },
      runs: {
        async create(todoId, _message) {
          const run = { id: `run-${runs.length + 1}`, todoId, status: "awaiting_plan_approval" };
          runs.push(run);
          return run;
        },
        async addUserMessage(runId, _content) {
          return { id: runId };
        }
      }
    });
    app = await createAutomationRouteApp({
      automation,
      clientAddress: () => "127.0.0.1"
    });
  });

  it("CRUD jobs, enable/disable, manual run, history, and status", async () => {
    const created = await request(app)
      .post("/api/automation/jobs")
      .send({
        name: "Nightly",
        schedule: { kind: "every", everyMs: 3_600_000 },
        action: { type: "create_todo", title: "Nightly scan", startRun: true },
        missedRunPolicy: "skip"
      })
      .expect(201);

    expect(created.body.name).toBe("Nightly");
    expect(created.body.state.nextRunAt).toBeTruthy();

    const listed = await request(app).get("/api/automation/jobs").expect(200);
    expect(listed.body.jobs).toHaveLength(1);

    await request(app).get(`/api/automation/jobs/${created.body.id}`).expect(200);

    await request(app).post(`/api/automation/jobs/${created.body.id}/disable`).expect(200);
    expect((await automation.getJob(created.body.id)).enabled).toBe(false);

    await request(app).post(`/api/automation/jobs/${created.body.id}/enable`).expect(200);

    const run = await request(app)
      .post(`/api/automation/jobs/${created.body.id}/run`)
      .send({})
      .expect(200);
    expect(run.body.status).toBe("ok");
    expect(run.body.requiresHumanGates).toBe(true);
    expect(run.body.todoId).toBeTruthy();
    expect(run.body.runId).toBeTruthy();
    expect(todos).toHaveLength(1);
    expect(runs[0]?.status).toBe("awaiting_plan_approval");

    const history = await request(app)
      .get(`/api/automation/jobs/${created.body.id}/history`)
      .expect(200);
    expect(history.body.history.length).toBeGreaterThan(0);

    const globalHistory = await request(app).get("/api/automation/history").expect(200);
    expect(globalHistory.body.history.length).toBeGreaterThan(0);

    const status = await request(app).get("/api/automation/status").expect(200);
    expect(status.body.jobCount).toBe(1);

    await request(app).delete(`/api/automation/jobs/${created.body.id}`).expect(204);
    expect((await request(app).get("/api/automation/jobs")).body.jobs).toHaveLength(0);
  });

  it("creates webhooks, accepts token-gated events, rejects bad auth/types", async () => {
    const created = await request(app)
      .post("/api/automation/webhooks")
      .send({
        name: "local-ci",
        allowedEventTypes: ["create_todo", "create_run"]
      })
      .expect(201);

    expect(created.body.token).toBeTruthy();
    expect(created.body.webhook.path).toMatch(/^\/api\/hooks\//);
    // public list never echoes token
    const listed = await request(app).get("/api/automation/webhooks").expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);

    await request(app)
      .post(created.body.webhook.path)
      .set("Authorization", "Bearer wrong")
      .send({ type: "create_todo", title: "no" })
      .expect(401);

    await request(app)
      .post(created.body.webhook.path)
      .set("Authorization", `Bearer ${created.body.token}`)
      .send({ type: "append_run_message", runId: "r1", message: "x" })
      .expect(400);

    const ok = await request(app)
      .post(created.body.webhook.path)
      .set("X-PAW-Webhook-Token", created.body.token)
      .send({
        type: "create_todo",
        title: "Hooked",
        startRun: true,
        idempotencyKey: "route-1"
      })
      .expect(200);

    expect(ok.body.status).toBe("ok");
    expect(ok.body.requiresHumanGates).toBe(true);

    const dup = await request(app)
      .post(created.body.webhook.path)
      .set("X-PAW-Webhook-Token", created.body.token)
      .send({
        type: "create_todo",
        title: "Hooked",
        idempotencyKey: "route-1"
      })
      .expect(200);
    expect(dup.body.status).toBe("deduped");
    expect(todos).toHaveLength(1);

    await request(app)
      .post(`/api/automation/webhooks/${created.body.webhook.id}/disable`)
      .expect(200);

    await request(app)
      .post(created.body.webhook.path)
      .set("X-PAW-Webhook-Token", created.body.token)
      .send({ type: "create_todo", title: "after disable" })
      .expect(403);

    const rotated = await request(app)
      .post(`/api/automation/webhooks/${created.body.webhook.id}/rotate-token`)
      .expect(200);
    expect(rotated.body.token).toBeTruthy();

    await request(app)
      .delete(`/api/automation/webhooks/${created.body.webhook.id}`)
      .expect(204);
  });

  it("rejects invalid job payloads", async () => {
    await request(app)
      .post("/api/automation/jobs")
      .send({ name: "bad", schedule: { kind: "cron", expr: "not-cron" }, action: { type: "create_todo", title: "x" } })
      .expect(400);

    await request(app)
      .post("/api/automation/jobs")
      .send({ name: "bad", schedule: { kind: "manual" }, action: { type: "nope" } })
      .expect(400);
  });
});
