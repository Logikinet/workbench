import type { ModelRuntime } from "../model/modelRuntime.js";
import type { ModelInvokeResult } from "../model/types.js";
import {
  firstmateAssessmentSchema,
  FIRSTMATE_SYSTEM_INSTRUCTION,
  secondmatePlanSchema,
  SECOND_MATE_SYSTEM_INSTRUCTION
} from "./planningSchemas.js";
import {
  selectPlanningContext,
  type PlanningContextInput,
  type PlanningContextUsage,
  type PlanningProjectFacts,
  type RelatedPlanningFile
} from "./planningContext.js";
import {
  defaultVerificationCommands,
  taskTypes,
  type GeneratedPlan,
  type PlanComplexity,
  type PlanningOverrides,
  type TaskAssessment,
  type TaskType
} from "./planningService.js";

// Note: planningService must not re-export this module (ESM cycle).

/** Run-like input for AI planning without depending on RunService mutation APIs. */
export interface RunLikePlanningInput {
  runId?: string;
  todo: { title: string; description?: string };
  /** User messages already on the Run (or free-form instructions). */
  messages?: Array<{ content: string }>;
  project?: PlanningProjectFacts;
  workspaceSummary?: string;
  relatedFiles?: RelatedPlanningFile[];
  overrides?: PlanningOverrides;
  revisionNote?: string;
  maxRelatedFiles?: number;
  maxExcerptChars?: number;
  signal?: AbortSignal;
}

export interface FirstmateModelAssessment {
  taskType: TaskType;
  requiredCapabilities: string[];
  criticalInputs: string[];
  assumptions: string[];
  complexity: PlanComplexity;
  rationale: string;
  usedProjectFacts: string[];
  usedFiles: string[];
  insufficientEvidence: boolean;
  evidenceGaps: string[];
}

export interface SecondmateModelPlan {
  summary: string;
  complexity: PlanComplexity;
  steps: string[];
  dependencies: string[];
  expectedArtifacts: string[];
  allowedScope: string[];
  prohibitions: string[];
  verificationMethods: string[];
  acceptanceCriteria: string[];
  risks: string[];
  verificationCommands: string[][];
}

export interface AiTaskAssessment extends TaskAssessment {
  rationale?: string;
  contextUsage?: PlanningContextUsage;
  evidenceGaps?: string[];
  insufficientEvidence?: boolean;
}

export interface AiGeneratedPlan extends GeneratedPlan {
  dependencies: string[];
  expectedArtifacts: string[];
  allowedScope: string[];
  verificationMethods: string[];
}

export type AiPlanningOutcome =
  | {
      status: "awaiting_approval";
      assessment: AiTaskAssessment;
      plan: AiGeneratedPlan;
      contextUsage: PlanningContextUsage;
      /** Planning never mutates formal files. */
      formalMutations: [];
      /** Planning never runs dangerous commands. */
      dangerousCommands: [];
    }
  | {
      status: "awaiting_input";
      assessment: AiTaskAssessment;
      contextUsage: PlanningContextUsage;
      formalMutations: [];
      dangerousCommands: [];
    }
  | {
      status: "paused";
      reason: string;
      errorKind?: string;
      assessment?: AiTaskAssessment;
      evidenceGaps?: string[];
      contextUsage?: PlanningContextUsage;
      formalMutations: [];
      dangerousCommands: [];
    };

export interface AiPlanningServiceOptions {
  modelRuntime: ModelRuntime;
  /** Role used for Firstmate structured assessment. */
  firstmateRoleId: string;
  /** Role used for Secondmate structured plan generation. */
  secondmateRoleId: string;
}

/**
 * Real AI Firstmate / Secondmate planning kernel.
 * Uses ModelRuntime structured output; never writes formal files or runs dangerous commands.
 * Callers (RunService / HTTP) apply the resulting assessment + plan into Run state after approval gates.
 */
export class AiPlanningService {
  constructor(private readonly options: AiPlanningServiceOptions) {}

