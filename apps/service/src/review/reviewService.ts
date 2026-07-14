import type { ModelRuntime } from "../model/modelRuntime.js";
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
import type {
  AppendRemediationResult,
  SubtaskAgentInstance,
  SubtaskDagService
} from "../subtasks/index.js";
import {
  REVIEWER_SYSTEM_INSTRUCTION,
  reviewerOutputSchema,
  type ReviewerModelOutput
} from "./reviewSchemas.js";
import {
  buildConstrainedFixInstruction,
  buildFixSubtasksFromReview,
  canApplyWorktreeAfterReview,
  selectFixAgent,
  shouldPauseForUserAfterFailedRemediation,
  type ReviewFixSubtaskSpec
} from "./reviewRemediation.js";

export {
  buildConstrainedFixInstruction,
  buildFixSubtasksFromReview,
  canApplyWorktreeAfterReview,
  selectFixAgent,
  shouldPauseForUserAfterFailedRemediation
} from "./reviewRemediation.js";
export type {
  BuildFixSubtasksResult,
  FixAgentSelectionInput,
  ReviewFixSubtaskSpec,
  ReviewProblemType,
  WorktreeApplyReviewGate
} from "./reviewRemediation.js";

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
    allowedScope: string[];
    expectedArtifacts: string[];
  };
  outcomes: {
    executionStatus: Run["execution"]["status"];
    completedSteps: string[];
    artifacts: Array<{ path: string; kind: string }>;
    logMessages: string[];
    timelineSummaries: string[];
  };
  evidence: string[];
  /** Diff / structured verification excerpts for substantive review (not executor chat). */
  modifications: {
    changedFiles: string[];
    diffExcerpt?: string;
    verificationResults: Array<{
      command: string[];
      exitCode: number | null;
      passed: boolean;
    }>;
    changeStatus?: "modified" | "no_modification";
    discarded?: boolean;
  };
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
  residualRisks: string[];
  markdownReport: string;
  reviewSource: "rules" | "model" | "rules+model";
  modelRoleId?: string;
  modelId?: string;
  /** Reviewer never mutates code or artifacts; this is always false. */
  modifiedArtifacts: false;
}

export interface ReviewServiceOptions {
  runs: RunService;
  todos: TodoService;
  /** Optional Firstmate fix dispatcher; restarts the original agent with fix instructions. */
  dispatchFixAgent?: (runId: string, instruction: string) => Promise<Run>;
  /**
   * Unified model runtime for independent LLM review (task 28).
   * When set with reviewerRoleId, rule pre-check cannot alone pass the review.
   */
  modelRuntime?: ModelRuntime;
  /** Agent Role used only for review — must be configurable separately from the executor. */
  reviewerRoleId?: string;
  /**
   * Optional subtask DAG service (Task 21/29). When set, review findings become
   * constrained remediation subtasks before Firstmate restarts the fix agent.
   */
  subtasks?: Pick<SubtaskDagService, "appendRemediationSubtasks">;
  /** Optional specialized fix agents Firstmate may prefer over the original executor. */
  fixSpecialists?: SubtaskAgentInstance[];
  /** Optional resolver for specialized fix roles by problem type. */
  resolveFixAgent?: (input: {
    spec: ReviewFixSubtaskSpec;
    originalAgent?: Run["execution"]["selectedAgent"];
  }) => SubtaskAgentInstance | undefined;
}

export interface PerformReviewResult {
  run: Run;
  review?: ReviewIndex;
  fixDispatched: boolean;
  /** True when the review model was unavailable / failed, or auto-fix budget exhausted. */
  paused?: boolean;
  pauseReason?: string;
  /** Present when findings were converted into remediation subtasks during auto-dispatch. */
  remediation?: RemediationDispatchSummary;
}

export interface RemediationDispatchSummary {
  subtaskIds: string[];
  instruction: string;
  unmetCount: number;
  dagCreated?: boolean;
  cancelledSubtaskIds?: string[];
}

