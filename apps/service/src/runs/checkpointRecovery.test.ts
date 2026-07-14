import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../http/app.js";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { TodoService } from "../todos/todoService.js";
import {
  captureWorkspaceFingerprint,
  CHECKPOINT_RECOVERY_NOTE,
  RunService
} from "./runService.js";

describe("step-level checkpoint and interrupt recovery", () => {
  let root: string;
  let workspace: string;
  let projects: ProjectService;
  let todos: TodoService;
  let runs: RunService;
  let todoId: string;
  let statePath: string;

  const agent = {
    source: "temporary" as const,
    name: "检查点 Agent",
    responsibility: "写入文件",
    systemInstruction: "返回 JSON",
    connectionId: "connection-checkpoint",
    tools: ["filesystem"]
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-checkpoint-"));
    workspace = join(root, "workspace");
    await mkdir(workspace);
    projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    const grant = await projects.requestWorkspaceAuthorization(workspace);
    const project = await projects.create({
      name: "Checkpoint Project",
      workspacePath: workspace,
      authorizationGrantId: grant.id
    });
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({ title: "检查点恢复任务", projectId: project.id })).id;
    statePath = join(root, "runs.json");
    runs = await RunService.open(statePath, todos);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function approvedRunningRun() {
    const run = await runs.create(todoId, "请分步写入文档。");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准计划。" });
    await runs.beginProfessionalExecution(run.id, agent);
    return run;
  }

  it("writes a durable checkpoint after each critical step with summary, artifacts and next-step info", async () => {
    const run = await approvedRunningRun();
    await writeFile(join(workspace, "step-a.md"), "A", "utf8");
    const fingerprint = await captureWorkspaceFingerprint(workspace, ["step-a.md"]);
    await runs.recordArtifact(run.id, { path: "step-a.md", kind: "file" });
    await runs.recordExecutionStep(run.id, "write_file:step-a.md", {
      summary: "完成步骤 A",
      nextStep: "write_file:step-b.md",
      workspaceFingerprint: fingerprint,
      actionKind: "write_file",
      dangerous: false
    });

    const detail = await runs.get(run.id);
    expect(detail.checkpoints).toHaveLength(1);
    expect(detail.checkpoints[0]).toMatchObject({
      step: "write_file:step-a.md",
      stepStatus: "completed",
      summary: "完成步骤 A",
      nextStep: "write_file:step-b.md",
      artifactPaths: ["step-a.md"],
      completedSteps: ["write_file:step-a.md"],
      recoveryMode: "reconstruct_and_replay",
      dangerous: false
    });
    expect(detail.timeline.some((event) => event.kind === "checkpoint")).toBe(true);
    expect(detail.checkpointRecovery?.status).toBe("ready");
  });

  it("restores checkpoints across service reopen and lists completed/failed/interrupted steps", async () => {
    const run = await approvedRunningRun();
    const fingerprint = await captureWorkspaceFingerprint(workspace, []);
    await runs.recordExecutionStep(run.id, "write_file:done.md", {
      summary: "已完成",
      workspaceFingerprint: fingerprint
    });
    await runs.beginExecutionStep(run.id, "write_file:mid.md");
    await runs.failProfessionalExecution(run.id, "服务中断模拟");

    const restarted = await RunService.open(statePath, todos);
    const restored = await restarted.get(run.id);
    expect(restored.checkpoints.map((checkpoint) => checkpoint.stepStatus)).toEqual(
      expect.arrayContaining(["completed", "interrupted"])
    );
    expect(restored.execution.completedSteps).toEqual(["write_file:done.md"]);
    expect(restored.checkpointRecovery?.interruptedStep).toBe("write_file:mid.md");

    const interrupted = await restarted.listInterruptedRuns();
    expect(interrupted.some((entry) => entry.runId === run.id)).toBe(true);
    expect(interrupted.find((entry) => entry.runId === run.id)).toMatchObject({
      completedSteps: ["write_file:done.md"],
      interruptedStep: "write_file:mid.md"
    });
  });

  it("marks actively running executions as interrupted with checkpoint metadata after service reopen", async () => {
    const run = await approvedRunningRun();
    await runs.beginExecutionStep(run.id, "write_file:orphan.md");
    const restarted = await RunService.open(statePath, todos);
    const restored = await restarted.get(run.id);
    expect(restored).toMatchObject({
      status: "interrupted",
      execution: { status: "failed", retryable: true }
    });
    expect(restored.checkpoints.at(-1)).toMatchObject({
      step: "write_file:orphan.md",
      stepStatus: "interrupted"
    });
  });

  it("pauses resume when the workspace fingerprint no longer matches the last checkpoint", async () => {
    const run = await approvedRunningRun();
    await writeFile(join(workspace, "notes.md"), "original", "utf8");
    const fingerprint = await captureWorkspaceFingerprint(workspace, ["notes.md"]);
    await runs.recordArtifact(run.id, { path: "notes.md", kind: "file" });
    await runs.recordExecutionStep(run.id, "write_file:notes.md", {
      summary: "写入 notes",
      workspaceFingerprint: fingerprint
    });
    await runs.beginExecutionStep(run.id, "write_file:next.md");
    await runs.failProfessionalExecution(run.id, "中断");

    await writeFile(join(workspace, "notes.md"), "externally changed", "utf8");
    const current = await captureWorkspaceFingerprint(workspace, ["notes.md"]);
    const result = await runs.resumeFromCheckpoint(run.id, { currentFingerprint: current });

    expect(result.canContinue).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.run.status).toBe("paused");
    expect(result.run.checkpointRecovery).toMatchObject({
      status: "conflict",
      conflictReason: expect.stringContaining("外部修改")
    });
  });

  it("does not auto-replay dangerous interrupted steps without explicit re-approval", async () => {
    const run = await approvedRunningRun();
    const fingerprint = await captureWorkspaceFingerprint(workspace, []);
    await runs.recordExecutionStep(run.id, "write_file:safe.md", {
      summary: "安全步骤",
      workspaceFingerprint: fingerprint
    });
    await runs.recordStepCheckpoint(run.id, {
      step: "delete_file:legacy.md",
      stepStatus: "interrupted",
      summary: "危险删除中断",
      workspaceFingerprint: fingerprint,
      actionKind: "delete_file",
      dangerous: true
    });
    await runs.failProfessionalExecution(run.id, "危险步骤中断");

    const blocked = await runs.resumeFromCheckpoint(run.id, {
      currentFingerprint: fingerprint,
      approveDangerousReplay: false
    });
    expect(blocked.canContinue).toBe(false);
    expect(blocked.requiresDangerousReapproval).toBe(true);
    expect(blocked.run.execution.pendingApproval).toMatchObject({
      status: "awaiting_confirmation",
      kind: "delete_file"
    });

    // UI contract: approveDangerousReplay alone settles the pending checkpoint gate (no separate approval API).
    const allowed = await runs.resumeFromCheckpoint(run.id, {
      currentFingerprint: fingerprint,
      approveDangerousReplay: true
    });
    expect(allowed.canContinue).toBe(true);
    expect(allowed.run.execution.pendingApproval?.status).toBe("approved");
    expect(allowed.resumePlan?.recoveryMode).toBe("reconstruct_and_replay");
    expect(allowed.resumePlan?.note).toContain("不会恢复原模型内部会话");
  });

  it("does not list healthy completed/running checkpoint runs in interrupted-runs", async () => {
    const healthy = await approvedRunningRun();
    const fingerprint = await captureWorkspaceFingerprint(workspace, []);
    await runs.recordExecutionStep(healthy.id, "write_file:ok.md", {
      summary: "进行中检查点",
      workspaceFingerprint: fingerprint
    });
    expect((await runs.get(healthy.id)).checkpointRecovery?.status).toBe("ready");
    expect((await runs.listInterruptedRuns()).some((entry) => entry.runId === healthy.id)).toBe(false);

    await runs.finishProfessionalExecution(healthy.id, "完成");
    expect((await runs.listInterruptedRuns()).some((entry) => entry.runId === healthy.id)).toBe(false);

    const broken = await approvedRunningRun();
    await runs.recordExecutionStep(broken.id, "write_file:a.md", { workspaceFingerprint: fingerprint });
    await runs.beginExecutionStep(broken.id, "write_file:b.md");
    await runs.failProfessionalExecution(broken.id, "失败可恢复");
    expect((await runs.listInterruptedRuns()).some((entry) => entry.runId === broken.id)).toBe(true);
  });

  it("fail-closes resume when a non-empty baseline exists but current fingerprint is omitted", async () => {
    const run = await approvedRunningRun();
    await writeFile(join(workspace, "base.md"), "v1", "utf8");
    const fingerprint = await captureWorkspaceFingerprint(workspace, ["base.md"]);
    await runs.recordArtifact(run.id, { path: "base.md", kind: "file" });
    await runs.recordExecutionStep(run.id, "write_file:base.md", { workspaceFingerprint: fingerprint });
    await runs.failProfessionalExecution(run.id, "中断");

    const result = await runs.resumeFromCheckpoint(run.id, {});
    expect(result.canContinue).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.reason).toEqual(expect.stringContaining("指纹"));
  });

  it("preserves approved plan, review records and approvals when resuming from a checkpoint", async () => {
    const run = await approvedRunningRun();
    const before = await runs.get(run.id);
    const approvedPlanVersion = before.planning?.approvedPlanVersion;
    expect(approvedPlanVersion).toBeDefined();

    // Simulate prior independent review history still present after interrupt.
    before.reviews.push({
      id: "review-keep",
      status: "changes_requested",
      summary: "先前审查记录",
      createdAt: new Date().toISOString(),
      kind: "independent",
      severity: "medium",
      evidence: ["log"],
      findings: [{ criterion: "验收", met: false, evidence: "缺文件", severity: "medium" }],
      cycle: 1,
      role: "reviewer"
    });
    before.reviewLoop = {
      autoFixCyclesUsed: 0,
      maxAutoFixCycles: 1,
      latestReviewId: "review-keep"
    };
    await writeFile(statePath, `${JSON.stringify({ schemaVersion: 1, runs: [before] }, null, 2)}\n`, "utf8");
    runs = await RunService.open(statePath, todos);

    const fingerprint = await captureWorkspaceFingerprint(workspace, []);
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.recordExecutionStep(run.id, "write_file:a.md", { workspaceFingerprint: fingerprint });
    await runs.beginExecutionStep(run.id, "write_file:b.md");
    await runs.failProfessionalExecution(run.id, "中断以恢复");

    const approvalCount = (await runs.get(run.id)).approvals.length;
    const result = await runs.resumeFromCheckpoint(run.id, { currentFingerprint: fingerprint });
    expect(result.canContinue).toBe(true);
    expect(result.run.planning?.approvalStatus).toBe("approved");
    expect(result.run.planning?.approvedPlanVersion).toBe(approvedPlanVersion);
    expect(result.run.reviews.map((review) => review.id)).toContain("review-keep");
    expect(result.run.reviewLoop?.latestReviewId).toBe("review-keep");
    expect(result.run.approvals).toHaveLength(approvalCount);
    expect(result.resumePlan?.reviewIds).toContain("review-keep");
    expect(result.resumePlan?.note).toBe(CHECKPOINT_RECOVERY_NOTE);
  });

  it("exposes interrupted runs and checkpoint resume through the local HTTP API", async () => {
    const run = await approvedRunningRun();
    const fingerprint = await captureWorkspaceFingerprint(workspace, []);
    await runs.recordExecutionStep(run.id, "write_file:http.md", {
      summary: "HTTP 检查点",
      workspaceFingerprint: fingerprint
    });
    await runs.beginExecutionStep(run.id, "write_file:http-next.md");
    await runs.failProfessionalExecution(run.id, "HTTP 中断");

    const app = createApp({ version: "0.1.0", projects, todos, runs });
    const listed = await request(app).get("/api/interrupted-runs").expect(200);
    expect(listed.body.some((entry: { runId: string }) => entry.runId === run.id)).toBe(true);

    const checkpoints = await request(app).get(`/api/runs/${run.id}/checkpoints`).expect(200);
    expect(checkpoints.body.checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.body.recoveryNote).toEqual(expect.stringContaining("不会恢复原模型内部会话"));

    const resumed = await request(app)
      .post(`/api/runs/${run.id}/checkpoint-resume`)
      .send({ workspaceFingerprint: fingerprint })
      .expect(202);
    expect(resumed.body.canContinue).toBe(true);
    expect(resumed.body.run.status).toBe("queued");
    expect(resumed.body.resumePlan.recoveryMode).toBe("reconstruct_and_replay");
  });

  it("returns HTTP 409 when checkpoint resume detects an external workspace modification", async () => {
    const run = await approvedRunningRun();
    await writeFile(join(workspace, "guard.md"), "v1", "utf8");
    const fingerprint = await captureWorkspaceFingerprint(workspace, ["guard.md"]);
    await runs.recordArtifact(run.id, { path: "guard.md", kind: "file" });
    await runs.recordExecutionStep(run.id, "write_file:guard.md", {
      workspaceFingerprint: fingerprint
    });
    await runs.failProfessionalExecution(run.id, "中断");
    await writeFile(join(workspace, "guard.md"), "v2", "utf8");
    const current = await captureWorkspaceFingerprint(workspace, ["guard.md"]);

    const app = createApp({ version: "0.1.0", projects, todos, runs });
    const conflict = await request(app)
      .post(`/api/runs/${run.id}/checkpoint-resume`)
      .send({ workspaceFingerprint: current })
      .expect(409);
    expect(conflict.body.conflict).toBe(true);
    expect(conflict.body.canContinue).toBe(false);
  });
});