  /**
   * Full pipeline: select context → Firstmate assessment → (if ready) Secondmate plan.
   * On model failure or insufficient evidence, returns a clear pause — never fabricates a plan.
   */
  async plan(input: RunLikePlanningInput): Promise<AiPlanningOutcome> {
    const contextInput = toContextInput(input);
    const selected = selectPlanningContext(contextInput);
    const contextUsage = selected.usage;

    const assessmentResult = await this.assessWithFirstmate(input, selected.promptText, contextUsage);
    if (assessmentResult.status !== "ok") {
      return {
        status: "paused",
        reason: assessmentResult.reason,
        errorKind: assessmentResult.errorKind,
        contextUsage,
        formalMutations: [],
        dangerousCommands: []
      };
    }

    let assessment = assessmentResult.assessment;

    // User overrides always win for classification corrections.
    if (input.overrides?.taskType) {
      assessment = {
        ...assessment,
        taskType: input.overrides.taskType,
        requiredCapabilities: input.overrides.requiredCapabilities === undefined
          ? assessment.requiredCapabilities
          : normalizeList(input.overrides.requiredCapabilities)
      };
    } else if (input.overrides?.requiredCapabilities !== undefined) {
      assessment = {
        ...assessment,
        requiredCapabilities: normalizeList(input.overrides.requiredCapabilities)
      };
    }

    if (selected.missingOutcomeDescription && assessment.criticalInputs.length === 0) {
      assessment = {
        ...assessment,
        criticalInputs: ["请说明本次 Run 的预期正式成果或可验证结果。"]
      };
    }

    assessment.contextUsage = mergeUsage(contextUsage, assessment);

    if (assessment.insufficientEvidence) {
      return {
        status: "paused",
        reason: "证据不足，无法生成可信计划。请补充相关文件、项目事实或任务说明。",
        assessment,
        evidenceGaps: assessment.evidenceGaps ?? [],
        contextUsage: assessment.contextUsage,
        formalMutations: [],
        dangerousCommands: []
      };
    }

    if (assessment.criticalInputs.length > 0) {
      return {
        status: "awaiting_input",
        assessment,
        contextUsage: assessment.contextUsage,
        formalMutations: [],
        dangerousCommands: []
      };
    }

    const planResult = await this.generateWithSecondmate(input, assessment, selected.promptText);
    if (planResult.status !== "ok") {
      return {
        status: "paused",
        reason: planResult.reason,
        errorKind: planResult.errorKind,
        assessment,
        contextUsage: assessment.contextUsage,
        formalMutations: [],
        dangerousCommands: []
      };
    }

    return {
      status: "awaiting_approval",
      assessment,
      plan: planResult.plan,
      contextUsage: assessment.contextUsage,
      formalMutations: [],
      dangerousCommands: []
    };
  }

  /** Firstmate-only assessment entrypoint (Run-like input). */
  async assess(input: RunLikePlanningInput): Promise<AiPlanningOutcome> {
    const contextInput = toContextInput(input);
    const selected = selectPlanningContext(contextInput);
    const assessmentResult = await this.assessWithFirstmate(input, selected.promptText, selected.usage);
    if (assessmentResult.status !== "ok") {
      return {
        status: "paused",
        reason: assessmentResult.reason,
        errorKind: assessmentResult.errorKind,
        contextUsage: selected.usage,
        formalMutations: [],
        dangerousCommands: []
      };
    }

    let assessment = assessmentResult.assessment;
    if (input.overrides?.taskType) {
      assessment = {
        ...assessment,
        taskType: input.overrides.taskType,
        requiredCapabilities: input.overrides.requiredCapabilities === undefined
          ? assessment.requiredCapabilities
          : normalizeList(input.overrides.requiredCapabilities)
      };
    } else if (input.overrides?.requiredCapabilities !== undefined) {
      assessment = {
        ...assessment,
        requiredCapabilities: normalizeList(input.overrides.requiredCapabilities)
      };
    }

    if (selected.missingOutcomeDescription && assessment.criticalInputs.length === 0) {
      assessment = {
        ...assessment,
        criticalInputs: ["请说明本次 Run 的预期正式成果或可验证结果。"]
      };
    }

    assessment.contextUsage = mergeUsage(selected.usage, assessment);

    if (assessment.insufficientEvidence) {
      return {
        status: "paused",
        reason: "证据不足，无法完成任务识别。请补充相关文件、项目事实或任务说明。",
        assessment,
        evidenceGaps: assessment.evidenceGaps ?? [],
        contextUsage: assessment.contextUsage,
        formalMutations: [],
        dangerousCommands: []
      };
    }

    if (assessment.criticalInputs.length > 0) {
      return {
        status: "awaiting_input",
        assessment,
        contextUsage: assessment.contextUsage,
        formalMutations: [],
        dangerousCommands: []
      };
    }

    // Assessment-only success still does not invent a plan.
    return {
      status: "paused",
      reason: "Firstmate 识别完成；尚未调用 Secondmate 生成计划。",
      assessment,
      contextUsage: assessment.contextUsage,
      formalMutations: [],
      dangerousCommands: []
    };
  }

