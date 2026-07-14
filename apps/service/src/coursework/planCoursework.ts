/**
 * Secondmate-style coursework plan: break the assignment into dependent
 * research, development, testing, materials, and documentation subtasks
 * (ExplicitSubtaskDef — Task 21). Supports minimal-modify scope for
 * existing projects.
 */

import type { ModelProvider } from "../model/types.js";
import type { ExplicitSubtaskDef, TaskType } from "../subtasks/subtaskTypes.js";
import type {
  BuiltPlan,
  CourseworkSubtaskKind,
  PlanModelOutput,
  ProjectScopePolicy,
  SpecExtractResult
} from "./courseworkTypes.js";

export class PlanCourseworkError extends Error {
  constructor(
    message: string,
    readonly code: "no_spec" | "model_failed" | "invalid_output" | "not_awaiting"
  ) {
    super(message);
    this.name = "PlanCourseworkError";
  }
}

export interface PlanCourseworkInput {
  title: string;
  goal: string;
  spec: SpecExtractResult;
  existingProjectNotes?: string;
  scopeHints?: Partial<ProjectScopePolicy>;
  model?: ModelProvider;
  connectionId?: string;
  modelId?: string;
  now?: () => Date;
  signal?: AbortSignal;
}

const PLAN_SYSTEM = `You are Secondmate planning a coursework delivery DAG.
Return JSON: {
  subtasks: [{ id?, title, description?, kind: research|development|testing|materials|documentation, dependsOn?, acceptanceCriteria?, accessMode? }],
  scopePolicy?: { mode: greenfield|minimal_modify, retainedFeatures?, allowedModificationScope?, forbiddenPaths? }
}
Include research → development → testing → materials → documentation with real dependsOn.
For existing projects prefer minimal_modify and list retained features.
Never invent scoring points; bind acceptance to extracted requirements.`;

