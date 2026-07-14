import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { RunService } from "../runs/runService.js";
import { SubtaskDagService } from "../subtasks/subtaskDagService.js";
import { TodoService } from "../todos/todoService.js";
import {
  buildConstrainedFixInstruction,
  buildFixSubtasksFromReview,
  canApplyWorktreeAfterReview,
  classifyFinding,
  selectFixAgent,
  shouldPauseForUserAfterFailedRemediation
} from "./reviewRemediation.js";
import { ReviewService } from "./reviewService.js";

describe("Review remediation pure helpers (task 29)", () => {
  const reviewBase = {
    id: "rev-1",
    status: "changes_requested" as const,
    summary: "缺成果与验证",
    createdAt: new Date().toISOString(),
    kind: "independent" as const,
    severity: "high" as const,
    evidence: ["无 artifact", "无 exitCode"],
    fixScope: "补齐成果并验证",
    findings: [
      {
        criterion: "产出 result.md",
        met: false,
        evidence: "缺少正式 Artifact",
        severity: "high" as const,
        fixScope: "生成 result.md 并登记 Artifact"
      },
      {
        criterion: "验证已记录",
        met: false,
        evidence: "缺少 exitCode=0",
        severity: "high" as const,
        fixScope: "运行 npm test 并写结构化结果"
      },
      {
        criterion: "已有产物完整",
        met: true,
        evidence: "部分步骤完成",
        severity: "none" as const
      }
    ],
    cycle: 0,
    role: "reviewer" as const,
    residualRisks: ["边界覆盖不足"]
  };

  it("converts each unmet finding into a fix subtask with evidence, severity, scope, acceptance", () => {
    const built = buildFixSubtasksFromReview({
      review: reviewBase,
      allowedScope: ["src/**", "result.md"],
      cycle: 0
    });

    expect(built.unmetCount).toBe(2);
    // 2 fix + 1 verify
    expect(built.specs.length).toBe(3);
    const fixes = built.specs.filter((s) => s.sourceFindingIndex >= 0);
    expect(fixes).toHaveLength(2);
    for (const fix of fixes) {
      expect(fix.evidence.length).toBeGreaterThan(0);
      expect(fix.severity).toMatch(/high|critical|medium|low/);
      expect(fix.allowedScope.join(" ")).toMatch(/src\/\*\*|result\.md|已确认/);
      expect(fix.acceptanceCriteria.some((c) => c.includes(fix.fixScope) || c.includes("验收") || c.includes("证据"))).toBe(true);
      expect(fix.constraint).toMatch(/禁止顺手重构|不得越界/);
      expect(fix.id).toMatch(/^remediation-c0-f\d+$/);
    }
    const verify = built.specs.find((s) => s.sourceFindingIndex < 0);
    expect(verify?.title).toMatch(/验证/);
    expect(built.explicitSubtasks.some((s) => (s.dependsOn?.length ?? 0) > 0)).toBe(true);
    expect(built.instruction).toContain("禁止顺手重构");
    expect(built.instruction).toContain("重新运行相关验证");
    expect(built.instruction).not.toMatch(/writeFileSync|rm -rf/i);
  });

  it("classifies findings and selects original agent (never Reviewer) by default", () => {
    expect(classifyFinding({
      criterion: "验证已记录",
      met: false,
      evidence: "exitCode missing",
      severity: "high"
    })).toBe("verification");
    expect(classifyFinding({
      criterion: "实际修改不得超出已批准计划边界。",
      met: false,
      evidence: "越界改了 docs",
      severity: "high"
    })).toBe("scope");

    const original = {
      source: "temporary" as const,
      name: "实现代理",
      responsibility: "写代码",
      systemInstruction: "实现",
      connectionId: "c1",
      tools: ["filesystem", "shell"],
      skills: ["implement"]
    };
    const scopeSpec = buildFixSubtasksFromReview({ review: {
      ...reviewBase,
      findings: [{
        criterion: "实际修改不得超出已批准计划边界。",
        met: false,
        evidence: "越界",
        severity: "critical" as const,
        fixScope: "撤销越界"
      }]
    }}).specs[0]!;

    const selected = selectFixAgent({
      spec: scopeSpec,
      originalAgent: original,
      fixSpecialists: [{
        name: "Safe Fix Specialist",
        roleId: "role-safe-fix",
        skills: ["safe-fix"],
        tools: ["filesystem"],
        source: "role"
      }]
    });
    // scope/critical prefers specialist when available
    expect(selected.name).toMatch(/Safe Fix|修复/);
    expect(selected.name).not.toMatch(/Reviewer|审查/);

    const reviewerOnly = selectFixAgent({
      spec: {
        ...scopeSpec,
        agentPreference: "original",
        problemType: "artifact"
      },
      originalAgent: {
        source: "role",
        name: "Independent Reviewer",
        responsibility: "审查",
        systemInstruction: "review",
        roleId: "reviewer-role",
        tools: ["model-api"],
        skills: ["code-review"]
      }
    });
    // Must not hand work to the Reviewer role
    expect(reviewerOnly.name).not.toMatch(/Reviewer|Independent|独立审查/);
    expect(reviewerOnly.skills ?? []).not.toContain("code-review");
  });

  it("buildConstrainedFixInstruction lists confirmed issues only", () => {
    const built = buildFixSubtasksFromReview({ review: reviewBase });
    const text = buildConstrainedFixInstruction({
      review: reviewBase,
      specs: built.specs.filter((s) => s.sourceFindingIndex >= 0),
      verificationIncluded: true
    });
    expect(text).toContain("产出 result.md");
    expect(text).toContain("验证已记录");
    expect(text).not.toContain("已有产物完整");
    expect(text).toMatch(/Reviewer 只出报告|不修改成果/);
  });

  it("pauses only when auto-fix budget exhausted and still changes_requested", () => {
    expect(shouldPauseForUserAfterFailedRemediation({
      conclusion: "changes_requested",
      autoFixCyclesUsed: 1,
      maxAutoFixCycles: 1
    })).toBe(true);
    expect(shouldPauseForUserAfterFailedRemediation({
      conclusion: "changes_requested",
      autoFixCyclesUsed: 0,
      maxAutoFixCycles: 1
    })).toBe(false);
    expect(shouldPauseForUserAfterFailedRemediation({
      conclusion: "passed",
      autoFixCyclesUsed: 1,
      maxAutoFixCycles: 1
    })).toBe(false);
    expect(shouldPauseForUserAfterFailedRemediation({
      conclusion: "changes_requested",
      autoFixCyclesUsed: 1,
      maxAutoFixCycles: 1,
      autoDispatchEnabled: false
    })).toBe(false);
  });

  it("blocks worktree apply and formal complete without pass + user accept", () => {
    const noReview = canApplyWorktreeAfterReview({
      status: "awaiting_review",
      reviews: [],
      reviewLoop: { autoFixCyclesUsed: 0, maxAutoFixCycles: 1 }
    });
    expect(noReview.ok).toBe(false);
    expect(noReview.reviewPassed).toBe(false);

    const passedOnly = canApplyWorktreeAfterReview({
      status: "awaiting_acceptance",
      reviews: [{
        id: "r-pass",
        status: "passed",
        summary: "ok",
        createdAt: new Date().toISOString(),
        kind: "independent",
        role: "reviewer",
        findings: [{ criterion: "c", met: true, evidence: "e", severity: "none" }],
        evidence: ["e"]
      }],
      reviewLoop: {
        autoFixCyclesUsed: 0,
        maxAutoFixCycles: 1,
        latestReviewId: "r-pass",
        userAccepted: false
      }
    });
    expect(passedOnly.ok).toBe(false);
    expect(passedOnly.reviewPassed).toBe(true);
    expect(passedOnly.userAccepted).toBe(false);

    const both = canApplyWorktreeAfterReview({
      status: "completed",
      reviews: [{
        id: "r-pass",
        status: "passed",
        summary: "ok",
        createdAt: new Date().toISOString(),
        kind: "independent",
        role: "reviewer",
        findings: [{ criterion: "c", met: true, evidence: "e", severity: "none" }],
        evidence: ["e"]
      }],
      reviewLoop: {
        autoFixCyclesUsed: 0,
        maxAutoFixCycles: 1,
        latestReviewId: "r-pass",
        userAccepted: true
      }
    });
    expect(both.ok).toBe(true);
  });
});

