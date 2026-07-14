import type { Todo, TodoService } from "../todos/todoService.js";
import {
  CODEX_WORKTREE_EVIDENCE_KIND,
  CODEX_WORKTREE_FILE_KIND,
  type PlanVersionIndex,
  type ReviewFinding,
  type ReviewIndex,
  type ReviewSeverity,
  type Run,
  type RunService,
  type WorktreeArtifactEvidence
} from "../runs/runService.js";

/** Independent Reviewer input: never includes write credentials or mutation APIs. */
export interface ReviewContext {
  originalGoal: {
    title: string;
    description?: string;
    instructions: string[];
  };
  approvedPlan?: {
    version: number;
    summary: string;
    steps: string[];
    acceptanceCriteria: string[];
    prohibitions: string[];
    verificationCommands: string[][];
  };
  outcomes: {
    executionStatus: Run["execution"]["status"];
    completedSteps: string[];
    artifacts: Array<{ path: string; kind: string }>;
    logMessages: string[];
    timelineSummaries: string[];
  };
  evidence: string[];
  reviewCycle: number;
  autoFixCyclesUsed: number;
  maxAutoFixCycles: number;
}

export interface StructuredReviewOutput {
  conclusion: "passed" | "changes_requested";
  summary: string;
  evidence: string[];
  severity: ReviewSeverity;
  fixScope?: string;
  findings: ReviewFinding[];
  /** Reviewer never mutates code or artifacts; this is always false. */
  modifiedArtifacts: false;
}

export interface ReviewServiceOptions {
  runs: RunService;
  todos: TodoService;
  /** Optional Firstmate fix dispatcher; restarts the original agent with fix instructions. */
  dispatchFixAgent?: (runId: string, instruction: string) => Promise<Run>;
}

export interface PerformReviewResult {
  run: Run;
  review: ReviewIndex;
  fixDispatched: boolean;
}

export interface DispatchFixResult {
  run: Run;
  continued: boolean;
  reason?: "awaiting_write_session_approval" | "agent_not_started" | "prepared_only";
}

export interface AcceptanceResult {
  run: Run;
  todo: Todo;
}

/**
 * Independent Reviewer: assembles its own context from goal/plan/outcomes/evidence
 * and only emits structured conclusions — never mutates workspace artifacts.
 */
export class ReviewService {
  constructor(private readonly options: ReviewServiceOptions) {}

  async getContext(runId: string): Promise<ReviewContext> {
    const run = await this.options.runs.get(runId);
    const todo = await this.options.todos.get(run.todoId);
    return assembleReviewContext(run, todo);
  }

  async performReview(runId: string, input: { autoDispatchFix?: boolean } = {}): Promise<PerformReviewResult> {
    const run = await this.options.runs.get(runId);
    if (run.status !== "awaiting_review") {
      throw new Error("Independent review requires a Run that is awaiting review.");
    }
    if (run.execution.status !== "succeeded") {
      throw new Error("Independent review requires a succeeded Professional Agent execution.");
    }

    const todo = await this.options.todos.get(run.todoId);
    const context = assembleReviewContext(run, todo);
    const output = evaluateReview(context);
    const recorded = await this.options.runs.applyStructuredReview(runId, {
      status: output.conclusion,
      summary: output.summary,
      severity: output.severity,
      evidence: output.evidence,
      fixScope: output.fixScope,
      findings: output.findings,
      cycle: context.reviewCycle
    });

    const review = resolveIndependentReview(recorded);
    if (!review) throw new Error("Structured independent review was not persisted.");

    const autoDispatch = input.autoDispatchFix !== false
      && output.conclusion === "changes_requested"
      && (recorded.reviewLoop?.autoFixCyclesUsed ?? 0) < (recorded.reviewLoop?.maxAutoFixCycles ?? 1);

    if (!autoDispatch) {
      return { run: recorded, review, fixDispatched: false };
    }

    const fixed = await this.dispatchFix(runId, { userAuthorized: false });
    return { run: fixed.run, review, fixDispatched: fixed.continued };
  }