/** Deterministic plan from extracted spec (no model required). */
export function buildHeuristicPlan(input: {
  title: string;
  goal: string;
  spec: SpecExtractResult;
  existingProjectNotes?: string;
  scopeHints?: Partial<ProjectScopePolicy>;
}): BuiltPlan {
  const { spec } = input;
  const hasExisting = Boolean(input.existingProjectNotes?.trim());
  const scopePolicy = buildScopePolicy(hasExisting, input.scopeHints, input.existingProjectNotes);

  const reqSummary = spec.functionalRequirements.map((r) => r.text).slice(0, 6);
  const scoreTitles = spec.scoringPoints.map((s) => s.title);
  const delivery = spec.deliveryFormat.formats;

  const researchId = "cw-research";
  const developId = "cw-develop";
  const testId = "cw-test";
  const materialsId = "cw-materials";
  const docsId = "cw-docs";

  const subtasks: ExplicitSubtaskDef[] = [
    {
      id: researchId,
      title: "调研：背景、技术方案与评分点对齐",
      description: `Research stack options and map scoring points for: ${input.title}`,
      requiredCapabilities: ["research", "analysis"],
      inputs: ["assignment_brief", "scoring_points"],
      outputs: ["research_notes", "tech_choice"],
      dependsOn: [],
      permissions: { workspace: "read_only", network: true, shell: false, externalSend: false },
      acceptanceCriteria: [
        "Evidence-backed tech choice recorded",
        ...scoreTitles.slice(0, 3).map((t) => `Scoring point understood: ${t}`)
      ],
      accessMode: "read_only"
    },
    {
      id: developId,
      title: hasExisting
        ? "开发：按最小修改原则实现评分点功能"
        : "开发：实现功能要求与评分点",
      description: [
        input.goal,
        scopePolicy.mode === "minimal_modify"
          ? `Retain: ${scopePolicy.retainedFeatures.join("; ") || "(list from project)"}`
          : "",
        `Allowed scope: ${scopePolicy.allowedModificationScope.join("; ") || "project workspace"}`
      ]
        .filter(Boolean)
        .join("\n"),
      requiredCapabilities: ["implementation", "coding"],
      inputs: ["tech_choice", "functional_requirements"],
      outputs: ["source_changes", "runnable_app"],
      dependsOn: [researchId],
      permissions: { workspace: "project_only", network: false, shell: true, externalSend: false },
      acceptanceCriteria: [
        ...reqSummary.slice(0, 5),
        "No fake/shell UI claiming unfinished features",
        ...(scopePolicy.mode === "minimal_modify"
          ? ["Retained features still work", "Changes stay within allowed scope"]
          : [])
      ],
      accessMode: "write",
      independentWorktree: true
    },
    {
      id: testId,
      title: "测试：运行验证并记录真实结果",
      description: "Execute project-aware verification; record exit codes and test logs.",
      requiredCapabilities: ["testing", "verification"],
      inputs: ["runnable_app", "verification_plan"],
      outputs: ["test_records", "verification_evidence"],
      dependsOn: [developId],
      permissions: { workspace: "project_only", network: false, shell: true, externalSend: false },
      acceptanceCriteria: [
        "Automated or manual verification evidence with structured exit codes",
        "No keyword-only pass claims",
        ...scoreTitles
          .filter((_, i) => i < 3)
          .map((t) => `Evidence for scoring: ${t}`)
      ],
      accessMode: "write"
    },
    {
      id: materialsId,
      title: "材料：截图与演示证据",
      description: "Capture real screenshots/demo evidence bound to scoring points.",
      requiredCapabilities: ["documentation"],
      inputs: ["runnable_app", "test_records"],
      outputs: ["screenshots", "demo_notes"],
      dependsOn: [testId],
      permissions: { workspace: "project_only", network: false, shell: false, externalSend: false },
      acceptanceCriteria: [
        "Screenshots from actual running UI (not mock placeholders)",
        delivery.includes("screenshots") ? "Screenshot pack ready for delivery" : "Demo evidence filed"
      ],
      accessMode: "write"
    },
    {
      id: docsId,
      title: "文档：运行说明、依赖与课程报告",
      description: "Write README/run instructions, dependency notes, and coursework report.",
      requiredCapabilities: ["writing", "documentation"],
      inputs: ["research_notes", "test_records", "screenshots", "source_changes"],
      outputs: ["readme", "report", "dependency_notes"],
      dependsOn: [materialsId],
      permissions: { workspace: "project_only", network: false, shell: false, externalSend: false },
      acceptanceCriteria: [
        "Runnable instructions match actual project",
        "Report claims only what code/tests/screenshots support",
        ...delivery
          .filter((f) => f === "report" || f === "report-pdf" || f === "readme")
          .map((f) => `Deliverable present: ${f}`)
      ],
      accessMode: "write"
    }
  ];

  // If prohibitions exist, append reminder to development acceptance
  if (spec.prohibitions.length > 0) {
    const dev = subtasks.find((s) => s.id === developId)!;
    dev.acceptanceCriteria = [
      ...(dev.acceptanceCriteria ?? []),
      ...spec.prohibitions.slice(0, 5).map((p) => `Respect prohibition: ${p.text}`)
    ];
  }

  return {
    subtasks,
    scopePolicy,
    taskType: "implementation" as TaskType
  };
}

export async function planCoursework(input: PlanCourseworkInput): Promise<BuiltPlan> {
  if (!input.spec) throw new PlanCourseworkError("Spec extract required before planning.", "no_spec");
  const base = buildHeuristicPlan(input);
  if (!input.model) return base;

  try {
    const response = await input.model.complete({
      connectionId: input.connectionId ?? "fake-connection",
      modelId: input.modelId ?? "fake-model",
      messages: [
        { role: "system", content: PLAN_SYSTEM },
        { role: "user", content: buildPlanContextPack(input) }
      ],
      signal: input.signal
    });
    const parsed = parsePlanModelOutput(response.content);
    return mergePlan(base, parsed);
  } catch {
    return base;
  }
}

