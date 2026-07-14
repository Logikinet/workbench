import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubtaskDagService } from "./subtaskDagService.js";
import { createSubtaskRouter } from "./subtaskRoutes.js";

describe("subtask routes (Task 21)", () => {
  let root: string;
  let app: express.Express;
  let subtasks: SubtaskDagService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-subtasks-http-"));
    subtasks = await SubtaskDagService.open(join(root, "subtasks.json"));
    app = express();
    app.use(express.json());
    app.use(createSubtaskRouter({ subtasks }));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates DAG from approved plan, exposes frontier, and completes with auto-schedule", async () => {
    const created = await request(app)
      .post("/api/subtasks/from-plan")
      .send({
        runId: "run-http-1",
        planVersion: 1,
        planApproved: true,
        autoSchedule: true,
        steps: ["确认范围", "实现改动", "验证"]
      })
      .expect(201);

    expect(created.body.subtasks).toHaveLength(3);
    expect(created.body.subtasks[0].status).toBe("running");

    const frontier = await request(app).get("/api/subtasks/runs/run-http-1/frontier").expect(200);
    expect(Array.isArray(frontier.body.frontier)).toBe(true);

    const complete = await request(app)
      .post(`/api/subtasks/runs/run-http-1/subtasks/${created.body.subtasks[0].id}/complete`)
      .send({ artifacts: ["note.md"] })
      .expect(200);

    expect(complete.body.dag.subtasks[0].status).toBe("completed");
    expect(complete.body.dag.subtasks[1].status).toBe("running");

    const listed = await request(app).get("/api/subtasks").expect(200);
    expect(listed.body.some((d: { runId: string }) => d.runId === "run-http-1")).toBe(true);
  });

  it("supports fail → blocked downstream and checkpoint resume", async () => {
    const created = await request(app)
      .post("/api/subtasks/from-plan")
      .send({
        runId: "run-http-2",
        planVersion: 1,
        planApproved: true,
        autoSchedule: false,
        steps: ["A 写入", "B 写入"]
      })
      .expect(201);

    await request(app).post("/api/subtasks/runs/run-http-2/schedule").expect(200);
    await request(app)
      .post(`/api/subtasks/runs/run-http-2/subtasks/${created.body.subtasks[0].id}/fail`)
      .send({ error: "boom" })
      .expect(200);

    const dag = await request(app).get("/api/subtasks/runs/run-http-2").expect(200);
    expect(dag.body.subtasks[1].status).toBe("blocked");

    await request(app).post("/api/subtasks/runs/run-http-2/checkpoint").send({ note: "snap" }).expect(200);
    const resume = await request(app).post("/api/subtasks/runs/run-http-2/resume").expect(200);
    expect(resume.body.resumed).toBe(true);
  });

  it("major correction returns needsAskReplan", async () => {
    await request(app)
      .post("/api/subtasks/from-plan")
      .send({
        runId: "run-http-3",
        planVersion: 1,
        planApproved: true,
        steps: ["A"]
      })
      .expect(201);

    const correction = await request(app)
      .post("/api/subtasks/runs/run-http-3/correct")
      .send({ note: "改方案", major: true })
      .expect(200);

    expect(correction.body.needsAskReplan).toBe(true);
    expect(correction.body.dag.status).toBe("awaiting_replan");
  });
});