  async dispatchFix(runId: string, input: { userAuthorized?: boolean } = {}): Promise<DispatchFixResult> {
    const run = await this.options.runs.get(runId);
    const userAuthorized = input.userAuthorized === true;
    const gating = resolveIndependentReview(run);
    const rework = run.reviewLoop?.reworkRequested === true;
    const changesRequested = gating?.status === "changes_requested";
    const allow = changesRequested || (userAuthorized && rework);

    if (!allow) {
      throw new Error("Firstmate can only dispatch a fix after a Reviewer changes_requested conclusion, or a user-authorized rework after rejection.");
    }
    if (!userAuthorized && (run.reviewLoop?.autoFixCyclesUsed ?? 0) >= (run.reviewLoop?.maxAutoFixCycles ?? 1)) {
      throw new Error("Automatic fix cycle limit reached; user must authorize an additional fix or start a new Run.");
    }
    // Exhausted auto budget still allows explicit user-authorized fix on changes_requested.
    if (userAuthorized === false && !changesRequested) {
      throw new Error("Automatic fix requires a changes_requested independent review.");
    }

    const instructionSource = gating?.status === "changes_requested"
      ? gating
      : {
          id: "rework",
          status: "changes_requested" as const,
          summary: run.reviewLoop?.userAcceptanceSummary ?? "用户拒绝验收，要求返工。",
          createdAt: new Date().toISOString(),
          kind: "independent" as const,
          severity: "high" as const,
          evidence: ["用户拒绝验收"],
          fixScope: run.reviewLoop?.userAcceptanceSummary ?? "按用户拒绝说明返工。",
          findings: [{
            criterion: "用户验收",
            met: false,
            evidence: run.reviewLoop?.userAcceptanceSummary ?? "用户拒绝验收",
            severity: "high" as const,
            fixScope: "按用户反馈修改成果后再次提交审查。"
          }],
          role: "reviewer" as const
        };

    let prepared = run;
    if (!run.reviewLoop?.pendingFixInstruction) {
      prepared = await this.options.runs.prepareReviewFix(runId, buildFixInstruction(instructionSource), { userAuthorized });
    }

    if (!this.options.dispatchFixAgent || !prepared.execution.selectedAgent) {
      return { run: prepared, continued: false, reason: "prepared_only" };
    }

    try {
      await this.options.dispatchFixAgent(runId, prepared.reviewLoop?.pendingFixInstruction ?? buildFixInstruction(instructionSource));
    } catch {
      return { run: await this.options.runs.get(runId), continued: false, reason: "agent_not_started" };
    }

    const after = await this.options.runs.get(runId);
    if (after.execution.pendingApproval?.status === "awaiting_confirmation") {
      // Codex write-session re-approval: auto cycle must not be consumed until the session truly starts.
      if (!userAuthorized) await this.options.runs.rollbackUnusedAutoFixCycle(runId);
      return {
        run: await this.options.runs.get(runId),
        continued: false,
        reason: "awaiting_write_session_approval"
      };
    }

    const continued = after.execution.status === "running"
      || (after.status === "awaiting_review" && after.execution.status === "succeeded");
    return {
      run: after,
      continued,
      reason: continued ? undefined : "agent_not_started"
    };
  }

  async accept(runId: string, summary: string): Promise<AcceptanceResult> {
    const run = await this.options.runs.acceptReviewOutcome(runId, summary);
    const todo = await this.options.todos.get(run.todoId);
    return { run, todo };
  }

  async reject(runId: string, summary: string): Promise<AcceptanceResult> {
    const run = await this.options.runs.rejectReviewOutcome(runId, summary);
    const todo = await this.options.todos.get(run.todoId);
    return { run, todo };
  }
}

