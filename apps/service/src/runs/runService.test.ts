import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../http/app.js";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { TodoService } from "../todos/todoService.js";
import { RunService } from "./runService.js";

describe("Todo Run history and timeline contract", () => {
  let root: string;
  let projects: ProjectService;
  let todos: TodoService;
  let runs: RunService;
  let todoId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-runs-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({ title: "多次执行" })).id;
    runs = await RunService.open(join(root, "runs.json"), todos);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("starts multiple independent Runs from one Todo without overwriting history", async () => {
    const app = createApp({ version: "0.1.0", projects, todos, runs });
    const first = await request(app)
      .post(`/api/todos/${todoId}/runs`)
      .send({ message: "第一次尝试" })
      .expect(201);
    const second = await request(app)
      .post(`/api/todos/${todoId}/runs`)
      .send({ message: "修正后重试" })
      .expect(201);

    expect(first.body).toMatchObject({ todoId, attempt: 1, status: "awaiting_plan_approval" });
    expect(second.body).toMatchObject({ todoId, attempt: 2, status: "awaiting_plan_approval" });
    expect(first.body.id).not.toBe(second.body.id);

    const history = await request(app).get(`/api/todos/${todoId}/runs`).expect(200);
    expect(history.body.map((run: { id: string }) => run.id)).toEqual([second.body.id, first.body.id]);
    expect((await runs.get(first.body.id)).messages.map((message) => message.content)).toEqual(["第一次尝试"]);
    expect((await runs.get(second.body.id)).messages.map((message) => message.content)).toEqual(["修正后重试"]);
  });

  it("keeps messages, plan versions, logs, reviews, artifacts and state changes in one ordered timeline", async () => {
    const run = await runs.create(todoId, "请开始规划");
    await runs.recordApproval(run.id, { decision: "approved", summary: "用户批准计划" });
    await runs.transition(run.id, "running", "专业代理开始执行");
    await runs.recordLog(run.id, { level: "info", message: "读取项目" });
    await runs.recordReview(run.id, { status: "changes_requested", summary: "缺少验证" });
    await runs.recordArtifact(run.id, { path: "report.md", kind: "document" });

    const detail = await runs.get(run.id);
    expect(detail.messages).toHaveLength(1);
    expect(detail.planVersions).toHaveLength(1);
    expect(detail.logs).toHaveLength(1);
    expect(detail.reviews).toHaveLength(1);
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.timeline.map((event) => event.kind)).toEqual([
      "user_message",
      "agent_status",
      "agent_status",
      "plan_version",
      "approval",
      "agent_status",
      "agent_status",
      "log",
      "review",
      "artifact"
    ]);
  });

  it("restores every Run and its latest critical state after a service restart", async () => {
    const run = await runs.create(todoId, "恢复测试");
    await runs.transition(run.id, "paused", "等待用户确认");

    const restarted = await RunService.open(join(root, "runs.json"), todos);
    expect(await restarted.get(run.id)).toMatchObject({ id: run.id, status: "paused" });
    expect((await restarted.get(run.id)).timeline.at(-1)).toMatchObject({ kind: "agent_status" });
  });

  it("pauses only Runs bound to an unavailable connection and surfaces the reason in the timeline", async () => {
    const affected = await runs.create(todoId, "使用连接 A", "connection-a");
    const unaffected = await runs.create(todoId, "使用连接 B", "connection-b");
    await runs.decidePlan(affected.id, { decision: "approved", summary: "批准连接 A 的计划" });
    await runs.decidePlan(unaffected.id, { decision: "approved", summary: "批准连接 B 的计划" });
    await runs.transition(affected.id, "running", "执行中");
    await runs.transition(unaffected.id, "running", "执行中");

    await runs.pauseForConnection("connection-a", "模型连接认证失败");

    expect(await runs.get(affected.id)).toMatchObject({ status: "paused" });
    expect((await runs.get(affected.id)).timeline.at(-1)).toMatchObject({ summary: "模型连接认证失败" });
    expect(await runs.get(unaffected.id)).toMatchObject({ status: "running" });
  });

  it("accepts plan, approval, agent state, log, review and artifact updates through the local Run API", async () => {
    const run = await runs.create(todoId, "从 API 写入时间线");
    const app = createApp({ version: "0.1.0", projects, todos, runs });

    await request(app).post(`/api/runs/${run.id}/approvals`).send({ decision: "approved", summary: "用户批准" }).expect(201);
    await request(app).post(`/api/runs/${run.id}/status`).send({ status: "running", summary: "开始执行" }).expect(201);
    await request(app).post(`/api/runs/${run.id}/logs`).send({ level: "info", message: "读取文件" }).expect(201);
    await request(app).post(`/api/runs/${run.id}/reviews`).send({ status: "passed", summary: "审查通过" }).expect(201);
    await request(app).post(`/api/runs/${run.id}/artifacts`).send({ path: "output.md", kind: "document" }).expect(201);

    const detail = await request(app).get(`/api/runs/${run.id}`).expect(200);
    expect(detail.body.timeline.map((event: { kind: string }) => event.kind)).toEqual([
      "user_message",
      "agent_status",
      "agent_status",
      "plan_version",
      "approval",
      "agent_status",
      "agent_status",
      "log",
      "review",
      "artifact"
    ]);
  });

  it("does not replan an active execution and recovers an orphaned execution after restart", async () => {
    const run = await runs.create(todoId, "执行恢复测试");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    const agent = {
      source: "temporary" as const,
      name: "恢复测试 Agent",
      responsibility: "写入文件",
      systemInstruction: "返回 JSON",
      connectionId: "connection-a",
      tools: ["filesystem"]
    };
    await runs.beginProfessionalExecution(run.id, agent);

    await expect(runs.updatePlanning(run.id, { additionalContext: "不应在运行中改计划" })).rejects.toThrow("active Professional Agent");
    await expect(runs.recordPlanVersion(run.id, { revisionNote: "不应在运行中生成" })).rejects.toThrow("active Professional Agent");

    const restarted = await RunService.open(join(root, "runs.json"), todos);
    expect(await restarted.get(run.id)).toMatchObject({
      status: "interrupted",
      execution: { status: "failed", retryable: true, lastError: expect.stringContaining("服务重启") }
    });
    await expect(restarted.beginProfessionalExecution(run.id, agent)).resolves.toMatchObject({ status: "running" });
  });

  it("notifies an active executor when a connection pause interrupts its Run", async () => {
    const run = await runs.create(todoId, "暂停通知测试");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    const interrupted: string[] = [];
    const unsubscribe = runs.onExecutionInterrupted((runId) => interrupted.push(runId));
    await runs.beginProfessionalExecution(run.id, {
      source: "temporary",
      name: "暂停测试 Agent",
      responsibility: "写入文件",
      systemInstruction: "返回 JSON",
      connectionId: "connection-pause",
      tools: ["filesystem"]
    });

    await runs.pauseForConnection("connection-pause", "模型连接不可用");
    unsubscribe();

    expect(interrupted).toEqual([run.id]);
  });

  it("does not retain execution or Artifact authorization after a status-only pause or cancellation", async () => {
    const agent = {
      source: "temporary" as const,
      name: "状态边界 Agent",
      responsibility: "写入文件",
      systemInstruction: "返回 JSON",
      connectionId: "connection-status",
      tools: ["filesystem"]
    };
    const paused = await runs.create(todoId, "暂停前未执行");
    await runs.decidePlan(paused.id, { decision: "approved", summary: "批准。" });
    await runs.transition(paused.id, "paused", "等待确认");
    await expect(runs.beginProfessionalExecution(paused.id, agent)).rejects.toThrow("paused");
    await expect(runs.recordArtifact(paused.id, { path: "paused.md", kind: "file" })).rejects.toThrow("paused");

    const cancelled = await runs.create(todoId, "取消前未执行");
    await runs.decidePlan(cancelled.id, { decision: "approved", summary: "批准。" });
    await runs.transition(cancelled.id, "cancelled", "用户取消");
    await expect(runs.beginProfessionalExecution(cancelled.id, agent)).rejects.toThrow("cancelled");
    await expect(runs.transition(cancelled.id, "queued", "不应重新启动")).rejects.toThrow("cancelled");

    const stoppedBeforeApproval = await runs.create(todoId, "停止后不得批准计划");
    await runs.stop(stoppedBeforeApproval.id, "用户停止尚未批准的 Run");
    await expect(runs.decidePlan(stoppedBeforeApproval.id, { decision: "approved", summary: "不应复活已停止 Run" })).rejects.toThrow("cancelled");
    await expect(runs.updatePlanning(stoppedBeforeApproval.id, { additionalContext: "不应重新规划已停止 Run" })).rejects.toThrow("cancelled");
    await expect(runs.recordPlanVersion(stoppedBeforeApproval.id, { revisionNote: "不应为已停止 Run 新建计划" })).rejects.toThrow("cancelled");
  });

  it("serializes concurrent execution activity and pause persistence without losing the final paused state", async () => {
    const run = await runs.create(todoId, "并发持久化测试");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(run.id, {
      source: "temporary",
      name: "并发 Agent",
      responsibility: "写入文件",
      systemInstruction: "返回 JSON",
      connectionId: "connection-race",
      tools: ["filesystem"]
    });

    await Promise.all([
      runs.recordExecutionStep(run.id, "write_file:before-pause.md"),
      runs.pauseForConnection("connection-race", "连接在写入后暂停")
    ]);

    const restarted = await RunService.open(join(root, "runs.json"), todos);
    expect(await restarted.get(run.id)).toMatchObject({
      status: "paused",
      execution: { status: "failed", completedSteps: ["write_file:before-pause.md"], retryable: true }
    });
  });

  it("keeps an authorized workspace operation and a user stop serialized so no write can begin after the stop takes effect", async () => {
    const agent = {
      source: "temporary" as const,
      name: "原子写入 Agent",
      responsibility: "写入文件",
      systemInstruction: "返回 JSON",
      connectionId: "connection-atomic",
      tools: ["filesystem"]
    };
    const run = await runs.create(todoId, "原子停止测试");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(run.id, agent);
    let releaseWrite: () => void = () => undefined;
    const writeCanFinish = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let markWriteStarted: () => void = () => undefined;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });

    const writing = runs.withActiveExecution(run.id, "Agent workspace write", async () => {
      markWriteStarted();
      await writeCanFinish;
    });
    await writeStarted;
    const stopping = runs.stop(run.id, "用户停止原子写入测试");
    expect(await runs.get(run.id)).toMatchObject({ status: "running", execution: { status: "running" } });

    releaseWrite();
    await writing;
    await stopping;
    expect(await runs.get(run.id)).toMatchObject({ status: "cancelled", execution: { status: "failed", retryable: false } });
  });

  it("does not let a late abort failure overwrite a newly reapproved queued plan", async () => {
    const agent = {
      source: "temporary" as const,
      name: "重新审批 Agent",
      responsibility: "写入文件",
      systemInstruction: "返回 JSON",
      connectionId: "connection-reapproval",
      tools: ["filesystem"]
    };
    const run = await runs.create(todoId, "重新审批竞态");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.transition(run.id, "interrupted", "用户纠偏导致旧执行中断。");
    await runs.submitCorrection(run.id, { instruction: "将范围扩大后重新审批。", changeKind: "scope" });
    await runs.decidePlan(run.id, { decision: "approved", summary: "用户已重新批准纠偏后的计划。" });
    await runs.failProfessionalExecution(run.id, "Professional Agent request was interrupted.");

    expect(await runs.get(run.id)).toMatchObject({
      status: "queued",
      planning: { approvalStatus: "approved" },
      execution: { status: "failed", retryable: true, lastError: "用户纠偏导致旧执行中断。" }
    });
  });

  it("requires a new Run instead of replanning an execution that has already succeeded", async () => {
    const agent = {
      source: "temporary" as const,
      name: "已完成 Agent",
      responsibility: "写入文件",
      systemInstruction: "返回 JSON",
      connectionId: "connection-completed",
      tools: ["filesystem"]
    };
    const run = await runs.create(todoId, "已完成后纠偏");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.finishProfessionalExecution(run.id, "执行已完成。");

    await expect(runs.submitCorrection(run.id, { instruction: "将范围扩大。", changeKind: "scope" })).rejects.toThrow("completed execution");
    expect(await runs.get(run.id)).toMatchObject({ status: "awaiting_review", execution: { status: "succeeded" } });
  });

  it("does not let generic status transitions bypass an execution approval or the consecutive-failure safety limit", async () => {
    const agent = {
      source: "temporary" as const,
      name: "状态绕过 Agent",
      responsibility: "写入文件",
      systemInstruction: "返回 JSON",
      connectionId: "connection-status-guard",
      tools: ["filesystem"]
    };
    const approvalPending = await runs.create(todoId, "待确认状态绕过");
    await runs.decidePlan(approvalPending.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(approvalPending.id, agent);
    await runs.requestExecutionApproval(approvalPending.id, { kind: "delete_file", summary: "需要确认删除。" });
    const app = createApp({ version: "0.1.0", projects, todos, runs });
    await request(app)
      .post(`/api/runs/${approvalPending.id}/status`)
      .send({ status: "queued", summary: "不应绕过确认" })
      .expect(400);
    await expect(runs.transition(approvalPending.id, "queued", "不应绕过确认" )).rejects.toThrow("awaiting confirmation");

    const capped = await runs.create(todoId, "失败上限状态绕过");
    await runs.decidePlan(capped.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(capped.id, agent);
    await runs.beginExecutionStep(capped.id, "write_file:blocked.md");
    await runs.failProfessionalExecution(capped.id, "失败一次");
    await runs.beginProfessionalExecution(capped.id, agent);
    await runs.beginExecutionStep(capped.id, "write_file:blocked.md");
    await runs.failProfessionalExecution(capped.id, "失败两次");
    await expect(runs.transition(capped.id, "queued", "不应绕过失败上限" )).rejects.toThrow("not retryable");
  });

  it("terminates a pending dangerous-action approval when the user stops its Run", async () => {
    const agent = {
      source: "temporary" as const,
      name: "停止确认 Agent",
      responsibility: "写入文件",
      systemInstruction: "返回 JSON",
      connectionId: "connection-stop-approval",
      tools: ["filesystem"]
    };
    const run = await runs.create(todoId, "停止待确认操作");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.requestExecutionApproval(run.id, { kind: "delete_file", summary: "需要确认删除。" });
    await runs.stop(run.id, "用户停止待确认的 Run");

    expect(await runs.get(run.id)).toMatchObject({
      status: "cancelled",
      execution: { pendingApproval: { status: "rejected", decisionSummary: expect.stringContaining("用户停止") } }
    });
    await expect(runs.decideExecutionApproval(run.id, { decision: "approved", summary: "不应接受停止后的批准" })).rejects.toThrow("does not have an execution approval awaiting");
  });

  it("records a user stop, correction, dangerous-action decision and reapproval request in the Run timeline", async () => {
    const agent = {
      source: "temporary" as const,
      name: "受控执行 Agent",
      responsibility: "写入文件",
      systemInstruction: "返回 JSON",
      connectionId: "connection-controls",
      tools: ["filesystem"]
    };
    const stopped = await runs.create(todoId, "停止测试");
    await runs.decidePlan(stopped.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(stopped.id, agent);
    await runs.stop(stopped.id, "用户停止此 Run");
    expect(await runs.get(stopped.id)).toMatchObject({ status: "cancelled", execution: { status: "failed", retryable: false } });

    const controlled = await runs.create(todoId, "纠偏与确认测试");
    await runs.decidePlan(controlled.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(controlled.id, agent);
    await runs.requestExecutionApproval(controlled.id, {
      kind: "delete_file",
      summary: "代理请求删除 project/legacy.md；需要用户确认。"
    });
    await runs.decideExecutionApproval(controlled.id, { decision: "rejected", summary: "保留旧文件。" });
    const correction = await runs.submitCorrection(controlled.id, {
      instruction: "将验收条件改为同时保留旧文件并生成迁移说明。",
      changeKind: "acceptance"
    });

    expect(correction.requiresReapproval).toBe(true);
    expect(correction.run).toMatchObject({
      status: "awaiting_plan_approval",
      planning: { approvalStatus: "awaiting_approval" }
    });
    expect(correction.run.planVersions).toHaveLength(2);
    expect(correction.run.timeline.map((event) => event.kind)).toEqual(expect.arrayContaining(["approval", "correction", "plan_version"]));
    expect((await runs.get(stopped.id)).timeline.map((event) => event.summary).join("\n")).toContain("用户停止此 Run");
    expect(correction.run.timeline.map((event) => event.summary).join("\n")).toContain("保留旧文件");
  });

  it("pauses a repeatedly failing execution step at the configured safety limit instead of retrying forever", async () => {
    const agent = {
      source: "temporary" as const,
      name: "失败限制 Agent",
      responsibility: "写入文件",
      systemInstruction: "返回 JSON",
      connectionId: "connection-failures",
      tools: ["filesystem"]
    };
    const run = await runs.create(todoId, "连续失败限制");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.beginExecutionStep(run.id, "write_file:unstable.md");
    await runs.failProfessionalExecution(run.id, "磁盘写入失败");
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.beginExecutionStep(run.id, "write_file:unstable.md");
    await runs.failProfessionalExecution(run.id, "磁盘写入失败");

    expect(await runs.get(run.id)).toMatchObject({
      status: "paused",
      execution: {
        status: "failed",
        retryable: false,
        failureCounts: { "write_file:unstable.md": 2 },
        maxConsecutiveFailures: 2
      }
    });
    await expect(runs.beginProfessionalExecution(run.id, agent)).rejects.toThrow("paused");

    await runs.submitCorrection(run.id, { instruction: "仅改用稳定写入方式后继续。", changeKind: "minor" });
    expect(await runs.get(run.id)).toMatchObject({
      status: "paused",
      execution: { retryable: true, failureCounts: {} }
    });
    await runs.resumeRetryableExecution(run.id);
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.beginExecutionStep(run.id, "write_file:unstable.md");
    await runs.failProfessionalExecution(run.id, "磁盘写入失败");
    expect(await runs.get(run.id)).toMatchObject({
      status: "failed",
      execution: { retryable: true, failureCounts: { "write_file:unstable.md": 1 } }
    });
  });
});
