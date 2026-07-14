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
import {
  assembleReviewContext,
  buildFixInstruction,
  evaluateReview,
  ReviewService
} from "./reviewService.js";

describe("No-mistakes independent review loop", () => {
  let root: string;
  let projects: ProjectService;
  let todos: TodoService;
  let runs: RunService;
  let reviews: ReviewService;
  let todoId: string;
  let fixDispatches: string[];
  let fixEvidenceMode: "full" | "thin";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-review-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    const project = await projects.create({
      name: "审查项目",
      workspacePath: workspace,
      authorizationGrantId: (await projects.requestWorkspaceAuthorization(workspace)).id
    });
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({ title: "交付可验证结果", description: "生成 result.md", projectId: project.id })).id;
    runs = await RunService.open(join(root, "runs.json"), todos);
    fixDispatches = [];
    fixEvidenceMode = "full";
    reviews = new ReviewService({
      runs,
      todos,
      dispatchFixAgent: async (runId, instruction) => {
        fixDispatches.push(instruction);
        await runs.beginProfessionalExecution(runId, (await runs.get(runId)).execution.selectedAgent!);
        if (fixEvidenceMode === "full") {
          await runs.recordExecutionStep(runId, "write_file:result.md");
          await runs.recordArtifact(runId, { path: "result.md", kind: "file" });
          await runs.recordLog(runId, { level: "info", message: "验证结果：npm test exitCode: 0" });
        } else {
          await runs.recordLog(runId, { level: "info", message: "验证：npm test 通过" });
        }
        return runs.finishProfessionalExecution(runId, "修复代理已完成。");
      }
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const agent = {
    source: "temporary" as const,
    name: "实现代理",
    responsibility: "写入文件",
    systemInstruction: "返回 JSON",
    connectionId: "connection-review",
    tools: ["filesystem"]
  };

  async function finishedRunWithoutArtifact() {
    const run = await runs.create(todoId, "请生成 result.md 并记录验证。");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(run.id, agent);
    return runs.finishProfessionalExecution(run.id, "代理自称完成。");
  }

  async function finishedRunWithEvidence() {
    const run = await runs.create(todoId, "请生成 result.md 并记录验证。");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.recordExecutionStep(run.id, "write_file:result.md");
    await runs.recordArtifact(run.id, { path: "result.md", kind: "file" });
    await runs.recordLog(run.id, { level: "info", message: "验证结果：npm test exitCode: 0" });
    return runs.finishProfessionalExecution(run.id, "执行完成，等待独立审查。");
  }

  it("assembles an independent Reviewer context from goal, approved plan, outcomes and evidence", async () => {
    const run = await finishedRunWithEvidence();
    const todo = await todos.get(todoId);
    const context = assembleReviewContext(run, todo);

    expect(context.originalGoal).toMatchObject({ title: "交付可验证结果", description: "生成 result.md" });
    expect(context.originalGoal.instructions).toContain("请生成 result.md 并记录验证。");
    expect(context.approvedPlan?.acceptanceCriteria?.length).toBeGreaterThan(0);
    expect(context.outcomes.artifacts).toEqual([expect.objectContaining({ path: "result.md" })]);
    expect(context.evidence.some((item) => item.includes("result.md"))).toBe(true);
    expect(context.evidence.some((item) => item.includes("验收标准"))).toBe(true);
  });

  it("Reviewer only returns conclusion, evidence, severity and fix scope without modifying artifacts", async () => {
    const run = await finishedRunWithoutArtifact();
    const before = await runs.get(run.id);
    const output = evaluateReview(assembleReviewContext(before, await todos.get(todoId)));

    expect(output.modifiedArtifacts).toBe(false);
    expect(output.conclusion).toBe("changes_requested");
    expect(output.severity).not.toBe("none");
    expect(output.evidence.length).toBeGreaterThan(0);
    expect(output.fixScope).toBeTruthy();
    expect(output.findings.every((finding) => typeof finding.criterion === "string")).toBe(true);

    const after = await runs.get(run.id);
    expect(after.artifacts).toEqual(before.artifacts);
    expect(after.execution.completedSteps).toEqual(before.execution.completedSteps);
  });

  it("rejects thin self-authored verification claims without structured results or artifacts", async () => {
    const run = await runs.create(todoId, "实现功能并验证。");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.recordLog(run.id, { level: "info", message: "验证：npm test 通过" });
    await runs.finishProfessionalExecution(run.id, "自称完成。");

    const output = evaluateReview(assembleReviewContext(await runs.get(run.id), await todos.get(todoId)));
    expect(output.conclusion).toBe("changes_requested");
    expect(output.findings.some((finding) => !finding.met && /验证|Artifact|成果/i.test(finding.criterion + finding.evidence))).toBe(true);
  });

  it("on review failure Firstmate dispatches clear issues and allows at most one automatic fix cycle", async () => {
    fixEvidenceMode = "thin";
    const run = await finishedRunWithoutArtifact();
    expect(run.status).toBe("awaiting_review");
    expect((await todos.get(todoId)).status).toBe("awaiting_confirmation");

    const first = await reviews.performReview(run.id, { autoDispatchFix: true });
    expect(first.review!.status).toBe("changes_requested");
    expect(first.fixDispatched).toBe(true);
    expect(fixDispatches).toHaveLength(1);
    expect(fixDispatches[0]).toMatch(/Firstmate 派发的审查修复/);
    expect(first.run.reviewLoop).toMatchObject({ autoFixCyclesUsed: 1, maxAutoFixCycles: 1 });
    expect(first.run.status).toBe("awaiting_review");

    // Thin evidence after auto fix still fails; auto dispatch must not fire again — pause for user.
    const second = await reviews.performReview(run.id, { autoDispatchFix: true });
    expect(second.review!.status).toBe("changes_requested");
    expect(second.fixDispatched).toBe(false);
    expect(second.paused).toBe(true);
    expect(second.run.status).toBe("paused");
    expect(second.run.reviewLoop?.autoFixCyclesUsed).toBe(1);
    await expect(reviews.dispatchFix(run.id)).rejects.toThrow(/fix cycle limit|authorize an additional fix/i);

    // User-authorized additional fix is still allowed.
    fixEvidenceMode = "full";
    const manual = await reviews.dispatchFix(run.id, { userAuthorized: true });
    expect(manual.continued).toBe(true);
    expect(manual.run.status).toBe("awaiting_review");
    const third = await reviews.performReview(run.id, { autoDispatchFix: false });
    expect(third.review!.status).toBe("passed");
    expect(third.run.status).toBe("awaiting_acceptance");
  });

  it("blocks completion bypass via status transition and legacy review forging", async () => {
    const run = await finishedRunWithoutArtifact();
    const app = createApp({ version: "0.1.0", projects, todos, runs, reviews });

    await request(app)
      .post(`/api/runs/${run.id}/status`)
      .send({ status: "awaiting_acceptance", summary: "伪造待验收" })
      .expect(400);
    await request(app)
      .post(`/api/runs/${run.id}/status`)
      .send({ status: "awaiting_review", summary: "伪造待审查" })
      .expect(400);
    await request(app)
      .post(`/api/runs/${run.id}/status`)
      .send({ status: "completed", summary: "伪造完成" })
      .expect(400);

    // Legacy timeline review must not open acceptance.
    await request(app)
      .post(`/api/runs/${run.id}/reviews`)
      .send({ status: "passed", summary: "伪造独立审查通过" })
      .expect(201);
    const afterLegacy = await runs.get(run.id);
    expect(afterLegacy.status).toBe("awaiting_review");
    expect(afterLegacy.reviews.at(-1)).toMatchObject({ kind: "timeline", status: "passed" });
    expect(afterLegacy.reviewLoop?.latestReviewId).not.toBe(afterLegacy.reviews.at(-1)?.id);

    await request(app)
      .post(`/api/runs/${run.id}/acceptance`)
      .send({ decision: "accepted", summary: "绕过验收" })
      .expect(400);

    // Even if somehow status is forced, acceptance keys off independent latestReviewId only.
    await expect(runs.acceptReviewOutcome(run.id, "仍应失败")).rejects.toThrow(/independent|awaiting acceptance/i);
  });

  it("ignores later timeline reviews when deciding acceptance eligibility", async () => {
    const run = await finishedRunWithEvidence();
    const reviewed = await reviews.performReview(run.id, { autoDispatchFix: false });
    expect(reviewed.run.status).toBe("awaiting_acceptance");
    const independentId = reviewed.run.reviewLoop?.latestReviewId;
    expect(independentId).toBeTruthy();

    // Legacy note cannot revoke a real independent pass for acceptance gating.
    await runs.recordReview(run.id, { status: "changes_requested", summary: "备注：还想改" });
    const gated = await runs.get(run.id);
    expect(gated.reviewLoop?.latestReviewId).toBe(independentId);
    expect(gated.reviews.at(-1)?.kind).toBe("timeline");

    const accepted = await reviews.accept(run.id, "仍按独立审查通过验收。");
    expect(accepted.run.status).toBe("completed");
    expect(accepted.todo.status).toBe("completed");
  });

  it("Todo and Run stay incomplete until review passes and the user accepts", async () => {
    const run = await finishedRunWithEvidence();
    await expect(reviews.accept(run.id, "用户想直接完成")).rejects.toThrow(/independent|awaiting acceptance/i);

    const reviewed = await reviews.performReview(run.id, { autoDispatchFix: false });
    expect(reviewed.review!.status).toBe("passed");
    expect(reviewed.review!.kind).toBe("independent");
    expect(reviewed.run.status).toBe("awaiting_acceptance");
    expect((await todos.get(todoId)).status).toBe("awaiting_acceptance");

    await expect(todos.update(todoId, { status: "completed" })).rejects.toThrow(/formal acceptance/i);
    const app = createApp({ version: "0.1.0", projects, todos, runs, reviews });
    await request(app)
      .patch(`/api/todos/${todoId}`)
      .send({ status: "completed" })
      .expect(400);

    const rejected = await reviews.reject(run.id, "还需要补充说明。");
    expect(rejected.run.status).toBe("awaiting_acceptance");
    expect(rejected.todo.status).toBe("awaiting_acceptance");
    expect(rejected.run.reviewLoop?.userAccepted).toBe(false);
    expect(rejected.run.reviewLoop?.reworkRequested).toBe(true);

    // User can still change their mind and accept after reject (no rework started).
    const accepted = await reviews.accept(run.id, "用户接受成果。");
    expect(accepted.run.status).toBe("completed");
    expect(accepted.todo.status).toBe("completed");
    expect(accepted.run.reviewLoop?.userAccepted).toBe(true);
    expect(accepted.run.timeline.some((event) => event.kind === "approval" && event.summary.includes("用户接受"))).toBe(true);
  });

  it("allows user-authorized rework after acceptance rejection without consuming auto cycles", async () => {
    const run = await finishedRunWithEvidence();
    await reviews.performReview(run.id, { autoDispatchFix: false });
    await reviews.reject(run.id, "格式不对，请返工。");
    expect((await runs.get(run.id)).reviewLoop).toMatchObject({ reworkRequested: true, autoFixCyclesUsed: 0 });

    const rework = await reviews.dispatchFix(run.id, { userAuthorized: true });
    expect(rework.continued).toBe(true);
    expect(rework.run.reviewLoop?.autoFixCyclesUsed).toBe(0);
    expect(rework.run.status).toBe("awaiting_review");

    const again = await reviews.performReview(run.id, { autoDispatchFix: false });
    expect(again.review!.status).toBe("passed");
    const accepted = await reviews.accept(run.id, "返工后接受。");
    expect(accepted.run.status).toBe("completed");
  });

  it("exposes perform-review, fix dispatch and acceptance through the local HTTP API", async () => {
    const run = await finishedRunWithEvidence();
    const app = createApp({ version: "0.1.0", projects, todos, runs, reviews });

    const context = await request(app).get(`/api/runs/${run.id}/review/context`).expect(200);
    expect(context.body.originalGoal.title).toBe("交付可验证结果");
    expect(context.body.approvedPlan.acceptanceCriteria.length).toBeGreaterThan(0);

    const performed = await request(app)
      .post(`/api/runs/${run.id}/review/perform`)
      .send({ autoDispatchFix: false })
      .expect(201);
    expect(performed.body.review.status).toBe("passed");
    expect(performed.body.review.kind).toBe("independent");
    expect(performed.body.run.status).toBe("awaiting_acceptance");

    const accepted = await request(app)
      .post(`/api/runs/${run.id}/acceptance`)
      .send({ decision: "accepted", summary: "验收通过。" })
      .expect(200);
    expect(accepted.body.run.status).toBe("completed");
    expect(accepted.body.todo.status).toBe("completed");
  });

  it("builds Firstmate fix instructions from structured Reviewer findings only", () => {
    const instruction = buildFixInstruction({
      id: "r1",
      status: "changes_requested",
      summary: "缺少验证",
      createdAt: new Date().toISOString(),
      kind: "independent",
      severity: "high",
      evidence: ["无验证日志"],
      fixScope: "补齐验证并记录。",
      findings: [
        { criterion: "验证已记录", met: false, evidence: "无", severity: "high", fixScope: "运行 npm test 并写日志" }
      ],
      cycle: 0,
      role: "reviewer"
    });
    expect(instruction).toMatch(/Firstmate 派发的审查修复/);
    expect(instruction).toMatch(/运行 npm test|验证已记录/);
    expect(instruction).toMatch(/禁止顺手重构|不得越界|已确认/);
    expect(instruction).not.toMatch(/writeFile|unlink|rm -rf/i);
  });

  it("treats Codex write-session pause as not continued and rolls back unused auto fix cycles", async () => {
    const pausedReviews = new ReviewService({
      runs,
      todos,
      dispatchFixAgent: async (runId) => {
        await runs.beginProfessionalExecution(runId, (await runs.get(runId)).execution.selectedAgent!);
        return runs.requestExecutionApproval(runId, {
          kind: "delete_file",
          summary: "Codex 写入会话需确认",
          authorizationFingerprint: "fp-test"
        });
      }
    });
    const run = await finishedRunWithoutArtifact();
    await runs.applyStructuredReview(run.id, {
      status: "changes_requested",
      summary: "缺成果",
      severity: "high",
      evidence: ["无 artifact"],
      fixScope: "补成果",
      findings: [{ criterion: "产出", met: false, evidence: "无", severity: "high", fixScope: "补成果" }],
      cycle: 0
    });

    const result = await pausedReviews.dispatchFix(run.id);
    expect(result.continued).toBe(false);
    expect(result.reason).toBe("awaiting_write_session_approval");
    expect((await runs.get(run.id)).reviewLoop?.autoFixCyclesUsed).toBe(0);
    expect((await runs.get(run.id)).reviewLoop?.pendingFixInstruction).toBeTruthy();
  });
});