export function assembleReviewContext(run: Run, todo: Todo): ReviewContext {
  const approved = approvedPlan(run);
  const reviewLoop = run.reviewLoop ?? defaultReviewLoop();
  const evidence = collectEvidence(run, approved);
  const independentCount = run.reviews.filter((review) => review.kind === "independent").length;
  return {
    originalGoal: {
      title: todo.title,
      description: todo.description,
      instructions: run.messages.map((message) => message.content)
    },
    approvedPlan: approved
      ? {
          version: approved.version,
          summary: approved.summary,
          steps: approved.steps ?? [],
          acceptanceCriteria: approved.acceptanceCriteria ?? [],
          prohibitions: approved.prohibitions ?? [],
          verificationCommands: approved.verificationCommands ?? []
        }
      : undefined,
    outcomes: {
      executionStatus: run.execution.status,
      completedSteps: [...run.execution.completedSteps],
      // Product artifacts only — exclude the evidence bundle so no_modification cannot fake outcomes.
      artifacts: run.artifacts
        .filter((artifact) => artifact.kind !== CODEX_WORKTREE_EVIDENCE_KIND)
        .map((artifact) => ({ path: artifact.path, kind: artifact.kind })),
      logMessages: run.logs.map((log) => log.message),
      timelineSummaries: run.timeline.map((event) => event.summary)
    },
    evidence,
    reviewCycle: independentCount,
    autoFixCyclesUsed: reviewLoop.autoFixCyclesUsed,
    maxAutoFixCycles: reviewLoop.maxAutoFixCycles
  };
}

/** Pure evaluator: conclusion + evidence only; never touches the filesystem. */
export function evaluateReview(context: ReviewContext): StructuredReviewOutput {
  const findings: ReviewFinding[] = [];
  const criteria = context.approvedPlan?.acceptanceCriteria?.length
    ? context.approvedPlan.acceptanceCriteria
    : ["产出与用户已批准的计划和边界一致。"];

  for (const criterion of criteria) {
    findings.push(evaluateCriterion(criterion, context));
  }

  if (context.approvedPlan?.prohibitions?.length) {
    const violation = detectProhibitionViolation(context);
    findings.push({
      criterion: "未执行计划禁止项或未获批准的危险操作。",
      met: !violation,
      evidence: violation ?? "时间线中未发现禁止项违规证据。",
      severity: violation ? "critical" : "none",
      fixScope: violation ? "停止违规操作并在批准范围内重做成果。" : undefined
    });
  }

  const failed = findings.filter((finding) => !finding.met);
  if (failed.length === 0) {
    return {
      conclusion: "passed",
      summary: "独立审查通过：验收标准与证据一致。",
      evidence: context.evidence,
      severity: "none",
      findings,
      modifiedArtifacts: false
    };
  }

  const severity = highestSeverity(failed.map((finding) => finding.severity));
  const fixScope = failed.map((finding) => finding.fixScope).filter(Boolean).join(" ")
    || "按未通过的验收标准修复成果，不改变已批准计划边界。";
  return {
    conclusion: "changes_requested",
    summary: `独立审查未通过：${failed.map((finding) => finding.criterion).join("；")}`,
    evidence: failed.map((finding) => finding.evidence),
    severity,
    fixScope,
    findings,
    modifiedArtifacts: false
  };
}

export function buildFixInstruction(review: ReviewIndex): string {
  const findings = (review.findings ?? [])
    .filter((finding) => !finding.met)
    .map((finding) => `- ${finding.criterion}：${finding.fixScope ?? finding.evidence}`)
    .join("\n");
  const scope = review.fixScope?.trim() || "按审查结论修复未通过项。";
  return [
    "Firstmate 派发的审查修复任务（Reviewer 不修改成果，由原专业代理执行）：",
    scope,
    findings ? `未通过项：\n${findings}` : `审查摘要：${review.summary}`,
    "仅在已批准计划边界内修复；完成后不要声称已通过审查。"
  ].join("\n");
}

