/**
 * Review remediation loop (Task 29).
 *
 * Converts independent Reviewer findings into constrained fix subtasks,
 * selects the original executor or a fix specialist (never the Reviewer),
 * and provides gates for auto-cycle limits + worktree apply / completion.
 */

import type {
  ReviewFinding,
  ReviewIndex,
  ReviewSeverity,
  Run,
  RunExecutionState
} from "../runs/runService.js";
import type {
  ExplicitSubtaskDef,
  SubtaskAgentInstance,
  SubtaskPermissions
} from "../subtasks/subtaskTypes.js";

export type ReviewProblemType =
  | "verification"
  | "artifact"
  | "scope"
  | "prohibition"
  | "acceptance"
  | "other";

export type FixAgentPreference = "original" | "fix_specialist";

/** One constrained fix unit derived from a single unmet review finding. */
export interface ReviewFixSubtaskSpec {
  id: string;
  sourceReviewId: string;
  sourceFindingIndex: number;
  title: string;
  description: string;
  evidence: string[];
  severity: ReviewSeverity;
  allowedScope: string[];
  acceptanceCriteria: string[];
  fixScope: string;
  /** Hard constraint text — fix agent must not refactor unrelated content. */
  constraint: string;
  problemType: ReviewProblemType;
  agentPreference: FixAgentPreference;
  requiredCapabilities: string[];
  /** Optional specialized role hint when agentPreference is fix_specialist. */
  preferredRoleHint?: string;
}

export interface BuildFixSubtasksInput {
  review: ReviewIndex;
  /** Approved plan allowedScope; falls back to finding fixScope. */
  allowedScope?: string[];
  /** Review cycle number (for stable ids). */
  cycle?: number;
  /** Whether to append a final re-verification subtask (default true). */
  includeVerificationSubtask?: boolean;
}

export interface BuildFixSubtasksResult {
  specs: ReviewFixSubtaskSpec[];
  /** Explicit subtask defs ready for SubtaskDagService.appendRemediationSubtasks. */
  explicitSubtasks: ExplicitSubtaskDef[];
  /** Combined constrained instruction for the fix agent / Firstmate dispatch. */
  instruction: string;
  unmetCount: number;
}

export interface FixAgentSelectionInput {
  spec: ReviewFixSubtaskSpec;
  originalAgent?: RunExecutionState["selectedAgent"];
  /** Optional specialized agents available for Firstmate to pick. */
  fixSpecialists?: SubtaskAgentInstance[];
}

export interface WorktreeApplyReviewGate {
  ok: boolean;
  reason?: string;
  reviewPassed: boolean;
  userAccepted: boolean;
}

const SEVERITY_ORDER: ReviewSeverity[] = ["none", "low", "medium", "high", "critical"];

/**
 * Convert unmet independent-review findings into constrained fix subtasks.
 * Each subtask carries evidence, severity, allowed scope, and acceptance criteria.
 */