  private async assessWithFirstmate(
    input: RunLikePlanningInput,
    promptText: string,
    baseUsage: PlanningContextUsage
  ): Promise<
    | { status: "ok"; assessment: AiTaskAssessment }
    | { status: "error"; reason: string; errorKind?: string }
  > {
    const result = await this.options.modelRuntime.invoke({
      roleId: this.options.firstmateRoleId,
      runId: input.runId,
      signal: input.signal,
      overrideSystem: FIRSTMATE_SYSTEM_INSTRUCTION,
      schema: firstmateAssessmentSchema,
      messages: [
        {
          role: "user",
          content: [
            "Assess this Run for Firstmate planning. Return structured JSON only.",
            "Do not modify files. Do not invent evidence that is not present.",
            promptText
          ].join("\n\n")
        }
      ]
    });

    if (!result.ok) {
      return {
        status: "error",
        reason: `Firstmate 规划失败：${result.error.message}`,
        errorKind: result.error.kind
      };
    }

    const parsed = result.parsed as FirstmateModelAssessment | undefined;
    if (!parsed || typeof parsed !== "object") {
      return { status: "error", reason: "Firstmate 返回了无法解析的结构化结果。", errorKind: "format_error" };
    }

    if (!taskTypes.includes(parsed.taskType)) {
      return { status: "error", reason: "Firstmate 返回了无效的任务类型。", errorKind: "format_error" };
    }

    const assessment: AiTaskAssessment = {
      taskType: parsed.taskType,
      requiredCapabilities: normalizeList(parsed.requiredCapabilities),
      criticalInputs: normalizeList(parsed.criticalInputs),
      assumptions: normalizeList(parsed.assumptions),
      complexity: normalizeComplexity(parsed.complexity),
      rationale: typeof parsed.rationale === "string" ? parsed.rationale.trim() : undefined,
      insufficientEvidence: Boolean(parsed.insufficientEvidence),
      evidenceGaps: normalizeList(parsed.evidenceGaps),
      contextUsage: {
        ...baseUsage,
        projectFacts: uniqueStrings([
          ...baseUsage.projectFacts,
          ...normalizeList(parsed.usedProjectFacts)
        ]),
        files: uniqueStrings([
          ...baseUsage.files.filter((path) => normalizeList(parsed.usedFiles).includes(path) || normalizeList(parsed.usedFiles).length === 0),
          ...normalizeList(parsed.usedFiles)
        ]),
        assumptions: normalizeList(parsed.assumptions)
      }
    };

    if (assessment.requiredCapabilities.length === 0) {
      assessment.requiredCapabilities = ["workspace"];
    }

    return { status: "ok", assessment };
  }

  private async generateWithSecondmate(
    input: RunLikePlanningInput,
    assessment: AiTaskAssessment,
    promptText: string
  ): Promise<
    | { status: "ok"; plan: AiGeneratedPlan }
    | { status: "error"; reason: string; errorKind?: string }
  > {
    const result = await this.options.modelRuntime.invoke({
      roleId: this.options.secondmateRoleId,
      runId: input.runId,
      signal: input.signal,
      overrideSystem: SECOND_MATE_SYSTEM_INSTRUCTION,
      schema: secondmatePlanSchema,
      messages: [
        {
          role: "user",
          content: [
            "Generate a task-specific Secondmate plan for the following assessment and context.",
            "Do not modify files or run commands. Planning only.",
            `Assessment JSON:\n${JSON.stringify({
              taskType: assessment.taskType,
              requiredCapabilities: assessment.requiredCapabilities,
              assumptions: assessment.assumptions,
              complexity: assessment.complexity,
              rationale: assessment.rationale,
              contextUsage: assessment.contextUsage
            }, null, 2)}`,
            promptText,
            input.revisionNote?.trim()
              ? `User revision feedback (must substantially change the plan):\n${input.revisionNote.trim()}`
              : ""
          ].filter(Boolean).join("\n\n")
        }
      ]
    });

    if (!result.ok) {
      return {
        status: "error",
        reason: `Secondmate 规划失败：${result.error.message}`,
        errorKind: result.error.kind
      };
    }

    const parsed = result.parsed as SecondmateModelPlan | undefined;
    if (!parsed || typeof parsed !== "object") {
      return { status: "error", reason: "Secondmate 返回了无法解析的结构化结果。", errorKind: "format_error" };
    }

    const steps = normalizeList(parsed.steps);
    const acceptanceCriteria = normalizeList(parsed.acceptanceCriteria);
    const prohibitions = ensureCoreProhibitions(normalizeList(parsed.prohibitions));

    if (steps.length === 0 || acceptanceCriteria.length === 0) {
      return {
        status: "error",
        reason: "Secondmate 计划缺少步骤或验收标准，已暂停且未伪造计划。",
        errorKind: "format_error"
      };
    }

    const complexity = normalizeComplexity(parsed.complexity ?? assessment.complexity);
    const verificationCommands = normalizeCommandLists(parsed.verificationCommands);
    const plan: AiGeneratedPlan = {
      summary: (parsed.summary?.trim() || `Secondmate ${assessment.taskType} plan`).slice(0, 500),
      complexity,
      steps,
      acceptanceCriteria,
      risks: normalizeList(parsed.risks),
      prohibitions,
      generatedBy: "secondmate",
      revisionNote: input.revisionNote?.trim() || undefined,
      verificationCommands: verificationCommands.length > 0
        ? verificationCommands
        : defaultVerificationCommands(assessment.taskType),
      dependencies: normalizeList(parsed.dependencies),
      expectedArtifacts: normalizeList(parsed.expectedArtifacts),
      allowedScope: normalizeList(parsed.allowedScope),
      verificationMethods: normalizeList(parsed.verificationMethods)
    };

    return { status: "ok", plan };
  }
}