function evaluateCriterion(criterion: string, context: ReviewContext): ReviewFinding {
  const text = criterion.toLocaleLowerCase();

  if (/验证|verify|test|检查结果|记录到 run/.test(text)) {
    const met = hasCredibleVerificationEvidence(context);
    return {
      criterion,
      met,
      evidence: met
        ? "时间线/日志中存在可核对的验证结果（含命令与通过信号）。"
        : "缺少可核对的验证结果；仅有自称通过或关键词不足以满足验收。",
      severity: met ? "none" : "high",
      fixScope: met ? undefined : "运行计划中的验证命令，并将 exitCode/结果记录到 Run 时间线。"
    };
  }

  if (/禁止|危险|未获批准/.test(text)) {
    const violation = detectProhibitionViolation(context);
    return {
      criterion,
      met: !violation,
      evidence: violation ?? "未发现禁止项违规。",
      severity: violation ? "critical" : "none",
      fixScope: violation ? "撤销或隔离违规操作，并在边界内重做。" : undefined
    };
  }

  // Product/outcome criteria require formal artifacts after a successful execution (steps alone are insufficient).
  const hasArtifacts = context.outcomes.artifacts.length > 0;
  const met = context.outcomes.executionStatus === "succeeded" && hasArtifacts;
  return {
    criterion,
    met,
    evidence: met
      ? `执行成功；正式成果：${context.outcomes.artifacts.map((item) => item.path).join("、")}。`
      : "缺少正式 Artifact；仅有工具步骤或自称完成不能证明产出。",
    severity: met ? "none" : "high",
    fixScope: met ? undefined : "在批准范围内生成可验证成果并登记 Artifact。"
  };
}

/**
 * Prefer normalized Codex Worktree verification (`passed` / exitCode) over fragile log keywords like "passed".
 * Falls back to structured text forms only when no Worktree evidence is present.
 */
function hasCredibleVerificationEvidence(context: ReviewContext): boolean {
  const worktree = extractWorktreeEvidenceFromContext(context);
  if (worktree) {
    if (worktree.discarded) {
      // Discarded worktree keeps history but is not live proof of current product verification.
      return false;
    }
    if (worktree.changeStatus === "no_modification") {
      // Explicit no-modification is not a verification pass for product criteria.
      return worktree.verificationResults.length > 0 && worktree.verificationResults.every((row) => row.passed);
    }
    const commands = context.approvedPlan?.verificationCommands ?? [];
    if (commands.length > 0) {
      return commands.every((command) => {
        const match = worktree.verificationResults.find((row) => sameCommand(row.command, command));
        return Boolean(match && match.passed && match.exitCode === 0);
      });
    }
    return worktree.verificationResults.length > 0 && worktree.verificationResults.every((row) => row.passed && row.exitCode === 0);
  }

  const blob = [...context.outcomes.logMessages, ...context.outcomes.timelineSummaries, ...context.evidence].join("\n");
  const commands = context.approvedPlan?.verificationCommands ?? [];

  if (commands.length > 0) {
    return commands.every((command) => {
      const joined = command.join(" ");
      // Command must appear with a structured exitCode signal — not a bare "passed" keyword.
      const commandSeen = blob.includes(joined) || command.every((part) => blob.includes(part));
      const successSeen = /exitCode\s*[:=]\s*0|exit code 0|验证结果.*exitCode/i.test(blob);
      return commandSeen && successSeen;
    });
  }

  // No planned commands: require structured exitCode form, not "验证：npm test 通过" alone.
  return /验证结果\s*[：:].*exitCode\s*[:=]\s*0|verification result.*exitCode\s*[:=]\s*0|exitCode\s*[:=]\s*0/i.test(blob);
}