export function buildPlanContextPack(input: PlanCourseworkInput): string {
  const { spec } = input;
  return [
    `# Coursework: ${input.title}`,
    `Goal: ${input.goal}`,
    "",
    "## Functional requirements",
    ...spec.functionalRequirements.map((r) => `- ${r.id}: ${r.text}`),
    "",
    "## Scoring points",
    ...spec.scoringPoints.map(
      (s) => `- ${s.id}: ${s.title}${s.maxScore != null ? ` (${s.maxScore})` : ""} — ${s.description}`
    ),
    "",
    "## Prohibitions",
    ...(spec.prohibitions.length
      ? spec.prohibitions.map((p) => `- ${p.text}`)
      : ["_none_"]),
    "",
    "## Delivery formats",
    spec.deliveryFormat.formats.join(", ") || "_unspecified_",
    spec.deliveryFormat.notes ?? "",
    "",
    "## Existing project",
    input.existingProjectNotes?.trim() || "_greenfield_",
    "",
    "Produce a dependent subtask DAG (research, development, testing, materials, documentation)."
  ].join("\n");
}

export function parsePlanModelOutput(content: string): PlanModelOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonObject(content.trim()));
  } catch {
    throw new PlanCourseworkError("Plan model returned non-JSON.", "invalid_output");
  }
  if (!raw || typeof raw !== "object") {
    throw new PlanCourseworkError("Plan model output is not an object.", "invalid_output");
  }
  return raw as PlanModelOutput;
}

export function mergePlan(base: BuiltPlan, model: PlanModelOutput): BuiltPlan {
  const scopePolicy: ProjectScopePolicy = {
    mode: model.scopePolicy?.mode ?? base.scopePolicy.mode,
    retainedFeatures:
      model.scopePolicy?.retainedFeatures?.length
        ? model.scopePolicy.retainedFeatures.map((s) => s.trim()).filter(Boolean)
        : base.scopePolicy.retainedFeatures,
    allowedModificationScope:
      model.scopePolicy?.allowedModificationScope?.length
        ? model.scopePolicy.allowedModificationScope.map((s) => s.trim()).filter(Boolean)
        : base.scopePolicy.allowedModificationScope,
    forbiddenPaths:
      model.scopePolicy?.forbiddenPaths?.length
        ? model.scopePolicy.forbiddenPaths.map((s) => s.trim()).filter(Boolean)
        : base.scopePolicy.forbiddenPaths
  };

  if (!model.subtasks || model.subtasks.length === 0) {
    return { ...base, scopePolicy };
  }

  const idOf = (s: NonNullable<PlanModelOutput["subtasks"]>[number], i: number) =>
    (s.id?.trim() || `cw-${s.kind ?? "step"}-${i + 1}`).replace(/\s+/g, "-");

  const ids = model.subtasks.map((s, i) => idOf(s, i));
  const subtasks: ExplicitSubtaskDef[] = model.subtasks.map((s, i) => {
    const kind = (s.kind ?? inferKind(s.title)) as CourseworkSubtaskKind;
    const accessMode =
      s.accessMode ?? (kind === "research" ? "read_only" : "write");
    const dependsOn = (s.dependsOn ?? [])
      .map((d) => {
        // Allow index or id references
        if (/^\d+$/.test(d)) return ids[Number(d)] ?? d;
        return d;
      })
      .filter((d) => d !== ids[i]);

    return {
      id: ids[i],
      title: s.title.trim(),
      description: s.description?.trim(),
      requiredCapabilities: capabilitiesForKind(kind),
      inputs: [],
      outputs: outputsForKind(kind),
      dependsOn,
      permissions:
        accessMode === "read_only"
          ? { workspace: "read_only", network: kind === "research", shell: false, externalSend: false }
          : { workspace: "project_only", network: false, shell: kind === "development" || kind === "testing", externalSend: false },
      acceptanceCriteria: s.acceptanceCriteria?.length
        ? s.acceptanceCriteria
        : base.subtasks[i]?.acceptanceCriteria ?? [`Complete: ${s.title}`],
      accessMode,
      independentWorktree: kind === "development"
    };
  });

  // Ensure dependency chain is acyclic-enough: if model omitted deps, apply serial chain
  const anyDeps = subtasks.some((s) => (s.dependsOn?.length ?? 0) > 0);
  if (!anyDeps && subtasks.length > 1) {
    for (let i = 1; i < subtasks.length; i++) {
      subtasks[i]!.dependsOn = [subtasks[i - 1]!.id!];
    }
  }

  return { subtasks, scopePolicy, taskType: base.taskType };
}

