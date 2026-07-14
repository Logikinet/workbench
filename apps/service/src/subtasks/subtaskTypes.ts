/**
 * Subtask DAG types (Task 21).
 * Approved plan steps become trackable subtasks with dependencies, access mode,
 * agent assignment, and durable status for Firstmate continuous scheduling.
 */

export type SubtaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "paused";

export type SubtaskAccessMode = "read_only" | "write";

export type DagStatus =
  | "idle"
  | "scheduling"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "awaiting_replan";

export type PlanComplexity = "low" | "medium" | "high";

export type TaskType =
  | "implementation"
  | "bug_fix"
  | "research"
  | "writing"
  | "analysis"
  | "automation"
  | "other";

export interface SubtaskPermissions {
  workspace: "project_only" | "read_only";
  network: boolean;
  shell: boolean;
  externalSend: boolean;
}

export interface SubtaskAgentInstance {
  roleId?: string;
  temporaryRoleId?: string;
  name: string;
  harness?: "api" | "codex-cli";
  modelId?: string;
  connectionId?: string;
  skills?: string[];
  tools?: string[];
  source?: "role" | "temporary" | "user_specified" | "user_override" | "unassigned";
}

export interface Subtask {
  id: string;
  runId: string;
  planVersion: number;
  stepIndex: number;
  title: string;
  description?: string;
  /** Capabilities expected of the responsible professional agent. */
  requiredCapabilities: string[];
  inputs: string[];
  outputs: string[];
  /** Upstream subtask ids that must complete before this one can run. */
  dependsOn: string[];
  permissions: SubtaskPermissions;
  acceptanceCriteria: string[];
  accessMode: SubtaskAccessMode;
  /**
   * When true, a write-mode subtask may run in parallel with other independent
   * worktree write tasks (still max parallel write group size limited).
   */
  independentWorktree: boolean;
  status: SubtaskStatus;
  agentInstance?: SubtaskAgentInstance;
  startedAt?: string;
  completedAt?: string;
  artifacts: string[];
  error?: string;
  blockedReason?: string;
  correctionNotes: string[];
  routingInstanceId?: string;
  /** plan = approved plan step; review_remediation = Task 29 fix subtask from review findings. */
  origin?: "plan" | "review_remediation";
  /** Independent review id when origin is review_remediation. */
  sourceReviewId?: string;
  /** Finding severity when origin is review_remediation. */
  findingSeverity?: "none" | "low" | "medium" | "high" | "critical";
}

export interface DagCheckpoint {
  savedAt: string;
  frontier: string[];
  subtaskStatuses: Record<string, SubtaskStatus>;
  completedIds: string[];
  runningIds: string[];
  note?: string;
}

export interface SubtaskDag {
  id: string;
  runId: string;
  planVersion: number;
  taskType?: TaskType;
  complexity?: PlanComplexity;
  createdAt: string;
  updatedAt: string;
  status: DagStatus;
  subtasks: Subtask[];
  /** When true, Firstmate keeps scheduling frontier tasks without manual continue. */
  autoSchedule: boolean;
  /** Always 1 — serial write unless independent worktree. */
  maxParallelWrite: number;
  /** Controlled parallel for read-only / independent worktree tasks (1–3). */
  maxParallelRead: number;
  maxParallelIndependentWrite: number;
  frontier: string[];
  lastScheduleAt?: string;
  lastError?: string;
  correctionNote?: string;
  needsAskReplan: boolean;
  replanFeedback?: string;
  checkpoint?: DagCheckpoint;
  planApproved: boolean;
}

export interface ExplicitSubtaskDef {
  id?: string;
  title: string;
  description?: string;
  requiredCapabilities?: string[];
  inputs?: string[];
  outputs?: string[];
  /** Local refs: step indices (0-based) or sibling explicit ids. */
  dependsOn?: string[];
  permissions?: Partial<SubtaskPermissions>;
  acceptanceCriteria?: string[];
  accessMode?: SubtaskAccessMode;
  independentWorktree?: boolean;
  routingInstanceId?: string;
  origin?: "plan" | "review_remediation";
  sourceReviewId?: string;
  findingSeverity?: "none" | "low" | "medium" | "high" | "critical";
}

export interface RoutingSelectionHint {
  instanceId: string;
  roleId?: string;
  temporaryRoleId?: string;
  name: string;
  harness?: "api" | "codex-cli";
  modelId?: string;
  connectionId?: string;
  skills?: string[];
  tools?: string[];
  source?: SubtaskAgentInstance["source"];
  permissions?: SubtaskPermissions;
}

export interface CreateDagFromPlanInput {
  runId: string;
  planVersion: number;
  /** Plan steps (required unless explicitSubtasks is provided). */
  steps?: string[];
  acceptanceCriteria?: string[];
  requiredCapabilities?: string[];
  taskType?: TaskType;
  complexity?: PlanComplexity;
  expectedArtifacts?: string[];
  allowedScope?: string[];
  explicitSubtasks?: ExplicitSubtaskDef[];
  /** Default true after plan approval. */
  autoSchedule?: boolean;
  planApproved?: boolean;
  routingSelections?: RoutingSelectionHint[];
  maxParallelRead?: number;
  maxParallelIndependentWrite?: number;
}

/** Append constrained review-fix subtasks (Task 29 remediation loop). */
export interface AppendRemediationSubtasksInput {
  runId: string;
  reviewId: string;
  /** Plan version for new DAG when none exists; ignored when appending to existing. */
  planVersion?: number;
  cycle?: number;
  explicitSubtasks: ExplicitSubtaskDef[];
  /** Optional agent assignments keyed by subtask id / routingInstanceId. */
  agentAssignments?: Array<{
    subtaskId: string;
    agent: SubtaskAgentInstance;
  }>;
  /**
   * When true (default), cancel incomplete prior review_remediation subtasks
   * so only the current remediation cycle remains active.
   */
  cancelPriorRemediation?: boolean;
  autoSchedule?: boolean;
}

export interface AppendRemediationResult {
  dag: SubtaskDag;
  createdIds: string[];
  cancelledIds: string[];
  created: boolean;
}

export interface CompleteSubtaskInput {
  artifacts?: string[];
  summary?: string;
}

export interface FailSubtaskInput {
  error: string;
  /** When true, pause the DAG (user intervention) instead of hard-failing all downstream. */
  pause?: boolean;
}

export interface CorrectionInput {
  note: string;
  /**
   * Major corrections pause the DAG and set needsAskReplan (caller should raise AskReplan).
   * Minor corrections only re-open related unfinished subtasks.
   */
  major?: boolean;
  /** Explicit scope; when omitted, all non-completed subtasks are considered related. */
  relatedSubtaskIds?: string[];
}

export interface CorrectionResult {
  dag: SubtaskDag;
  affectedSubtaskIds: string[];
  needsAskReplan: boolean;
  replanFeedback?: string;
}

export interface ScheduleResult {
  dag: SubtaskDag;
  started: string[];
  frontier: string[];
  blocked: string[];
  completed: boolean;
}

export interface ResumeResult {
  dag: SubtaskDag;
  frontier: string[];
  resumed: boolean;
  reason?: string;
}

export interface SubtaskStateFile {
  schemaVersion: 1;
  dags: SubtaskDag[];
}