function extractWorktreeEvidenceFromContext(context: ReviewContext): WorktreeArtifactEvidence | undefined {
  for (const line of context.evidence) {
    if (!line.startsWith("worktree-evidence-json:")) continue;
    try {
      return JSON.parse(line.slice("worktree-evidence-json:".length)) as WorktreeArtifactEvidence;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sameCommand(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function detectProhibitionViolation(context: ReviewContext): string | undefined {
  const prohibitions = context.approvedPlan?.prohibitions ?? [];
  const blob = [...context.outcomes.timelineSummaries, ...context.outcomes.logMessages].join("\n");
  for (const prohibition of prohibitions) {
    if (/删除|delete/i.test(prohibition) && /删除|delete_file/i.test(blob) && /确认|approved|用户确认/i.test(blob) === false) {
      if (/拒绝.*删除|delete.*reject/i.test(blob)) return `可能违反禁止项：${prohibition}`;
    }
  }
  if (/未获授权|outside_workspace|工作区外|禁止/.test(blob) && /拒绝|rejected|不得/.test(blob)) {
    return "时间线显示曾尝试未授权操作（已拒绝）；若成果依赖该操作则需在边界内重做。";
  }
  return undefined;
}

function collectEvidence(run: Run, approved?: PlanVersionIndex): string[] {
  const evidence: string[] = [];
  evidence.push(`原始目标：${run.todoId} / 执行状态 ${run.execution.status}`);
  if (approved) {
    evidence.push(`已批准计划 v${approved.version}：${approved.summary}`);
    for (const criterion of approved.acceptanceCriteria ?? []) evidence.push(`验收标准：${criterion}`);
    for (const command of approved.verificationCommands ?? []) evidence.push(`计划验证命令：${command.join(" ")}`);
  }
  for (const step of run.execution.completedSteps) evidence.push(`完成步骤：${step}`);
  for (const artifact of run.artifacts) {
    evidence.push(`成果：${artifact.kind} ${artifact.path}`);
    if (artifact.kind === CODEX_WORKTREE_EVIDENCE_KIND && artifact.evidence?.source === "codex-worktree") {
      const wt = artifact.evidence;
      evidence.push(`Worktree 标识：${wt.worktreeRunId}；状态 ${wt.sessionStatus}${wt.discarded ? "（已丢弃）" : ""}`);
      evidence.push(`变更状态：${wt.changeStatus === "no_modification" ? "无修改" : `已修改 ${wt.changedFiles.length} 个文件`}`);
      if (wt.changedFiles.length > 0) evidence.push(`修改文件：${wt.changedFiles.join("、")}`);
      if (wt.diff) evidence.push(`完整 Diff 已登记（${wt.diff.length} 字符）`);
      for (const row of wt.verificationResults) {
        evidence.push(
          `结构化验证：${row.command.join(" ")} exitCode=${row.exitCode ?? "null"} passed=${row.passed}`
        );
      }
      if (wt.consistency === "missing_worktree") {
        evidence.push(`一致性：Worktree 缺失 — ${wt.consistencyNote ?? "请恢复或重新执行"}`);
      }
      // Machine-readable payload for hasCredibleVerificationEvidence (not keyword scraping).
      evidence.push(`worktree-evidence-json:${JSON.stringify(wt)}`);
    }
    if (artifact.kind === CODEX_WORKTREE_FILE_KIND) {
      evidence.push(`Worktree 文件成果：${artifact.path}${artifact.evidence?.discarded ? "（已丢弃）" : ""}`);
    }
  }
  for (const log of run.logs.slice(-20)) evidence.push(`日志：${log.message}`);
  for (const event of run.timeline.filter((item) => item.kind === "review" || item.kind === "artifact" || item.kind === "log").slice(-20)) {
    evidence.push(`时间线：${event.kind} ${event.summary}`);
  }
  return evidence;
}

function approvedPlan(run: Run): PlanVersionIndex | undefined {
  const version = run.planning?.approvedPlanVersion;
  if (version === undefined) return run.planVersions.at(-1);
  return run.planVersions.find((plan) => plan.version === version) ?? run.planVersions.at(-1);
}

function resolveIndependentReview(run: Run): ReviewIndex | undefined {
  const latestId = run.reviewLoop?.latestReviewId;
  if (!latestId) return undefined;
  const review = run.reviews.find((entry) => entry.id === latestId);
  if (!review || review.kind !== "independent" || review.role !== "reviewer") return undefined;
  if (!Array.isArray(review.findings) || !Array.isArray(review.evidence)) return undefined;
  return review;
}

function defaultReviewLoop() {
  return { autoFixCyclesUsed: 0, maxAutoFixCycles: 1 };
}

function highestSeverity(values: ReviewSeverity[]): ReviewSeverity {
  const order: ReviewSeverity[] = ["none", "low", "medium", "high", "critical"];
  return values.reduce<ReviewSeverity>((current, value) => (order.indexOf(value) > order.indexOf(current) ? value : current), "none");
}