export function buildFixSubtasksFromReview(input: BuildFixSubtasksInput): BuildFixSubtasksResult {
  const review = input.review;
  const cycle = input.cycle ?? review.cycle ?? 0;
  const planScope = (input.allowedScope ?? []).map((s) => s.trim()).filter(Boolean);
  const unmet = (review.findings ?? [])
    .map((finding, index) => ({ finding, index }))
    .filter((row) => !row.finding.met);

  const specs: ReviewFixSubtaskSpec[] = unmet.map(({ finding, index }) => {
    const problemType = classifyFinding(finding);
    const severity = normalizeSeverity(finding.severity);
    const fixScope = (finding.fixScope?.trim() || finding.evidence || finding.criterion).trim();
    const allowedScope = uniqueStrings([
      ...planScope,
      ...(finding.fixScope ? [finding.fixScope.trim()] : []),
      "已确认的审查问题（不得越界重构）"
    ]);
    const evidence = uniqueStrings([
      finding.evidence,
      ...(review.evidence ?? []).slice(0, 4)
    ]);
    const acceptanceCriteria = uniqueStrings([
      `满足验收标准：${finding.criterion}`,
      `修复后有可核对证据支持：${finding.criterion}`,
      "未改动与本问题无关的代码/文档"
    ]);
    const constraint = [
      "仅处理已确认的审查问题，禁止顺手重构、格式化无关文件或扩大修改范围。",
      `问题：${finding.criterion}`,
      `允许范围：${allowedScope.join("；")}`,
      `修复范围：${fixScope}`
    ].join(" ");

    return {
      id: `remediation-c${cycle}-f${index}`,
      sourceReviewId: review.id,
      sourceFindingIndex: index,
      title: `修复审查问题：${truncate(finding.criterion, 80)}`,
      description: [
        `来源审查 ${review.id}（finding #${index}）`,
        `严重程度：${severity}`,
        `证据：${finding.evidence}`,
        `问题类型：${problemType}`,
        constraint
      ].join("\n"),
      evidence,
      severity,
      allowedScope,
      acceptanceCriteria,
      fixScope,
      constraint,
      problemType,
      agentPreference: preferAgentForProblem(problemType, severity),
      requiredCapabilities: capabilitiesForProblem(problemType),
      preferredRoleHint: problemType === "verification" ? "tests" : problemType === "scope" ? "safe-fix" : undefined
    };
  });

  const includeVerification = input.includeVerificationSubtask !== false && specs.length > 0;
  if (includeVerification) {
    const depIds = specs.map((s) => s.id);
    const verifyScope = uniqueStrings([...planScope, "计划验证命令", "Run 时间线验证结果"]);
    specs.push({
      id: `remediation-c${cycle}-verify`,
      sourceReviewId: review.id,
      sourceFindingIndex: -1,
      title: "修复后重新运行相关验证并登记证据",
      description: [
        `来源审查 ${review.id}`,
        "在所有确认问题修复完成后，重新运行相关验证，并将 exitCode/结构化结果写入 Run。",
        "不得声称已通过独立审查。"
      ].join("\n"),
      evidence: uniqueStrings(review.evidence ?? []).slice(0, 6),
      severity: highestSeverity(specs.map((s) => s.severity)),
      allowedScope: verifyScope,
      acceptanceCriteria: [
        "相关验证命令全部通过且 exitCode=0",
        "验证结果已结构化登记到 Run（非关键词自述）"
      ],
      fixScope: "重新运行相关验证并登记可核对证据。",
      constraint: "仅重新运行与已确认问题相关的验证；不得修改无关实现。",
      problemType: "verification",
      agentPreference: "original",
      requiredCapabilities: ["shell", "tests", "workspace"],
      preferredRoleHint: "tests"
    });
    // verification depends on all fix specs — encoded later in explicitSubtasks
    void depIds;
  }

  const explicitSubtasks = specsToExplicit(specs, cycle);
  const instruction = buildConstrainedFixInstruction({
    review,
    specs: specs.filter((s) => s.sourceFindingIndex >= 0),
    verificationIncluded: includeVerification
  });

  return {
    specs,
    explicitSubtasks,
    instruction,
    unmetCount: unmet.length
  };
}

/** Build Firstmate dispatch instruction that only addresses confirmed findings. */
export function buildConstrainedFixInstruction(input: {
  review: Pick<ReviewIndex, "id" | "summary" | "fixScope" | "residualRisks" | "severity">;
  specs: ReviewFixSubtaskSpec[];
  verificationIncluded?: boolean;
}): string {
  const { review, specs } = input;
  if (specs.length === 0) {
    const scope = review.fixScope?.trim() || "按审查结论修复未通过项。";
    return [
      "Firstmate 派发的审查修复任务（Reviewer 不修改成果，由原专业代理或修复代理执行）：",
      scope,
      `审查摘要：${review.summary}`,
      "仅在已确认问题与批准计划边界内修复；禁止无关重构；完成后不要声称已通过审查。"
    ].join("\n");
  }

  const lines = specs.map((spec, i) => {
    return [
      `${i + 1}. [${spec.severity}] ${spec.title}`,
      `   证据：${spec.evidence[0] ?? "（见审查）"}`,
      `   允许范围：${spec.allowedScope.join("；")}`,
      `   验收：${spec.acceptanceCriteria.join("；")}`,
      `   约束：${spec.constraint}`
    ].join("\n");
  });

  const risks = (review.residualRisks ?? []).length
    ? `剩余风险：\n${(review.residualRisks ?? []).map((r) => `- ${r}`).join("\n")}`
    : "";

  return [
    "Firstmate 派发的审查修复子任务（Reviewer 只出报告，不修改成果）：",
    `来源审查：${review.id}${review.severity ? `；严重程度 ${review.severity}` : ""}`,
    review.fixScope?.trim() ? `总体修复范围：${review.fixScope.trim()}` : "",
    "已确认问题（逐项处理，禁止顺手重构无关内容）：",
    ...lines,
    input.verificationIncluded
      ? "全部问题修复后必须重新运行相关验证，并将结构化 exitCode/结果登记到 Run。"
      : "",
    risks,
    "仅在已批准计划边界与上述允许范围内修复；完成后不要声称已通过独立审查或用户验收。"
  ].filter(Boolean).join("\n");
}

