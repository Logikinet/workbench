import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../http/app.js";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { RunService } from "../runs/runService.js";
import { TodoService } from "../todos/todoService.js";

describe("Firstmate and Secondmate planning approval contract", () => {
  let root: string;
  let todos: TodoService;
  let runs: RunService;
  let todoId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-planning-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({ title: "修复登录回归" })).id;
    runs = await RunService.open(join(root, "runs.json"), todos);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("has Firstmate classify the Run, displays assumptions, and records a complexity-matched Secondmate plan", async () => {
    const run = await runs.create(todoId, "修复登录回归并添加覆盖该问题的测试。");

    expect(run).toMatchObject({
      status: "awaiting_plan_approval",
      planning: {
        approvalStatus: "awaiting_approval",
        assessment: {
          taskType: "bug_fix",
          requiredCapabilities: expect.arrayContaining(["workspace", "tests"]),
          criticalInputs: [],
          assumptions: expect.any(Array)
        }
      }
    });
    expect(run.planVersions).toHaveLength(1);
    expect(run.planVersions[0]).toMatchObject({
      generatedBy: "secondmate",
      steps: expect.any(Array),
      acceptanceCriteria: expect.any(Array),
      risks: expect.any(Array),
      prohibitions: expect.arrayContaining([expect.stringContaining("Firstmate")])
    });
    expect(run.artifacts).toEqual([]);
  });

  it("only pauses for a missing critical result and turns user context into a new plan", async () => {
    const run = await runs.create(todoId);
    expect(run).toMatchObject({ status: "planning", planning: { approvalStatus: "awaiting_input" } });
    expect(run.planning?.assessment.criticalInputs).toHaveLength(1);

    const planned = await runs.updatePlanning(run.id, {
      additionalContext: "成功标准是用户能够使用已有账号登录，且回归测试通过。"
    });
    expect(planned).toMatchObject({ status: "awaiting_plan_approval", planning: { approvalStatus: "awaiting_approval" } });
    expect(planned.planVersions).toHaveLength(1);
  });

  it("lets users correct classification, return a plan for a new version, approve it, or cancel it", async () => {
    const run = await runs.create(todoId, "调查登录回归的根因，并给出一份报告。");
    const corrected = await runs.updatePlanning(run.id, {
      taskType: "research",
      requiredCapabilities: ["workspace", "documents"]
    });
    expect(corrected.planning?.assessment).toMatchObject({ taskType: "research", requiredCapabilities: ["workspace", "documents"] });
    expect(corrected.planVersions).toHaveLength(2);

    const returned = await runs.decidePlan(run.id, { decision: "returned", summary: "补充回归范围和已知风险。" });
    expect(returned).toMatchObject({ status: "awaiting_plan_approval", planning: { approvalStatus: "awaiting_approval" } });
    expect(returned.approvals.at(-1)).toMatchObject({ decision: "returned" });
    expect(returned.planVersions).toHaveLength(3);

    const approved = await runs.decidePlan(run.id, { decision: "approved", summary: "计划边界明确，批准。" });
    expect(approved).toMatchObject({ status: "queued", planning: { approvalStatus: "approved", approvedPlanVersion: 3 } });

    const cancelled = await runs.create(todoId, "修复一个小问题");
    expect(await runs.decidePlan(cancelled.id, { decision: "cancelled", summary: "暂不执行。" })).toMatchObject({
      status: "cancelled",
      planning: { approvalStatus: "cancelled" }
    });
  });

  it("blocks execution and formal Artifacts until the current plan is approved", async () => {
    const run = await runs.create(todoId, "修复登录回归并添加测试。");

    await expect(runs.transition(run.id, "running", "开始执行")).rejects.toThrow("approved plan");
    await expect(runs.transition(run.id, "awaiting_review", "伪造执行结束")).rejects.toThrow(/controlled finish|independent review|approved plan/);
    await expect(runs.transition(run.id, "completed", "伪造完成")).rejects.toThrow(/controlled finish|independent review|formal user acceptance|approved plan/);
    await expect(runs.recordArtifact(run.id, { path: "fix.md", kind: "document" })).rejects.toThrow("approved plan");

    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await expect(runs.transition(run.id, "running", "开始执行")).resolves.toMatchObject({ status: "running" });
    await expect(runs.recordArtifact(run.id, { path: "fix.md", kind: "document" })).resolves.toMatchObject({ artifacts: [expect.objectContaining({ path: "fix.md" })] });
  });

  it("does not let legacy plan calls bypass missing key input or revive a cancelled plan", async () => {
    const missingInput = await runs.create(todoId);
    await expect(runs.recordPlanVersion(missingInput.id, { revisionNote: "尝试绕过计划" })).rejects.toThrow("critical input");

    const cancelled = await runs.create(todoId, "修复登录回归并添加测试。");
    await runs.decidePlan(cancelled.id, { decision: "cancelled", summary: "不再执行。" });
    await expect(runs.updatePlanning(cancelled.id, { additionalContext: "重新开始" })).rejects.toThrow("cancelled");
    await expect(runs.decidePlan(cancelled.id, { decision: "approved", summary: "绕过取消。" })).rejects.toThrow("cancelled");
  });

  it("exposes correction and plan decisions through the local Run API", async () => {
    const app = createApp({ version: "0.1.0", todos, runs });
    const created = await request(app).post(`/api/todos/${todoId}/runs`).send({ message: "调查登录问题并形成报告。" }).expect(201);

    const corrected = await request(app)
      .patch(`/api/runs/${created.body.id}/planning`)
      .send({ taskType: "research", requiredCapabilities: ["workspace", "documents"] })
      .expect(200);
    expect(corrected.body.planning.assessment).toMatchObject({ taskType: "research" });

    await request(app)
      .post(`/api/runs/${created.body.id}/plan-versions`)
      .send({ version: 999, summary: "用户伪造的计划摘要" })
      .expect(400);

    const regenerated = await request(app)
      .post(`/api/runs/${created.body.id}/plan-versions`)
      .send({ revisionNote: "请重新生成并保留结构化验收与风险。" })
      .expect(201);
    expect(regenerated.body.planVersions.at(-1)).toMatchObject({ generatedBy: "secondmate", steps: expect.any(Array), acceptanceCriteria: expect.any(Array) });

    const approved = await request(app)
      .post(`/api/runs/${created.body.id}/plan-decisions`)
      .send({ decision: "approved", summary: "批准此计划。" })
      .expect(200);
    expect(approved.body).toMatchObject({ status: "queued", planning: { approvalStatus: "approved" } });
  });
});
