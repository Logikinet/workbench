import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { FakeModelProvider } from "../model/fakeProvider.js";
import { ModelRuntime } from "../model/modelRuntime.js";
import type { ModelProviderRequest } from "../model/types.js";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { RoleService } from "../roles/roleService.js";
import { RunService } from "../runs/runService.js";
import { TodoService } from "../todos/todoService.js";
import { reviewerOutputSchema, REVIEWER_SYSTEM_INSTRUCTION } from "./reviewSchemas.js";
import {
  assembleReviewContext,
  evaluateReview,
  formatReviewMarkdown,
  ReviewService,
  type StructuredReviewOutput
} from "./reviewService.js";
import { validateAgainstSchema } from "../model/jsonSchema.js";

class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();
  async read(reference: string): Promise<string | undefined> {
    return this.values.get(reference);
  }
  async write(reference: string, secret: string): Promise<void> {
    this.values.set(reference, secret);
  }
  async remove(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

function modelReview(overrides: Partial<{
  conclusion: "passed" | "changes_requested";
  summary: string;
  evidence: string[];
  severity: string;
  fixScope?: string;
  residualRisks: string[];
  findings: Array<{
    criterion: string;
    met: boolean;
    evidence: string;
    severity: string;
    fixScope?: string;
  }>;
  modifiedArtifacts: false;
}> = {}): string {
  const payload = {
    conclusion: "passed" as const,
    summary: "模型审查通过：验收项均有证据支持。",
    evidence: ["result.md 已登记", "验证 exitCode=0"],
    severity: "none",
    residualRisks: ["边界用例覆盖有限"],
    findings: [
      {
        criterion: "产出 result.md",
        met: true,
        evidence: "Artifact result.md 已登记",
        severity: "none"
      },
      {
        criterion: "验证已记录",
        met: true,
        evidence: "npm test exitCode=0",
        severity: "none"
      }
    ],
    modifiedArtifacts: false as const,
    ...overrides
  };
  return JSON.stringify(payload);
}

describe("Independent LLM Reviewer (task 28)", () => {
  let root: string;
  let projects: ProjectService;
  let todos: TodoService;
  let runs: RunService;
  let roles: RoleService;
  let connections: ConnectionService;
  let todoId: string;
  let reviewerRoleId: string;
  let executorRoleId: string;
  let provider: FakeModelProvider;

  const agent = {
    source: "temporary" as const,
    name: "实现代理",
    responsibility: "写入文件",
    systemInstruction: "执行实现",
    connectionId: "connection-exec",
    modelId: "exec-model",
    tools: ["filesystem"]
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-llm-review-"));
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
    connections = await ConnectionService.open(join(root, "connections.json"), new MemoryCredentialVault());
    const reviewConnection = await connections.create({
      name: "review-conn",
      baseUrl: "https://review.example/v1",
      modelId: "review-model-x",
      apiKey: "sk-review-test"
    });
    const execConnection = await connections.create({
      name: "exec-conn",
      baseUrl: "https://exec.example/v1",
      modelId: "exec-model-y",
      apiKey: "sk-exec-test"
    });
    roles = await RoleService.open(join(root, "roles.json"), connections);
    const reviewer = await roles.create({
      name: "Independent Reviewer",
      responsibility: "独立审查",
      systemInstruction: "Review only.",
      connectionId: reviewConnection.id,
      modelId: "review-model-x",
      harness: "api",
      reasoningEffort: "medium",
      skills: ["code-review"],
      tools: ["model-api"],
      permissions: { workspace: "read_only", network: false, shell: false, externalSend: false },
      allowFirstmateAutoInvoke: false
    });
    const executor = await roles.create({
      name: "Implementer",
      responsibility: "实现",
      systemInstruction: "Implement only.",
      connectionId: execConnection.id,
      modelId: "exec-model-y",
      harness: "api",
      reasoningEffort: "medium",
      skills: ["implement"],
      tools: ["filesystem", "shell"],
      permissions: { workspace: "project_only", network: false, shell: true, externalSend: false },
      allowFirstmateAutoInvoke: false
    });
    reviewerRoleId = reviewer.id;
    executorRoleId = executor.id;
    provider = new FakeModelProvider({ scenario: "success", successContent: modelReview() });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function createReviews(options: { provider?: FakeModelProvider; roleId?: string } = {}): ReviewService {
    const fake = options.provider ?? provider;
    const modelRuntime = new ModelRuntime({
      roles,
      connections,
      provider: fake,
      runHooks: {
        recordLog: (runId, input) => runs.recordLog(runId, input),
        pause: (runId, reason) => runs.transition(runId, "paused", reason)
      }
    });
    return new ReviewService({
      runs,
      todos,
      modelRuntime,
      reviewerRoleId: options.roleId ?? reviewerRoleId
    });
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

  async function finishedRunMissingArtifact() {
    const run = await runs.create(todoId, "请生成 result.md。");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.recordLog(run.id, { level: "info", message: "验证：npm test 通过" });
    return runs.finishProfessionalExecution(run.id, "自称完成。");
  }

  it("reviewerOutputSchema validates expected structured reports", () => {
    const ok = JSON.parse(modelReview());
    expect(validateAgainstSchema(ok, reviewerOutputSchema).valid).toBe(true);
    const bad = { ...ok, modifiedArtifacts: true };
    expect(validateAgainstSchema(bad, reviewerOutputSchema).valid).toBe(false);
  });

  it("assembles independent context with goal, boundaries, modifications and evidence — not executor tools chat", async () => {
    const run = await finishedRunWithEvidence();
    await runs.recordCodexWorktreeArtifacts(run.id, {
      evidence: {
        source: "codex-worktree",
        worktreeRunId: run.id,
        sessionStatus: "active",
        changeStatus: "modified",
        discarded: false,
        changedFiles: ["result.md"],
        diff: "diff --git a/result.md b/result.md\n+hello",
        verificationResults: [{ command: ["npm", "test"], exitCode: 0, stdout: "ok", stderr: "", passed: true }],
        summary: "modified result.md"
      },
      changedFiles: ["result.md"]
    });
    const context = assembleReviewContext(await runs.get(run.id), await todos.get(todoId));
    expect(context.originalGoal.title).toBe("交付可验证结果");
    expect(context.originalGoal.instructions).toContain("请生成 result.md 并记录验证。");
    expect(context.approvedPlan?.acceptanceCriteria?.length).toBeGreaterThan(0);
    expect(context.modifications.changedFiles).toContain("result.md");
    expect(context.modifications.diffExcerpt).toContain("result.md");
    expect(context.modifications.verificationResults[0]?.passed).toBe(true);
    expect(context.evidence.some((line) => line.includes("验收标准"))).toBe(true);
    // Independent context must not invent write tool APIs.
    const blob = JSON.stringify(context);
    expect(blob).not.toMatch(/writeFileSync|unlinkSync|rm -rf/i);
  });

  it("uses reviewer role model (not executor model) and only emits report without write tools", async () => {
    const reviews = createReviews();
    const run = await finishedRunWithEvidence();
    const result = await reviews.performReview(run.id, { autoDispatchFix: false });

    expect(result.paused).toBeFalsy();
    expect(result.review?.status).toBe("passed");
    expect(result.review?.kind).toBe("independent");
    expect(result.review?.reviewSource).toBe("rules+model");
    expect(result.review?.modelRoleId).toBe(reviewerRoleId);
    expect(result.review?.modelId).toBe("review-model-x");
    expect(result.review?.modelId).not.toBe("exec-model-y");
    expect(result.review?.modelRoleId).not.toBe(executorRoleId);
    expect(result.review?.markdownReport).toMatch(/Independent Review Report/);
    expect(result.review?.residualRisks?.length).toBeGreaterThan(0);

    expect(provider.calls).toHaveLength(1);
    const request = provider.calls[0] as ModelProviderRequest;
    expect(request.modelId).toBe("review-model-x");
    expect(request.connectionId).not.toBe("connection-exec");
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("Independent Reviewer");
    expect(system).toMatch(/MUST NOT call tools|不得|Do not call tools|never/i);
    expect(REVIEWER_SYSTEM_INSTRUCTION).toMatch(/MUST NOT call tools/i);
    // Prompt is independent context, not a tool-loop transcript.
    const userBlob = request.messages.map((message) => message.content).join("\n");
    expect(userBlob).toContain("Independent review context");
    expect(userBlob).not.toMatch(/tool_call|function_call|write_file\(/i);
  });

  it("saves structured findings and readable Markdown together", async () => {
    const reviews = createReviews();
    const run = await finishedRunWithEvidence();
    const result = await reviews.performReview(run.id, { autoDispatchFix: false });
    expect(result.review?.findings?.length).toBeGreaterThan(0);
    expect(result.review?.markdownReport).toContain("## Acceptance findings");
    expect(result.review?.markdownReport).toContain("## Residual risks");
    expect(result.review?.markdownReport).toContain("no write tools");

    const rendered = formatReviewMarkdown({
      conclusion: "changes_requested",
      summary: "缺项",
      severity: "high",
      evidence: ["无 artifact"],
      findings: [{ criterion: "产出", met: false, evidence: "无", severity: "high", fixScope: "补成果" }],
      residualRisks: ["交付不完整"],
      reviewSource: "rules+model",
      fixScope: "补成果"
    });
    expect(rendered).toContain("changes_requested");
    expect(rendered).toContain("交付不完整");
  });

  it("pauses when review model is unavailable and does not auto-switch or forge a pass", async () => {
    const failProvider = new FakeModelProvider({ scenario: "model_unavailable" });
    const reviews = createReviews({ provider: failProvider });
    const run = await finishedRunWithEvidence();
    const result = await reviews.performReview(run.id, { autoDispatchFix: false });

    expect(result.paused).toBe(true);
    expect(result.pauseReason).toMatch(/不可用|失败|暂停/);
    expect(result.review).toBeUndefined();
    expect(result.fixDispatched).toBe(false);
    expect(result.run.status).toBe("paused");
    // No independent pass was recorded.
    expect(result.run.reviewLoop?.latestReviewId).toBeUndefined();
    expect(result.run.reviews.filter((entry) => entry.kind === "independent")).toHaveLength(0);
  });

  it("pauses on auth failure without falling back to rule-only pass", async () => {
    const failProvider = new FakeModelProvider({ scenario: "auth_fail" });
    const reviews = createReviews({ provider: failProvider });
    const run = await finishedRunWithEvidence();
    const result = await reviews.performReview(run.id, { autoDispatchFix: false });
    expect(result.paused).toBe(true);
    expect(result.run.status).toBe("paused");
    expect(result.run.status).not.toBe("awaiting_acceptance");
  });

  it("does not incorrectly pass intentional missing artifacts / fake success logs", async () => {
    // Model tries to pass, but deterministic pre-check hard gates force changes_requested.
    const looseProvider = new FakeModelProvider({
      scenario: "success",
      successContent: modelReview({
        conclusion: "passed",
        summary: "模型错误地放行了缺项成果",
        severity: "none",
        findings: [
          {
            criterion: "产出 result.md",
            met: true,
            evidence: "代理自称完成",
            severity: "none"
          }
        ]
      })
    });
    const reviews = createReviews({ provider: looseProvider });
    const run = await finishedRunMissingArtifact();
    const result = await reviews.performReview(run.id, { autoDispatchFix: false });

    expect(result.paused).toBeFalsy();
    expect(result.review?.status).toBe("changes_requested");
    expect(result.run.status).toBe("awaiting_review");
    expect(result.review?.findings?.some((finding) => !finding.met)).toBe(true);
    expect(
      result.review?.findings?.some((finding) =>
        /Artifact|伪成功|验证|成果/i.test(finding.criterion + finding.evidence)
      )
    ).toBe(true);
  });

  it("detects out-of-scope modifications against allowedScope", async () => {
    const run = await runs.create(todoId, "只改 src/auth");
    // Inject a plan with narrow allowedScope via decide + manual plan fields is hard;
    // use evaluateReview context with modifications directly.
    const todo = await todos.get(todoId);
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准 auth 范围。" });
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.recordArtifact(run.id, { path: "src/unrelated/hack.ts", kind: "file" });
    await runs.finishProfessionalExecution(run.id, "完成。");
    const finished = await runs.get(run.id);
    // Patch approved plan allowedScope for this scenario.
    const plan = finished.planVersions.at(-1);
    if (plan) {
      plan.allowedScope = ["src/auth/**"];
      plan.steps = ["修改 src/auth/session.ts"];
      plan.acceptanceCriteria = ["仅 auth 范围修改", "验证已记录"];
    }
    await runs.recordCodexWorktreeArtifacts(run.id, {
      evidence: {
        source: "codex-worktree",
        worktreeRunId: run.id,
        sessionStatus: "active",
        changeStatus: "modified",
        discarded: false,
        changedFiles: ["src/unrelated/hack.ts", "docs/secret.md"],
        diff: "diff --git a/src/unrelated/hack.ts\n+evil",
        verificationResults: [{ command: ["npm", "test"], exitCode: 0, stdout: "ok", stderr: "", passed: true }],
        summary: "out of scope"
      },
      changedFiles: ["src/unrelated/hack.ts", "docs/secret.md"]
    });

    const context = assembleReviewContext(await runs.get(run.id), todo);
    // Ensure allowedScope is present for the evaluator.
    if (context.approvedPlan) {
      context.approvedPlan.allowedScope = ["src/auth/**"];
      context.approvedPlan.steps = ["修改 src/auth/session.ts"];
    }
    context.modifications.changedFiles = ["src/unrelated/hack.ts", "docs/secret.md"];
    const precheck = evaluateReview(context);
    expect(precheck.conclusion).toBe("changes_requested");
    expect(precheck.findings.some((finding) => !finding.met && /越界|边界|allowedScope|范围/i.test(finding.criterion + finding.evidence))).toBe(true);

    const providerOutOfScope = new FakeModelProvider({
      scenario: "success",
      successContent: modelReview({
        conclusion: "changes_requested",
        summary: "越界修改",
        severity: "high",
        residualRisks: ["无关模块被改动"],
        findings: [
          {
            criterion: "实际修改不得超出已批准计划边界。",
            met: false,
            evidence: "改了 src/unrelated/hack.ts",
            severity: "high",
            fixScope: "撤销越界文件"
          }
        ],
        fixScope: "撤销越界文件"
      })
    });
    // Re-open a clean finished run path for performReview
    const run2 = await finishedRunWithEvidence();
    await runs.recordCodexWorktreeArtifacts(run2.id, {
      evidence: {
        source: "codex-worktree",
        worktreeRunId: run2.id,
        sessionStatus: "active",
        changeStatus: "modified",
        discarded: false,
        changedFiles: ["src/unrelated/hack.ts"],
        diff: "+evil",
        verificationResults: [{ command: ["npm", "test"], exitCode: 0, stdout: "ok", stderr: "", passed: true }],
        summary: "oos"
      },
      changedFiles: ["src/unrelated/hack.ts"]
    });
    const after = await runs.get(run2.id);
    const plan2 = after.planVersions.at(-1);
    if (plan2) plan2.allowedScope = ["src/auth/**"];

    const reviews = createReviews({ provider: providerOutOfScope });
    // Persist plan change by re-saving via transition-safe path: apply review will read from disk state.
    // RunService mutates in memory; planVersions mutation above is on the live object if same reference.
    const live = await runs.get(run2.id);
    const livePlan = live.planVersions.at(-1);
    if (livePlan) livePlan.allowedScope = ["src/auth/**"];

    const result = await reviews.performReview(run2.id, { autoDispatchFix: false });
    expect(result.review?.status).toBe("changes_requested");
  });

  it("rejects failed verification and incomplete artifacts via pre-check", async () => {
    const run = await finishedRunWithEvidence();
    await runs.recordCodexWorktreeArtifacts(run.id, {
      evidence: {
        source: "codex-worktree",
        worktreeRunId: run.id,
        sessionStatus: "active",
        changeStatus: "modified",
        discarded: false,
        changedFiles: ["result.md"],
        diff: "+x",
        verificationResults: [{ command: ["npm", "test"], exitCode: 1, stdout: "fail", stderr: "err", passed: false }],
        summary: "tests failed"
      },
      changedFiles: ["result.md"]
    });
    const context = assembleReviewContext(await runs.get(run.id), await todos.get(todoId));
    const precheck = evaluateReview(context);
    expect(precheck.conclusion).toBe("changes_requested");
    expect(precheck.findings.some((f) => !f.met && /验证|test|失败/i.test(f.criterion + f.evidence))).toBe(true);

    const discardedRun = await finishedRunWithEvidence();
    await runs.recordCodexWorktreeArtifacts(discardedRun.id, {
      evidence: {
        source: "codex-worktree",
        worktreeRunId: discardedRun.id,
        sessionStatus: "discarded",
        changeStatus: "modified",
        discarded: true,
        changedFiles: ["result.md"],
        verificationResults: [],
        summary: "discarded"
      },
      changedFiles: ["result.md"]
    });
    const discardedContext = assembleReviewContext(await runs.get(discardedRun.id), await todos.get(todoId));
    const discardedCheck = evaluateReview(discardedContext);
    expect(discardedCheck.conclusion).toBe("changes_requested");
    expect(discardedCheck.findings.some((f) => !f.met && /丢弃|discard|Artifact|完整/i.test(f.criterion + f.evidence))).toBe(true);
  });

  it("rule pre-check alone cannot replace model review when model is configured", async () => {
    const reviews = createReviews();
    const run = await finishedRunWithEvidence();
    // Even when pre-check would pass, model must still be invoked.
    provider.reset();
    provider.successContent = modelReview({ residualRisks: ["模型补充的剩余风险"] });
    const result = await reviews.performReview(run.id, { autoDispatchFix: false });
    expect(provider.calls.length).toBeGreaterThanOrEqual(1);
    expect(result.review?.reviewSource).toBe("rules+model");
    expect(result.review?.residualRisks).toContain("模型补充的剩余风险");
  });

  it("model findings provide per-criterion evidence, severity, residual risks and fix scope", async () => {
    const providerDetailed = new FakeModelProvider({
      scenario: "success",
      successContent: modelReview({
        conclusion: "changes_requested",
        summary: "需求遗漏：未覆盖边界条件",
        severity: "high",
        residualRisks: ["空输入路径未验证"],
        fixScope: "补充边界用例并重新验证",
        findings: [
          {
            criterion: "覆盖空输入边界",
            met: false,
            evidence: "Diff 与测试结果中未见空输入用例",
            severity: "high",
            fixScope: "添加空输入测试"
          },
          {
            criterion: "产出 result.md",
            met: true,
            evidence: "Artifact 已登记",
            severity: "none"
          }
        ]
      })
    });
    const reviews = createReviews({ provider: providerDetailed });
    const run = await finishedRunWithEvidence();
    const result = await reviews.performReview(run.id, { autoDispatchFix: false });
    expect(result.review?.status).toBe("changes_requested");
    expect(result.review?.severity).toBe("high");
    expect(result.review?.fixScope).toMatch(/边界|空输入|验证/);
    expect(result.review?.residualRisks).toContain("空输入路径未验证");
    const missing = result.review?.findings?.find((finding) => finding.criterion.includes("空输入"));
    expect(missing?.met).toBe(false);
    expect(missing?.evidence).toBeTruthy();
    expect(missing?.severity).toBe("high");
  });
});

describe("formatReviewMarkdown", () => {
  it("renders a readable report from structured output", () => {
    const output: StructuredReviewOutput = {
      conclusion: "passed",
      summary: "ok",
      evidence: ["a"],
      severity: "none",
      findings: [{ criterion: "c1", met: true, evidence: "e1", severity: "none" }],
      residualRisks: ["r1"],
      reviewSource: "rules+model",
      modelRoleId: "role-1",
      modelId: "m-1",
      modifiedArtifacts: false,
      markdownReport: ""
    };
    const md = formatReviewMarkdown(output);
    expect(md).toContain("# Independent Review Report");
    expect(md).toContain("role-1");
    expect(md).toContain("r1");
    expect(md).toContain("[x]");
  });
});