/**
 * Firstmate agent selection: original Professional Agent by default;
 * specialized fix role when problem type benefits (never the Reviewer).
 */
export function selectFixAgent(input: FixAgentSelectionInput): SubtaskAgentInstance {
  const { spec, originalAgent, fixSpecialists } = input;
  const original = originalAgentToInstance(originalAgent);

  if (spec.agentPreference === "fix_specialist" && fixSpecialists?.length) {
    const hint = spec.preferredRoleHint?.toLowerCase();
    const hit = hint
      ? fixSpecialists.find((agent) => {
          const blob = [
            agent.name,
            agent.roleId,
            ...(agent.skills ?? []),
            ...(agent.tools ?? [])
          ].join(" ").toLowerCase();
          return blob.includes(hint) || blob.includes("fix") || blob.includes("修复");
        })
      : fixSpecialists[0];
    if (hit && !isReviewerAgent(hit)) {
      return {
        ...hit,
        source: hit.source ?? "role"
      };
    }
  }

  if (original && !isReviewerAgent(original)) {
    return original;
  }

  return {
    name: "原专业代理（修复）",
    source: "unassigned",
    tools: ["filesystem", "shell"],
    skills: ["implement"]
  };
}

export function isReviewerAgent(agent: SubtaskAgentInstance | RunExecutionState["selectedAgent"] | undefined): boolean {
  if (!agent) return false;
  const name = ("name" in agent ? agent.name : "") ?? "";
  const roleId = ("roleId" in agent ? agent.roleId : undefined) ?? "";
  const skills = ("skills" in agent && Array.isArray(agent.skills) ? agent.skills : []) as string[];
  const blob = `${name} ${roleId} ${skills.join(" ")}`.toLowerCase();
  return /reviewer|no-mistakes|独立审查|code-review/.test(blob) && !/fix|implement|实现|修复/.test(blob);
}

/**
 * Worktree apply / formal completion gate for the remediation loop:
 * independent review must have passed AND the user must have accepted.
 */
export function canApplyWorktreeAfterReview(
  run: Pick<Run, "status" | "reviews" | "reviewLoop">
): WorktreeApplyReviewGate {
  const userAccepted = run.reviewLoop?.userAccepted === true;
  const gating = resolveIndependentReview(run);
  const reviewPassed = Boolean(gating && gating.status === "passed" && gating.kind === "independent");

  if (!reviewPassed) {
    return {
      ok: false,
      reason: "独立审查未通过或尚无独立审查结论；Worktree 不得应用，Todo 不得完成。",
      reviewPassed: false,
      userAccepted
    };
  }
  if (!userAccepted) {
    return {
      ok: false,
      reason: "用户尚未最终验收；Worktree 不得应用，Todo 不得完成。",
      reviewPassed: true,
      userAccepted: false
    };
  }
  return { ok: true, reviewPassed: true, userAccepted: true };
}

/** True when auto-fix budget is exhausted and re-review still requests changes. */
export function shouldPauseForUserAfterFailedRemediation(input: {
  conclusion: "passed" | "changes_requested";
  autoFixCyclesUsed: number;
  maxAutoFixCycles: number;
  /** When false, caller is only inspecting — do not auto-pause. */
  autoDispatchEnabled?: boolean;
}): boolean {
  if (input.conclusion !== "changes_requested") return false;
  if (input.autoDispatchEnabled === false) return false;
  const max = Math.max(1, input.maxAutoFixCycles);
  return input.autoFixCyclesUsed >= max;
}

export function classifyFinding(finding: ReviewFinding): ReviewProblemType {
  const blob = `${finding.criterion} ${finding.evidence} ${finding.fixScope ?? ""}`;
  if (/验证|verify|test|exitCode|伪成功/i.test(blob)) return "verification";
  if (/Artifact|成果|产出|artifact/i.test(blob)) return "artifact";
  if (/越界|边界|allowedScope|范围|out[- ]of[- ]scope/i.test(blob)) return "scope";
  if (/禁止|危险|未获批准|prohibition/i.test(blob)) return "prohibition";
  if (/用户验收|acceptance/i.test(blob)) return "acceptance";
  return "other";
}

function preferAgentForProblem(type: ReviewProblemType, severity: ReviewSeverity): FixAgentPreference {
  if (type === "scope" || type === "prohibition") return "fix_specialist";
  if (severity === "critical" && type !== "artifact") return "fix_specialist";
  return "original";
}