export function buildScopePolicy(
  hasExisting: boolean,
  hints?: Partial<ProjectScopePolicy>,
  existingProjectNotes?: string
): ProjectScopePolicy {
  if (hints?.mode === "greenfield" || (!hasExisting && hints?.mode !== "minimal_modify")) {
    return {
      mode: hints?.mode ?? "greenfield",
      retainedFeatures: hints?.retainedFeatures ?? [],
      allowedModificationScope: hints?.allowedModificationScope ?? ["**/*"],
      forbiddenPaths: hints?.forbiddenPaths ?? []
    };
  }

  const retained =
    hints?.retainedFeatures?.length
      ? hints.retainedFeatures
      : extractRetainedFromNotes(existingProjectNotes);

  const allowed =
    hints?.allowedModificationScope?.length
      ? hints.allowedModificationScope
      : extractAllowedFromNotes(existingProjectNotes);

  return {
    mode: "minimal_modify",
    retainedFeatures: retained,
    allowedModificationScope: allowed.length ? allowed : ["src/**", "tests/**", "README.md"],
    forbiddenPaths: hints?.forbiddenPaths ?? []
  };
}

function extractRetainedFromNotes(notes?: string): string[] {
  if (!notes?.trim()) return [];
  const lines = notes.split(/\r?\n/).map((l) => l.trim());
  const out: string[] = [];
  for (const line of lines) {
    if (/保留|retain|keep|do not (change|modify)|不得修改/i.test(line)) {
      out.push(line.replace(/^[-*•]\s*/, ""));
    }
  }
  return out;
}

function extractAllowedFromNotes(notes?: string): string[] {
  if (!notes?.trim()) return [];
  const lines = notes.split(/\r?\n/).map((l) => l.trim());
  const out: string[] = [];
  for (const line of lines) {
    if (/允许修改|may modify|allowed|可改|修改范围/i.test(line)) {
      out.push(line.replace(/^[-*•]\s*/, ""));
    }
  }
  return out;
}

function inferKind(title: string): CourseworkSubtaskKind {
  if (/调研|研究|research/i.test(title)) return "research";
  if (/测试|验证|test|verif/i.test(title)) return "testing";
  if (/截图|材料|素材|screenshot|material/i.test(title)) return "materials";
  if (/文档|报告|readme|报告|doc|writing|论文/i.test(title)) return "documentation";
  return "development";
}

function capabilitiesForKind(kind: CourseworkSubtaskKind): string[] {
  switch (kind) {
    case "research":
      return ["research", "analysis"];
    case "development":
      return ["implementation", "coding"];
    case "testing":
      return ["testing", "verification"];
    case "materials":
      return ["documentation"];
    case "documentation":
      return ["writing", "documentation"];
  }
}

function outputsForKind(kind: CourseworkSubtaskKind): string[] {
  switch (kind) {
    case "research":
      return ["research_notes"];
    case "development":
      return ["source_changes", "runnable_app"];
    case "testing":
      return ["test_records", "verification_evidence"];
    case "materials":
      return ["screenshots"];
    case "documentation":
      return ["readme", "report"];
  }
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

/** Convert built plan into CreateDagFromPlanInput fields (caller supplies runId). */
export function toCreateDagFields(plan: BuiltPlan): {
  explicitSubtasks: ExplicitSubtaskDef[];
  taskType: TaskType;
  acceptanceCriteria: string[];
  expectedArtifacts: string[];
  allowedScope: string[];
} {
  const acceptanceCriteria = plan.subtasks.flatMap((s) => s.acceptanceCriteria ?? []);
  const expectedArtifacts = plan.subtasks.flatMap((s) => s.outputs ?? []);
  return {
    explicitSubtasks: plan.subtasks,
    taskType: plan.taskType,
    acceptanceCriteria: [...new Set(acceptanceCriteria)],
    expectedArtifacts: [...new Set(expectedArtifacts)],
    allowedScope: plan.scopePolicy.allowedModificationScope
  };
}