export interface DispatchFixResult {
  run: Run;
  continued: boolean;
  reason?: "awaiting_write_session_approval" | "agent_not_started" | "prepared_only";
  remediation?: RemediationDispatchSummary;
}

export interface AcceptanceResult {
  run: Run;
  todo: Todo;
}

/**
 * Independent Reviewer: assembles its own context from goal/plan/outcomes/evidence
 * and only emits structured conclusions + Markdown — never mutates workspace artifacts.
 * Rule checks are deterministic pre-checks; when a review model is configured they cannot
 * replace model review (task 28).
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
    const precheck = evaluateReview(context);

    const usesModel = Boolean(this.options.modelRuntime && this.options.reviewerRoleId);
    let output: StructuredReviewOutput;

    if (usesModel) {
      const modelOutcome = await this.invokeModelReview(runId, context, precheck);
      if (modelOutcome.status === "paused") {
        const paused = await this.options.runs.transition(
          runId,
          "paused",
          modelOutcome.reason
        );
        return {
          run: paused,
          fixDispatched: false,
          paused: true,
          pauseReason: modelOutcome.reason
        };
      }
      output = modelOutcome.output;
    } else {
      output = {
        ...precheck,
        residualRisks: precheck.residualRisks,
        markdownReport: precheck.markdownReport || formatReviewMarkdown(precheck),
        reviewSource: "rules",
        modifiedArtifacts: false
      };
    }

    const recorded = await this.options.runs.applyStructuredReview(runId, {
      status: output.conclusion,
      summary: output.summary,
      severity: output.severity,
      evidence: output.evidence,
      fixScope: output.fixScope,
      findings: output.findings,
      cycle: context.reviewCycle,
      residualRisks: output.residualRisks,
      markdownReport: output.markdownReport,
      reviewSource: output.reviewSource,
      modelRoleId: output.modelRoleId,
      modelId: output.modelId
    });

    const review = resolveIndependentReview(recorded);
    if (!review) throw new Error("Structured independent review was not persisted.");

    const autoFixCyclesUsed = recorded.reviewLoop?.autoFixCyclesUsed ?? 0;
    const maxAutoFixCycles = recorded.reviewLoop?.maxAutoFixCycles ?? 1;
    const autoDispatch = input.autoDispatchFix !== false
      && output.conclusion === "changes_requested"
      && autoFixCyclesUsed < maxAutoFixCycles;

    if (autoDispatch) {
      const fixed = await this.dispatchFix(runId, { userAuthorized: false });
      return {
        run: fixed.run,
        review,
        fixDispatched: fixed.continued,
        remediation: fixed.remediation
      };
    }

    // Task 29: after the single auto remediation cycle, still failing → pause for user.
    if (
      shouldPauseForUserAfterFailedRemediation({
        conclusion: output.conclusion,
        autoFixCyclesUsed,
        maxAutoFixCycles,
        autoDispatchEnabled: input.autoDispatchFix !== false
      })
    ) {
      const pauseReason =
        "自动修复循环已用尽，独立复审仍未通过；已暂停并交由用户决定（授权再次修复或调整范围）。";
      const paused = await this.options.runs.transition(runId, "paused", pauseReason);
      return {
        run: paused,
        review,
        fixDispatched: false,
        paused: true,
        pauseReason
      };
    }

    return { run: recorded, review, fixDispatched: false };
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

    // Task 29: convert each confirmed finding into a constrained fix subtask (+ re-verify).
    const plan = approvedPlan(run);
    const built = buildFixSubtasksFromReview({
      review: instructionSource,
      allowedScope: plan?.allowedScope,
      cycle: instructionSource.cycle ?? (run.reviews.filter((r) => r.kind === "independent").length - 1)
    });
    const instruction = built.unmetCount > 0
      ? built.instruction
      : buildFixInstruction(instructionSource);

    let remediation: RemediationDispatchSummary | undefined;
    if (this.options.subtasks && built.explicitSubtasks.length > 0) {
      const assignments = built.specs.map((spec) => {
        const resolved = this.options.resolveFixAgent?.({
          spec,
          originalAgent: run.execution.selectedAgent
        });
        const agent = resolved ?? selectFixAgent({
          spec,
          originalAgent: run.execution.selectedAgent,
          fixSpecialists: this.options.fixSpecialists
        });
        return { subtaskId: spec.id, agent };
      });
      const appended = await this.options.subtasks.appendRemediationSubtasks({
        runId,
        reviewId: instructionSource.id,
        planVersion: plan?.version,
        cycle: instructionSource.cycle ?? 0,
        explicitSubtasks: built.explicitSubtasks,
        agentAssignments: assignments,
        autoSchedule: true
      });
      remediation = toRemediationSummary(built.specs, instruction, built.unmetCount, appended);
      await this.options.runs.recordLog(runId, {
        level: "info",
        message: `审查修复子任务已派发：${remediation.subtaskIds.join(", ")}（${built.unmetCount} 个未通过项；验证子任务含在内）。`
      });
    } else if (built.unmetCount > 0) {
      remediation = {
        subtaskIds: built.specs.map((s) => s.id),
        instruction,
        unmetCount: built.unmetCount
      };
    }

    let prepared = run;
    if (!run.reviewLoop?.pendingFixInstruction) {
      prepared = await this.options.runs.prepareReviewFix(runId, instruction, { userAuthorized });
    }

    if (!this.options.dispatchFixAgent || !prepared.execution.selectedAgent) {
      return { run: prepared, continued: false, reason: "prepared_only", remediation };
    }

    try {
      await this.options.dispatchFixAgent(
        runId,
        prepared.reviewLoop?.pendingFixInstruction ?? instruction
      );
    } catch {
      return {
        run: await this.options.runs.get(runId),
        continued: false,
        reason: "agent_not_started",
        remediation
      };
    }

    const after = await this.options.runs.get(runId);
    if (after.execution.pendingApproval?.status === "awaiting_confirmation") {
      // Codex write-session re-approval: auto cycle must not be consumed until the session truly starts.
      if (!userAuthorized) await this.options.runs.rollbackUnusedAutoFixCycle(runId);
      return {
        run: await this.options.runs.get(runId),
        continued: false,
        reason: "awaiting_write_session_approval",
        remediation
      };
    }

    const continued = after.execution.status === "running"
      || (after.status === "awaiting_review" && after.execution.status === "succeeded");
    return {
      run: after,
      continued,
      reason: continued ? undefined : "agent_not_started",
      remediation
    };
  }

  /** Gate helper: Worktree apply / formal complete require passed independent review + user accept. */
  canApplyWorktree(run: Run) {
    return canApplyWorktreeAfterReview(run);
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

  private async invokeModelReview(
    runId: string,
    context: ReviewContext,
    precheck: StructuredReviewOutput
  ): Promise<
    | { status: "ok"; output: StructuredReviewOutput }
    | { status: "paused"; reason: string }
  > {
    const modelRuntime = this.options.modelRuntime!;
    const reviewerRoleId = this.options.reviewerRoleId!;

    const result = await modelRuntime.invoke({
      roleId: reviewerRoleId,
      runId,
      overrideSystem: REVIEWER_SYSTEM_INSTRUCTION,
      schema: reviewerOutputSchema,
      messages: [
        {
          role: "user",
          content: buildReviewerUserPrompt(context, precheck)
        }
      ]
    });

    if (!result.ok) {
      // Never auto-switch models or fall back to a synthetic pass.
      return {
        status: "paused",
        reason: `独立审查模型不可用或调用失败（${result.error.kind}）：${result.error.message}。已暂停，请修复审查模型/连接后重试，不会自动更换模型。`
      };
    }

    const parsed = result.parsed as ReviewerModelOutput | undefined;
    if (!parsed || typeof parsed !== "object") {
      return {
        status: "paused",
        reason: "独立审查模型返回了无法解析的结构化结果。已暂停，未伪造通过结论。"
      };
    }

    // Reviewer must never claim it modified artifacts.
    if (parsed.modifiedArtifacts !== false) {
      return {
        status: "paused",
        reason: "独立审查模型违规声称修改了成果。已暂停且不采纳该结论。"
      };
    }

    const modelFindings = normalizeFindings(parsed.findings);
    if (modelFindings.length === 0) {
      return {
        status: "paused",
        reason: "独立审查模型未返回任何验收结论。已暂停，未伪造通过结论。"
      };
    }

    // Deterministic pre-check hard gates cannot be overridden by a model "pass".
    const hardFailures = precheck.findings.filter((finding) => !finding.met);
    const mergedFindings = mergeFindings(modelFindings, hardFailures);

    const modelFailed = parsed.conclusion === "changes_requested"
      || modelFindings.some((finding) => !finding.met);
    const hardFailed = hardFailures.length > 0;
    const conclusion: StructuredReviewOutput["conclusion"] =
      modelFailed || hardFailed ? "changes_requested" : "passed";

    const residualRisks = uniqueStrings([
      ...(Array.isArray(parsed.residualRisks) ? parsed.residualRisks : []),
      ...precheck.residualRisks
    ]);

    const severity = highestSeverity([
      normalizeSeverity(parsed.severity),
      ...mergedFindings.filter((f) => !f.met).map((f) => f.severity),
      ...(hardFailed ? [precheck.severity] : [])
    ]);

    const failed = mergedFindings.filter((finding) => !finding.met);
    const summary = conclusion === "passed"
      ? (parsed.summary?.trim() || "独立模型审查通过：验收标准与证据一致。")
      : (parsed.summary?.trim()
        || `独立审查未通过：${failed.map((finding) => finding.criterion).join("；")}`);

    const evidence = uniqueStrings([
      ...(Array.isArray(parsed.evidence) ? parsed.evidence : []),
      ...failed.map((finding) => finding.evidence),
      ...hardFailures.map((finding) => `前置规则：${finding.evidence}`)
    ]);

    const fixScope = conclusion === "changes_requested"
      ? (parsed.fixScope?.trim()
        || failed.map((finding) => finding.fixScope).filter(Boolean).join(" ")
        || precheck.fixScope
        || "按未通过的验收标准修复成果，不改变已批准计划边界。")
      : parsed.fixScope?.trim() || undefined;

    const output: StructuredReviewOutput = {
      conclusion,
      summary,
      evidence,
      severity: conclusion === "passed" ? "none" : severity,
      fixScope,
      findings: mergedFindings,
      residualRisks,
      reviewSource: "rules+model",
      modelRoleId: result.config?.roleId ?? reviewerRoleId,
      modelId: result.config?.modelId,
      modifiedArtifacts: false,
      markdownReport: ""
    };
    output.markdownReport = formatReviewMarkdown(output);
    return { status: "ok", output };
  }
}