/** Map an AI outcome into Run planning fields without touching disk. */
export function toPlanningStateFields(outcome: AiPlanningOutcome): {
  approvalStatus: "awaiting_input" | "awaiting_approval" | "paused";
  assessment?: AiTaskAssessment;
  plan?: AiGeneratedPlan;
  verificationCommands?: string[][];
  pauseReason?: string;
  formalMutations: [];
  dangerousCommands: [];
} {
  if (outcome.status === "awaiting_approval") {
    return {
      approvalStatus: "awaiting_approval",
      assessment: outcome.assessment,
      plan: outcome.plan,
      verificationCommands: outcome.plan.verificationCommands,
      formalMutations: [],
      dangerousCommands: []
    };
  }
  if (outcome.status === "awaiting_input") {
    return {
      approvalStatus: "awaiting_input",
      assessment: outcome.assessment,
      verificationCommands: defaultVerificationCommands(outcome.assessment.taskType),
      formalMutations: [],
      dangerousCommands: []
    };
  }
  return {
    approvalStatus: "paused",
    assessment: outcome.assessment,
    pauseReason: outcome.reason,
    formalMutations: [],
    dangerousCommands: []
  };
}

export function isAiPlanningSuccess(outcome: AiPlanningOutcome): outcome is Extract<AiPlanningOutcome, { status: "awaiting_approval" }> {
  return outcome.status === "awaiting_approval";
}

function toContextInput(input: RunLikePlanningInput): PlanningContextInput {
  const instructions = (input.messages ?? [])
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n");
  return {
    todo: input.todo,
    instructions: instructions || undefined,
    project: input.project,
    workspaceSummary: input.workspaceSummary,
    relatedFiles: input.relatedFiles,
    revisionNote: input.revisionNote,
    maxRelatedFiles: input.maxRelatedFiles,
    maxExcerptChars: input.maxExcerptChars
  };
}

function mergeUsage(base: PlanningContextUsage, assessment: AiTaskAssessment): PlanningContextUsage {
  return {
    projectFacts: uniqueStrings([
      ...base.projectFacts,
      ...(assessment.contextUsage?.projectFacts ?? [])
    ]),
    files: uniqueStrings([
      ...base.files,
      ...(assessment.contextUsage?.files ?? [])
    ]),
    assumptions: uniqueStrings([
      ...base.assumptions,
      ...assessment.assumptions,
      ...(assessment.contextUsage?.assumptions ?? [])
    ]),
    workspaceSummary: assessment.contextUsage?.workspaceSummary ?? base.workspaceSummary,
    instructionSources: uniqueStrings([
      ...base.instructionSources,
      ...(assessment.contextUsage?.instructionSources ?? [])
    ]),
    omittedBecauseUnnecessary: uniqueStrings([
      ...base.omittedBecauseUnnecessary,
      ...(assessment.contextUsage?.omittedBecauseUnnecessary ?? [])
    ])
  };
}

function ensureCoreProhibitions(items: string[]): string[] {
  const required = [
    "不得在计划获批前创建、修改或登记正式成果文件。",
    "不得在计划获批前执行删除、安装、外发或其他危险操作。",
    "Firstmate 仅负责识别、编排和确认，不得直接生成正式 Artifact。"
  ];
  return uniqueStrings([...items, ...required]);
}

function normalizeComplexity(value: unknown): PlanComplexity {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return uniqueStrings(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean));
}

function normalizeCommandLists(values: unknown): string[][] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((entry): entry is unknown[] => Array.isArray(entry))
    .map((entry) => entry.filter((part): part is string => typeof part === "string").map((part) => part.trim()).filter(Boolean))
    .filter((entry) => entry.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Test helper: inspect whether a model result indicates a planning-blocking failure. */
export function planningBlockedByModel(result: ModelInvokeResult): boolean {
  return !result.ok;
}