describe("Review remediation loop integration (task 29)", () => {
  let root: string;
  let projects: ProjectService;
  let todos: TodoService;
  let runs: RunService;
  let subtasks: SubtaskDagService;
  let reviews: ReviewService;
  let todoId: string;
  let fixDispatches: string[];
  let fixEvidenceMode: "full" | "thin";

  const agent = {
    source: "temporary" as const,
    name: "实现代理",
    responsibility: "写入文件",
    systemInstruction: "返回 JSON",
    connectionId: "connection-review",
    tools: ["filesystem"],
    skills: ["implement"]
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-remediation-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    const project = await projects.create({
      name: "修复闭环项目",
      workspacePath: workspace,
      authorizationGrantId: (await projects.requestWorkspaceAuthorization(workspace)).id
    });
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({ title: "交付可验证结果", description: "生成 result.md", projectId: project.id })).id;
    runs = await RunService.open(join(root, "runs.json"), todos);
    subtasks = await SubtaskDagService.open(join(root, "subtasks.json"));
    fixDispatches = [];
    fixEvidenceMode = "thin";
    reviews = new ReviewService({
      runs,
      todos,
      subtasks,
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

  it("dispatches review findings as constrained fix subtasks on the DAG", async () => {
    const run = await finishedRunWithoutArtifact();
    const first = await reviews.performReview(run.id, { autoDispatchFix: true });

    expect(first.review!.status).toBe("changes_requested");
    expect(first.fixDispatched).toBe(true);
    expect(first.remediation?.unmetCount).toBeGreaterThan(0);
    expect(first.remediation?.subtaskIds.length).toBeGreaterThan(0);
    expect(fixDispatches[0]).toMatch(/禁止顺手重构|仅处理已确认|不得越界/);
    expect(fixDispatches[0]).toMatch(/验证|exitCode|Artifact|成果/);

    const dag = subtasks.getByRunId(run.id);
    const remediation = dag.subtasks.filter((s) => s.origin === "review_remediation");
    expect(remediation.length).toBeGreaterThan(0);
    for (const sub of remediation) {
      expect(sub.sourceReviewId).toBe(first.review!.id);
      expect(sub.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(sub.inputs.some((i) => i.startsWith("review:") || i.startsWith("evidence:") || i.startsWith("scope:"))).toBe(true);
      // Reviewer is never the assigned fix agent
      expect(sub.agentInstance?.name).not.toMatch(/Reviewer|独立审查/);
    }
    // Fix agents are write-scoped to confirmed work
    expect(remediation.every((s) => s.permissions.workspace === "project_only")).toBe(true);
    expect(first.run.timeline.some((e) => /修复|派发|审查/.test(e.summary))).toBe(true);
  });

  it("allows at most one automatic remediation cycle then pauses for the user", async () => {
    fixEvidenceMode = "thin";
    const run = await finishedRunWithoutArtifact();

    const first = await reviews.performReview(run.id, { autoDispatchFix: true });
    expect(first.fixDispatched).toBe(true);
    expect(first.run.reviewLoop).toMatchObject({ autoFixCyclesUsed: 1, maxAutoFixCycles: 1 });
    expect(first.run.status).toBe("awaiting_review");

    // Re-review still fails (thin evidence) → no second auto cycle; pause for user.
    const second = await reviews.performReview(run.id, { autoDispatchFix: true });
    expect(second.review!.status).toBe("changes_requested");
    expect(second.fixDispatched).toBe(false);
    expect(second.paused).toBe(true);
    expect(second.pauseReason).toMatch(/自动修复|用尽|用户/);
    expect(second.run.status).toBe("paused");
    expect(second.run.reviewLoop?.autoFixCyclesUsed).toBe(1);

    await expect(reviews.dispatchFix(run.id)).rejects.toThrow(/fix cycle limit|authorize an additional fix/i);

    // User-authorized second fix still allowed; independent re-review is a new review instance.
    fixEvidenceMode = "full";
    const priorReviewId = second.review!.id;
    const manual = await reviews.dispatchFix(run.id, { userAuthorized: true });
    expect(manual.continued).toBe(true);
    expect(manual.remediation?.subtaskIds.length).toBeGreaterThan(0);

    const third = await reviews.performReview(run.id, { autoDispatchFix: false });
    expect(third.review!.status).toBe("passed");
    expect(third.review!.id).not.toBe(priorReviewId);
    expect(third.review!.kind).toBe("independent");
    expect(third.run.status).toBe("awaiting_acceptance");

    // Without user accept: no complete, no apply gate.
    const gateBefore = reviews.canApplyWorktree(await runs.get(run.id));
    expect(gateBefore.ok).toBe(false);
    await expect(reviews.accept(run.id, "用户接受修复成果。")).resolves.toMatchObject({
      run: expect.objectContaining({ status: "completed" })
    });
    const gateAfter = reviews.canApplyWorktree(await runs.get(run.id));
    expect(gateAfter.ok).toBe(true);
    expect((await todos.get(todoId)).status).toBe("completed");
  });

  it("independent re-review uses a fresh cycle and does not complete without accept", async () => {
    const run = await finishedRunWithEvidence();
    const first = await reviews.performReview(run.id, { autoDispatchFix: false });
    expect(first.review!.status).toBe("passed");
    expect(first.run.status).toBe("awaiting_acceptance");
    expect((await todos.get(todoId)).status).toBe("awaiting_acceptance");

    await expect(todos.update(todoId, { status: "completed" })).rejects.toThrow(/formal acceptance/i);
    expect(canApplyWorktreeAfterReview(await runs.get(run.id)).ok).toBe(false);

    await reviews.reject(run.id, "还要小改。");
    const rework = await reviews.dispatchFix(run.id, { userAuthorized: true });
    expect(rework.continued).toBe(true);
    // Rework re-review is independent (new latestReviewId after perform)
    const again = await reviews.performReview(run.id, { autoDispatchFix: false });
    expect(again.review!.id).not.toBe(first.review!.id);
    expect(again.review!.status).toBe("passed");
    expect(again.run.status).toBe("awaiting_acceptance");
    expect(canApplyWorktreeAfterReview(await runs.get(run.id)).ok).toBe(false);
  });

  it("creates a remediation-only DAG when the run had no prior subtasks", async () => {
    const run = await finishedRunWithoutArtifact();
    await expect(() => subtasks.getByRunId(run.id)).toThrow(/not found/i);

    await runs.applyStructuredReview(run.id, {
      status: "changes_requested",
      summary: "缺成果",
      severity: "high",
      evidence: ["无 artifact"],
      fixScope: "补成果",
      findings: [{
        criterion: "产出 result.md",
        met: false,
        evidence: "无",
        severity: "high",
        fixScope: "补成果"
      }],
      cycle: 0
    });

    fixEvidenceMode = "full";
    const result = await reviews.dispatchFix(run.id, { userAuthorized: false });
    expect(result.continued).toBe(true);
    expect(result.remediation?.dagCreated).toBe(true);

    const dag = subtasks.getByRunId(run.id);
    expect(dag.taskType).toBe("bug_fix");
    expect(dag.subtasks.every((s) => s.origin === "review_remediation")).toBe(true);
    expect(dag.subtasks.some((s) => s.title.includes("产出") || s.title.includes("修复"))).toBe(true);
  });
});