export function assembleReviewContext(run: Run, todo: Todo): ReviewContext {
  const approved = approvedPlan(run);
  const reviewLoop = run.reviewLoop ?? defaultReviewLoop();
  const evidence = collectEvidence(run, approved);
  const independentCount = run.reviews.filter((review) => review.kind === "independent").length;
  const modifications = extractModifications(run);
  return {
    originalGoal: {
      title: todo.title,
      description: todo.description,
      // User/todo instructions only — never the executor's multi-turn tool dialogue.
      instructions: run.messages.map((message) => message.content)
    },
    approvedPlan: approved
      ? {
          version: approved.version,
          summary: approved.summary,
          steps: approved.steps ?? [],
          acceptanceCriteria: approved.acceptanceCriteria ?? [],
          prohibitions: approved.prohibitions ?? [],
          verificationCommands: approved.verificationCommands ?? [],
          allowedScope: approved.allowedScope ?? [],
          expectedArtifacts: approved.expectedArtifacts ?? []
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
    modifications,
    reviewCycle: independentCount,
    autoFixCyclesUsed: reviewLoop.autoFixCyclesUsed,
    maxAutoFixCycles: reviewLoop.maxAutoFixCycles
  };
}

/** Pure evaluator: conclusion + evidence only; never touches the filesystem. Deterministic pre-check. */
export function evaluateReview(context: ReviewContext): StructuredReviewOutput {
  const findings: ReviewFinding[] = [];
  const residualRisks: string[] = [];
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

  // Extra hard gates beyond free-form criteria text matching.
  findings.push(...detectStructuralIssues(context));

  const failed = findings.filter((finding) => !finding.met);
  if (context.modifications.discarded) {
    residualRisks.push("Worktree 证据已丢弃，当前产物可能与主工作区不一致。");
  }
  if (context.modifications.changeStatus === "no_modification" && context.outcomes.artifacts.length === 0) {
    residualRisks.push("无修改且缺少正式 Artifact，产物完整性依赖后续确认。");
  }

  if (failed.length === 0) {
    const passed: StructuredReviewOutput = {
      conclusion: "passed",
      summary: "独立审查通过：验收标准与证据一致。",
      evidence: context.evidence,
      severity: "none",
      findings,
      residualRisks,
      reviewSource: "rules",
      modifiedArtifacts: false,
      markdownReport: ""
    };
    passed.markdownReport = formatReviewMarkdown(passed);
    return passed;
  }

  const severity = highestSeverity(failed.map((finding) => finding.severity));
  const fixScope = failed.map((finding) => finding.fixScope).filter(Boolean).join(" ")
    || "按未通过的验收标准修复成果，不改变已批准计划边界。";
  const failedOutput: StructuredReviewOutput = {
    conclusion: "changes_requested",
    summary: `独立审查未通过：${failed.map((finding) => finding.criterion).join("；")}`,
    evidence: failed.map((finding) => finding.evidence),
    severity,
    fixScope,
    findings,
    residualRisks,
    reviewSource: "rules",
    modifiedArtifacts: false,
    markdownReport: ""
  };
  failedOutput.markdownReport = formatReviewMarkdown(failedOutput);
  return failedOutput;
}

export function buildFixInstruction(review: ReviewIndex): string {
  // Prefer Task 29 constrained multi-subtask instruction when structured findings exist.
  const unmet = (review.findings ?? []).filter((finding) => !finding.met);
  if (unmet.length > 0) {
    return buildConstrainedFixInstruction({
      review,
      specs: buildFixSubtasksFromReview({
        review,
        includeVerificationSubtask: true
      }).specs.filter((spec) => spec.sourceFindingIndex >= 0),
      verificationIncluded: true
    });
  }
  const scope = review.fixScope?.trim() || "按审查结论修复未通过项。";
  const risks = (review.residualRisks ?? []).length
    ? `剩余风险：\n${(review.residualRisks ?? []).map((risk) => `- ${risk}`).join("\n")}`
    : "";
  return [
    "Firstmate 派发的审查修复任务（Reviewer 不修改成果，由原专业代理执行）：",
    scope,
    `审查摘要：${review.summary}`,
    risks,
    "仅在已批准计划边界内修复；禁止无关重构；完成后不要声称已通过审查。"
  ].filter(Boolean).join("\n");
}

function toRemediationSummary(
  specs: ReviewFixSubtaskSpec[],
  instruction: string,
  unmetCount: number,
  appended?: AppendRemediationResult
): RemediationDispatchSummary {
  return {
    subtaskIds: appended?.createdIds ?? specs.map((s) => s.id),
    instruction,
    unmetCount,
    dagCreated: appended?.created,
    cancelledSubtaskIds: appended?.cancelledIds
  };
}

/** Render structured review as readable Markdown (saved with the independent review). */
export function formatReviewMarkdown(output: Pick<
  StructuredReviewOutput,
  "conclusion" | "summary" | "severity" | "evidence" | "fixScope" | "findings" | "residualRisks" | "reviewSource" | "modelRoleId" | "modelId"
>): string {
  const lines: string[] = [
    "# Independent Review Report",
    "",
    `## Conclusion: \`${output.conclusion}\``,
    "",
    `**Severity:** ${output.severity}`,
    `**Source:** ${output.reviewSource ?? "rules"}`,
  ];
  if (output.modelRoleId) lines.push(`**Review model role:** ${output.modelRoleId}`);
  if (output.modelId) lines.push(`**Review model:** ${output.modelId}`);
  lines.push("", "## Summary", "", output.summary, "", "## Acceptance findings", "");
  for (const finding of output.findings) {
    const mark = finding.met ? "x" : " ";
    lines.push(`- [${mark}] **${finding.criterion}** — ${finding.evidence} _(severity: ${finding.severity})_`);
    if (finding.fixScope && !finding.met) {
      lines.push(`  - Fix scope: ${finding.fixScope}`);
    }
  }
  lines.push("", "## Supporting evidence", "");
  if (output.evidence.length === 0) {
    lines.push("_No additional evidence listed._");
  } else {
    for (const item of output.evidence) lines.push(`- ${item}`);
  }
  lines.push("", "## Residual risks", "");
  if (!output.residualRisks?.length) {
    lines.push("_None recorded._");
  } else {
    for (const risk of output.residualRisks) lines.push(`- ${risk}`);
  }
  if (output.fixScope) {
    lines.push("", "## Suggested fix scope", "", output.fixScope);
  }
  lines.push(
    "",
    "## Notes",
    "",
    "- Reviewer only produced this report; no write tools were invoked and artifacts were not modified.",
    "- Final user acceptance is a separate step after a passed independent review."
  );
  return lines.join("\n");
}

export function buildReviewerUserPrompt(context: ReviewContext, precheck: StructuredReviewOutput): string {
  return [
    "Perform an independent substantive review. Return structured JSON only.",
    "Do not call tools. Do not modify files or artifacts. modifiedArtifacts must be false.",
    "A deterministic pre-check already ran; you must still perform model review and cannot ignore hard failures.",
    "",
    "### Deterministic pre-check (hard gates — do not override failures to pass)",
    JSON.stringify({
      conclusion: precheck.conclusion,
      severity: precheck.severity,
      findings: precheck.findings,
      residualRisks: precheck.residualRisks
    }, null, 2),
    "",
    "### Independent review context (not the executor conversation)",
    JSON.stringify({
      originalGoal: context.originalGoal,
      approvedPlan: context.approvedPlan,
      outcomes: {
        executionStatus: context.outcomes.executionStatus,
        completedSteps: context.outcomes.completedSteps,
        artifacts: context.outcomes.artifacts,
        // Cap noisy logs for the model while keeping structured evidence separately.
        logMessages: context.outcomes.logMessages.slice(-30),
        timelineSummaries: context.outcomes.timelineSummaries.slice(-30)
      },
      modifications: {
        changedFiles: context.modifications.changedFiles,
        changeStatus: context.modifications.changeStatus,
        discarded: context.modifications.discarded,
        verificationResults: context.modifications.verificationResults,
        diffExcerpt: context.modifications.diffExcerpt
          ? context.modifications.diffExcerpt.slice(0, 12_000)
          : undefined
      },
      evidence: context.evidence.slice(0, 80),
      reviewCycle: context.reviewCycle
    }, null, 2)
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
 * Structural hard gates: fake success logs, failed verification, incomplete worktree artifacts, out-of-scope signals.
 */
function detectStructuralIssues(context: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  if (hasFakeSuccessLogOnly(context)) {
    findings.push({
      criterion: "验证证据必须可核对，不得仅依赖伪成功日志关键词。",
      met: false,
      evidence: "检测到“通过/passed”类自述日志，但缺少 exitCode=0 或结构化 Worktree 验证结果。",
      severity: "high",
      fixScope: "重新运行验证并登记结构化 exitCode/passed 结果，删除不可核对的伪成功声明。"
    });
  }

  const failedVerification = context.modifications.verificationResults.find((row) => !row.passed || row.exitCode !== 0);
  if (failedVerification) {
    findings.push({
      criterion: "计划验证命令必须全部通过。",
      met: false,
      evidence: `验证失败：${failedVerification.command.join(" ")} exitCode=${failedVerification.exitCode ?? "null"} passed=${failedVerification.passed}`,
      severity: "critical",
      fixScope: "修复导致验证失败的问题后重新运行相关验证。"
    });
  }

  if (context.modifications.discarded) {
    findings.push({
      criterion: "可审查 Artifact/Worktree 证据必须完整可用。",
      met: false,
      evidence: "Worktree 证据已标记为 discarded，不能作为当前成果的有效证明。",
      severity: "high",
      fixScope: "恢复或重新执行以产生可审查的 Artifact 与 Diff。"
    });
  }

  const outOfScope = detectOutOfScopeModification(context);
  if (outOfScope) {
    findings.push({
      criterion: "实际修改不得超出已批准计划边界。",
      met: false,
      evidence: outOfScope,
      severity: "high",
      fixScope: "撤销越界修改，仅在 allowedScope / 批准步骤范围内交付。"
    });
  }

  return findings;
}

function hasFakeSuccessLogOnly(context: ReviewContext): boolean {
  const blob = [...context.outcomes.logMessages, ...context.outcomes.timelineSummaries].join("\n");
  const keywordClaim = /验证[：:].*通过|npm test 通过|\bpassed\b|tests? passed|全部通过/i.test(blob);
  if (!keywordClaim) return false;
  // Structured proof present → not fake-only.
  if (hasCredibleVerificationEvidence(context)) return false;
  return true;
}

function detectOutOfScopeModification(context: ReviewContext): string | undefined {
  const plan = context.approvedPlan;
  if (!plan) return undefined;
  const changed = context.modifications.changedFiles;
  if (changed.length === 0) return undefined;

  const blob = [...context.outcomes.timelineSummaries, ...context.outcomes.logMessages].join("\n");
  if (/越界|out[- ]of[- ]scope|outside_workspace|工作区外|未获批准的范围/i.test(blob)) {
    return "时间线/日志出现越界修改信号。";
  }

  // Prefer explicit allowedScope from the approved plan when present.
  const allowedScope = plan.allowedScope ?? [];
  if (allowedScope.length > 0) {
    const outside = changed.filter((file) => {
      const lower = file.replace(/\\/g, "/").toLocaleLowerCase();
      return !allowedScope.some((scope) => {
        const hint = scope.replace(/\\/g, "/").toLocaleLowerCase().replace(/\*\*$/, "").replace(/\*$/, "");
        return lower.startsWith(hint.replace(/\/$/, "")) || lower.includes(hint.replace(/\/$/, ""));
      });
    });
    if (outside.length > 0) {
      return `修改文件超出 allowedScope：${outside.slice(0, 8).join("、")}${outside.length > 8 ? "…" : ""}。`;
    }
    return undefined;
  }

  // Heuristic: plan summary/steps name a specific folder (e.g. src/auth) but changes leave that area.
  const pathMentions = Array.from(
    new Set(
      [...plan.steps, plan.summary]
        .join("\n")
        .match(/(?:src|apps|packages|lib|tests?)\/[a-zA-Z0-9._*-]+/g) ?? []
    )
  ).map((item) => item.toLocaleLowerCase());

  if (pathMentions.length === 0) return undefined;

  const outside = changed.filter((file) => {
    const lower = file.replace(/\\/g, "/").toLocaleLowerCase();
    return !pathMentions.some((hint) => lower.includes(hint.replace(/\*$/, "")));
  });

  if (outside.length === 0) return undefined;
  if (outside.length < changed.length && outside.length / changed.length < 0.5) return undefined;
  return `修改文件疑似越界：${outside.slice(0, 8).join("、")}${outside.length > 8 ? "…" : ""}（相对计划提及路径 ${pathMentions.join(", ")}）。`;
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

function extractModifications(run: Run): ReviewContext["modifications"] {
  const empty: ReviewContext["modifications"] = {
    changedFiles: [],
    verificationResults: []
  };
  const evidenceArtifact = run.artifacts.find(
    (artifact) => artifact.kind === CODEX_WORKTREE_EVIDENCE_KIND && artifact.evidence?.source === "codex-worktree"
  );
  if (!evidenceArtifact?.evidence) {
    // Fall back to worktree-file artifact paths.
    const files = run.artifacts
      .filter((artifact) => artifact.kind === CODEX_WORKTREE_FILE_KIND)
      .map((artifact) => artifact.path);
    return { ...empty, changedFiles: files };
  }
  const wt = evidenceArtifact.evidence;
  return {
    changedFiles: [...wt.changedFiles],
    diffExcerpt: wt.diff,
    verificationResults: wt.verificationResults.map((row) => ({
      command: [...row.command],
      exitCode: row.exitCode,
      passed: row.passed
    })),
    changeStatus: wt.changeStatus,
    discarded: wt.discarded
  };
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
  // Require concrete attempt/rejection signals — not remediation instruction text like
  // “禁止顺手重构 / 不得声称已通过审查” which is policy language, not a violation.
  const attemptedUnauthorized =
    /尝试未授权|未获授权操作|outside_workspace|工作区外操作|危险操作.*拒绝|拒绝.*危险操作|pendingApproval.*reject|execution approval.*reject/i.test(blob)
    || (/未获授权|outside_workspace|工作区外/.test(blob) && /已拒绝|rejected|用户拒绝该操作/.test(blob));
  if (attemptedUnauthorized) {
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
    for (const prohibition of approved.prohibitions ?? []) evidence.push(`边界/禁止：${prohibition}`);
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

function normalizeSeverity(value: unknown): ReviewSeverity {
  const order: ReviewSeverity[] = ["none", "low", "medium", "high", "critical"];
  if (typeof value === "string" && (order as string[]).includes(value)) return value as ReviewSeverity;
  return "medium";
}

function normalizeFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  const findings: ReviewFinding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const criterion = typeof record.criterion === "string" ? record.criterion.trim() : "";
    const evidence = typeof record.evidence === "string" ? record.evidence.trim() : "";
    if (!criterion || !evidence) continue;
    findings.push({
      criterion,
      met: Boolean(record.met),
      evidence,
      severity: normalizeSeverity(record.severity),
      fixScope: typeof record.fixScope === "string" && record.fixScope.trim()
        ? record.fixScope.trim()
        : undefined
    });
  }
  return findings;
}

function mergeFindings(model: ReviewFinding[], hardFailures: ReviewFinding[]): ReviewFinding[] {
  const byCriterion = new Map<string, ReviewFinding>();
  for (const finding of model) {
    byCriterion.set(finding.criterion, finding);
  }
  for (const hard of hardFailures) {
    const existing = byCriterion.get(hard.criterion);
    if (!existing) {
      byCriterion.set(hard.criterion, hard);
      continue;
    }
    // Hard failure wins: cannot be marked met by the model.
    byCriterion.set(hard.criterion, {
      ...existing,
      met: false,
      evidence: `${existing.evidence} | 前置规则：${hard.evidence}`,
      severity: highestSeverity([existing.severity, hard.severity]),
      fixScope: existing.fixScope ?? hard.fixScope
    });
  }
  return [...byCriterion.values()];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