function capabilitiesForProblem(type: ReviewProblemType): string[] {
  switch (type) {
    case "verification":
      return ["shell", "tests", "workspace"];
    case "artifact":
      return ["filesystem", "workspace"];
    case "scope":
    case "prohibition":
      return ["filesystem", "workspace", "shell"];
    default:
      return ["filesystem", "workspace", "shell", "tests"];
  }
}

function specsToExplicit(specs: ReviewFixSubtaskSpec[], cycle: number): ExplicitSubtaskDef[] {
  const fixSpecs = specs.filter((s) => s.sourceFindingIndex >= 0);
  const verify = specs.find((s) => s.sourceFindingIndex < 0);
  const fixIds = fixSpecs.map((s) => s.id);

  const explicit: ExplicitSubtaskDef[] = fixSpecs.map((spec) => ({
    id: spec.id,
    title: spec.title,
    description: spec.description,
    requiredCapabilities: spec.requiredCapabilities,
    inputs: uniqueStrings([
      `review:${spec.sourceReviewId}`,
      ...spec.evidence.slice(0, 3).map((e) => `evidence:${truncate(e, 120)}`),
      ...spec.allowedScope.map((s) => `scope:${s}`)
    ]),
    outputs: [`修复结论：${spec.fixScope}`],
    // Parallel roots — each confirmed issue is independent unless sequential dependency is required.
    dependsOn: [],
    permissions: remediationPermissions(spec),
    acceptanceCriteria: spec.acceptanceCriteria,
    accessMode: "write",
    independentWorktree: false,
    routingInstanceId: spec.id,
    origin: "review_remediation",
    sourceReviewId: spec.sourceReviewId,
    findingSeverity: spec.severity
  }));

  void cycle;

  if (verify) {
    explicit.push({
      id: verify.id,
      title: verify.title,
      description: verify.description,
      requiredCapabilities: verify.requiredCapabilities,
      inputs: uniqueStrings([
        `review:${verify.sourceReviewId}`,
        ...fixIds.map((id) => `depends-fix:${id}`)
      ]),
      outputs: ["结构化验证结果"],
      dependsOn: [...fixIds],
      permissions: {
        workspace: "project_only",
        network: false,
        shell: true,
        externalSend: false
      },
      acceptanceCriteria: verify.acceptanceCriteria,
      accessMode: "write",
      independentWorktree: false,
      routingInstanceId: verify.id,
      origin: "review_remediation",
      sourceReviewId: verify.sourceReviewId,
      findingSeverity: verify.severity
    });
  }

  return explicit;
}

function remediationPermissions(spec: ReviewFixSubtaskSpec): Partial<SubtaskPermissions> {
  const needsShell = spec.problemType === "verification"
    || spec.requiredCapabilities.includes("shell")
    || spec.requiredCapabilities.includes("tests");
  return {
    workspace: "project_only",
    network: false,
    shell: needsShell,
    externalSend: false
  };
}

function originalAgentToInstance(
  agent: RunExecutionState["selectedAgent"] | undefined
): SubtaskAgentInstance | undefined {
  if (!agent) return undefined;
  return {
    name: agent.name,
    harness: agent.harness === "codex-cli" ? "codex-cli" : "api",
    modelId: agent.modelId,
    connectionId: agent.connectionId,
    skills: agent.skills ? [...agent.skills] : undefined,
    tools: agent.tools ? [...agent.tools] : undefined,
    roleId: agent.roleId,
    source: agent.source === "temporary" ? "temporary" : agent.source === "role" ? "role" : "user_specified"
  };
}

function resolveIndependentReview(run: Pick<Run, "reviews" | "reviewLoop">): ReviewIndex | undefined {
  const latestId = run.reviewLoop?.latestReviewId;
  if (!latestId) return undefined;
  const review = run.reviews.find((entry) => entry.id === latestId);
  if (!review || review.kind !== "independent" || review.role !== "reviewer") return undefined;
  if (!Array.isArray(review.findings) || !Array.isArray(review.evidence)) return undefined;
  return review;
}

function normalizeSeverity(value: unknown): ReviewSeverity {
  if (typeof value === "string" && (SEVERITY_ORDER as string[]).includes(value)) {
    return value as ReviewSeverity;
  }
  return "medium";
}

function highestSeverity(values: ReviewSeverity[]): ReviewSeverity {
  return values.reduce<ReviewSeverity>(
    (current, value) => (SEVERITY_ORDER.indexOf(value) > SEVERITY_ORDER.indexOf(current) ? value : current),
    "none"
  );
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

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}
