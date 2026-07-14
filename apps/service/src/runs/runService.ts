import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TodoService } from "../todos/todoService.js";
import type { AiPlanningService, AiGeneratedPlan, AiTaskAssessment } from "../planning/aiPlanningService.js";
import type { PlanningProjectFacts } from "../planning/planningContext.js";
import { computePlanVersionDiff, type PlanVersionDiff } from "../planning/planDiff.js";
import {
  assessTask,
  defaultVerificationCommands,
  generateSecondmatePlan,
  type GeneratedPlan,
  type PlanComplexity,
  type TaskAssessment,
  type TaskType
} from "../planning/planningService.js";
import {
  answerAskUserRequest,
  criticalInputsToAskUser,
  enqueueAskUser,
  hasPendingAskUser,
  type AnswerAskUserInput,
  type AskUserRequest,
  type CreateAskUserInput
} from "../askUser/askUserService.js";
import {
  actionKindFromStep,
  createEmptyFingerprint,
  isDangerousActionKind,
  type WorkspaceFingerprint
} from "./workspaceFingerprint.js";

export { taskTypes } from "../planning/planningService.js";
export type { PlanComplexity, TaskType } from "../planning/planningService.js";
export type { WorkspaceFingerprint } from "./workspaceFingerprint.js";
export {
  captureWorkspaceFingerprint,
  createEmptyFingerprint,
  fingerprintsMatch,
  isDangerousActionKind,
  actionKindFromStep
} from "./workspaceFingerprint.js";

export const runStatuses = [
  "created",
  "planning",
  "waiting_for_user",
  "awaiting_plan_approval",
  "queued",
  "running",
  "paused",
  "awaiting_review",
  "awaiting_acceptance",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
] as const;

export type RunStatus = (typeof runStatuses)[number];

const executionLifecycleStatuses = new Set<RunStatus>([
  "queued",
  "running",
  "awaiting_review",
  "awaiting_acceptance",
  "completed",
  "failed",
  "interrupted"
]);

export type TimelineKind =
  | "user_message"
  | "plan_version"
  | "correction"
  | "agent_status"
  | "log"
  | "review"
  | "artifact"
  | "approval"
  | "checkpoint"
  | "ask_user";

export type CheckpointActionKind =
  | "write_file"
  | "overwrite_file"
  | "delete_file"
  | "system_install"
  | "external_send"
  | "other";

export type CheckpointStepStatus = "completed" | "failed" | "interrupted";

/** Durable step-level checkpoint. Recovery rebuilds model context; it never restores a live model session. */
export interface RunCheckpoint {
  id: string;
  sequence: number;
  createdAt: string;
  step: string;
  stepStatus: CheckpointStepStatus;
  summary: string;
  completedSteps: string[];
  artifactPaths: string[];
  nextStep?: string;
  workspaceFingerprint: WorkspaceFingerprint;
  actionKind: CheckpointActionKind;
  dangerous: boolean;
  recoveryMode: "reconstruct_and_replay";
}

export type CheckpointRecoveryStatus =
  | "none"
  | "ready"
  | "conflict"
  | "awaiting_dangerous_reapproval";

export interface CheckpointRecoveryState {
  status: CheckpointRecoveryStatus;
  lastCheckpointId?: string;
  interruptedStep?: string;
  conflictReason?: string;
  requiresDangerousReapproval: boolean;
  dangerousReplayApproved?: boolean;
  /** Explicit: original model internal session is not restored. */
  recoveryNote: string;
}

export interface InterruptedRunSummary {
  runId: string;
  todoId: string;
  status: RunStatus;
  attempt: number;
  completedSteps: string[];
  interruptedStep?: string;
  failedSteps: string[];
  latestCheckpoint?: RunCheckpoint;
  checkpointRecovery?: CheckpointRecoveryState;
  updatedAt: string;
}

export interface RecordCheckpointInput {
  step: string;
  stepStatus: CheckpointStepStatus;
  summary?: string;
  nextStep?: string;
  workspaceFingerprint?: WorkspaceFingerprint;
  actionKind?: CheckpointActionKind;
  dangerous?: boolean;
}

export interface ResumeFromCheckpointInput {
  currentFingerprint?: WorkspaceFingerprint;
  /** User explicitly re-approves replaying a dangerous interrupted step. */
  approveDangerousReplay?: boolean;
}

export interface CheckpointResumeResult {
  run: Run;
  canContinue: boolean;
  conflict: boolean;
  requiresDangerousReapproval: boolean;
  resumePlan?: CheckpointResumePlan;
  reason?: string;
}

export interface CheckpointResumePlan {
  approvedPlanVersion?: number;
  completedSteps: string[];
  interruptedStep?: string;
  nextStep?: string;
  artifactPaths: string[];
  reviewIds: string[];
  approvalIds: string[];
  recoveryMode: "reconstruct_and_replay";
  note: string;
}

export const CHECKPOINT_RECOVERY_NOTE =
  "恢复通过批准计划与最近检查点重建模型会话上下文，并仅重新执行中断步骤；不会恢复原模型内部会话状态。";

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  summary: string;
  createdAt: string;
}

export interface RunMessage {
  id: string;
  role: "user";
  content: string;
  createdAt: string;
}

export interface PlanVersionIndex {
  version: number;
  summary: string;
  createdAt: string;
  complexity?: PlanComplexity;
  steps?: string[];
  acceptanceCriteria?: string[];
  risks?: string[];
  prohibitions?: string[];
  generatedBy?: "secondmate";
  revisionNote?: string;
  verificationCommands?: string[][];
  dependencies?: string[];
  expectedArtifacts?: string[];
  allowedScope?: string[];
  verificationMethods?: string[];
  /** Present when this version was produced from a prior plan (return / replan). */
  diffFromPrevious?: PlanVersionDiff;
}

export type PlanApprovalStatus = "awaiting_input" | "awaiting_approval" | "approved" | "cancelled";

export interface RunPlanning {
  assessment: TaskAssessment;
  approvalStatus: PlanApprovalStatus;
  approvedPlanVersion?: number;
  verificationCommands: string[][];
}

export interface PlanningUpdateInput {
  taskType?: TaskType;
  requiredCapabilities?: string[];
  additionalContext?: string;
  verificationCommands?: string[][];
}

export interface ProfessionalAgentSelection {
  source: "role" | "temporary";
  roleId?: string;
  name: string;
  responsibility: string;
  systemInstruction: string;
  /** API-backed agents use a connection; local Codex CLI agents use local login instead. */
  connectionId?: string;
  harness?: "api" | "codex-cli";
  modelId?: string;
  skills?: string[];
  tools: string[];
  permissions?: {
    workspace: "project_only" | "read_only";
    network: boolean;
    shell: boolean;
    externalSend: boolean;
  };
}

export type ExecutionApprovalKind =
  | "outside_workspace"
  | "delete_file"
  | "system_install"
  | "external_send"
  | "unapproved_skill"
  | "unapproved_tool"
  | "unsupported_operation";

export interface PendingExecutionApproval {
  id: string;
  kind: ExecutionApprovalKind;
  summary: string;
  status: "awaiting_confirmation" | "approved" | "rejected";
  requestedAt: string;
  decidedAt?: string;
  decisionSummary?: string;
  /** Binds an approval to the exact non-interactive execution session it authorizes. */
  authorizationFingerprint?: string;
}

export interface RequestExecutionApprovalInput {
  kind: ExecutionApprovalKind;
  summary: string;
  authorizationFingerprint?: string;
}

export interface DecideExecutionApprovalInput {
  decision: "approved" | "rejected";
  summary: string;
}

export type CorrectionChangeKind = "minor" | "goal" | "scope" | "acceptance" | "prohibition";

export interface SubmitCorrectionInput {
  instruction: string;
  changeKind?: CorrectionChangeKind;
}

export interface CorrectionResult {
  run: Run;
  requiresReapproval: boolean;
}

export interface RunExecutionState {
  status: "idle" | "running" | "succeeded" | "failed";
  selectedAgent?: ProfessionalAgentSelection;
  completedSteps: string[];
  lastError?: string;
  retryable: boolean;
  activeStep?: string;
  failureCounts: Record<string, number>;
  maxConsecutiveFailures: number;
  pendingApproval?: PendingExecutionApproval;
  /** A process may still be alive after a failed stop; no further transition is safe. */
  terminationUnconfirmed?: boolean;
  startedAt?: string;
  completedAt?: string;
}

export interface RunLog {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
}

export type ReviewSeverity = "none" | "low" | "medium" | "high" | "critical";

export interface ReviewFinding {
  criterion: string;
  met: boolean;
  evidence: string;
  severity: ReviewSeverity;
  fixScope?: string;
}

export interface ReviewIndex {
  id: string;
  status: "passed" | "changes_requested";
  summary: string;
  createdAt: string;
  /** Only `independent` reviews gate acceptance; `timeline` notes never do. */
  kind?: "independent" | "timeline";
  severity?: ReviewSeverity;
  evidence?: string[];
  fixScope?: string;
  findings?: ReviewFinding[];
  cycle?: number;
  /** Independent Reviewer role — never mutates artifacts. */
  role?: "reviewer";
}

export interface RunReviewLoop {
  autoFixCyclesUsed: number;
  maxAutoFixCycles: number;
  latestReviewId?: string;
  pendingFixInstruction?: string;
  userAccepted?: boolean;
  userAcceptanceSummary?: string;
  /** User rejected acceptance or requested rework after auto-fix exhaustion. */
  reworkRequested?: boolean;
}

export interface StructuredReviewInput {
  status: ReviewIndex["status"];
  summary: string;
  severity: ReviewSeverity;
  evidence: string[];
  fixScope?: string;
  findings: ReviewFinding[];
  cycle: number;
}

export interface ApprovalRecord {
  id: string;
  decision: "approved" | "returned" | "cancelled";
  summary: string;
  createdAt: string;
}

/** Structured verification row shared by Reviewer and PWA — use `passed`, not log keywords. */
export interface ArtifactVerificationEvidence {
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True only when exitCode is exactly 0. */
  passed: boolean;
}

/**
 * Normalized Codex Worktree evidence attached to Run artifacts.
 * Reviewer and PWA must consume this object rather than scraping logs for "passed".
 */
export interface WorktreeArtifactEvidence {
  source: "codex-worktree";
  worktreeRunId: string;
  worktreePath?: string;
  baselineCommit?: string;
  sessionStatus: "active" | "discarded" | "missing";
  changeStatus: "modified" | "no_modification";
  discarded: boolean;
  changedFiles: string[];
  /** Full unified diff when modified; empty when no_modification. */
  diff?: string;
  verificationResults: ArtifactVerificationEvidence[];
  summary: string;
  consistency?: "ok" | "missing_worktree" | "stale";
  consistencyNote?: string;
}

export interface ArtifactIndex {
  id: string;
  path: string;
  kind: string;
  createdAt: string;
  /** Optional structured evidence (Codex Worktree indexing). */
  evidence?: WorktreeArtifactEvidence;
}

/** Kind for the single normalized Codex → Diff → Artifact evidence bundle. */
export const CODEX_WORKTREE_EVIDENCE_KIND = "codex-worktree-evidence";
/** Kind for each real changed file registered from an isolated Worktree. */
export const CODEX_WORKTREE_FILE_KIND = "worktree-file";

export interface Run {
  id: string;
  todoId: string;
  connectionId?: string;
  attempt: number;
  status: RunStatus;
  messages: RunMessage[];
  planVersions: PlanVersionIndex[];
  planning?: RunPlanning;
  execution: RunExecutionState;
  logs: RunLog[];
  reviews: ReviewIndex[];
  reviewLoop?: RunReviewLoop;
  approvals: ApprovalRecord[];
  artifacts: ArtifactIndex[];
  checkpoints: RunCheckpoint[];
  checkpointRecovery?: CheckpointRecoveryState;
  /** Structured AskUser / AskApproval / AskReplan cards (persisted across restart). */
  askUserRequests: AskUserRequest[];
  /** Status to restore after the last pending AskUser is answered (when not re-planning). */
  waitingForUserResume?: {
    previousStatus: RunStatus;
    since: string;
  };
  timeline: TimelineEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface RunServicePlanningConfig {
  /** When set, Firstmate/Secondmate AI is the default planning path. */
  aiPlanning?: AiPlanningService;
  /** Optional project facts resolver for AI planning context. */
  resolveProject?: (todoId: string) => Promise<PlanningProjectFacts | undefined>;
}

interface RunState {
  schemaVersion: 1;
  runs: Run[];
}

export interface RunStateSnapshot {
  schemaVersion: 1;
  runs: Run[];
}

function emptyState(): RunState {
  return { schemaVersion: 1, runs: [] };
}

export class RunService {
  private readonly executionInterruptionHandlers = new Set<(runId: string) => unknown>();
  private mutationTail: Promise<void> = Promise.resolve();
  private aiPlanning?: AiPlanningService;
  private resolveProject?: (todoId: string) => Promise<PlanningProjectFacts | undefined>;

  private constructor(
    private readonly statePath: string,
    private state: RunState,
    private readonly todos: TodoService
  ) {}

  /** Wire AI Firstmate/Secondmate after open (roles/ModelRuntime may be constructed later). */
  configurePlanning(config: RunServicePlanningConfig): void {
    this.aiPlanning = config.aiPlanning;
    this.resolveProject = config.resolveProject;
  }

  static async open(statePath: string, todos: TodoService): Promise<RunService> {
    try {
      const decoded = JSON.parse(await readFile(statePath, "utf8")) as Partial<RunState>;
      if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.runs)) {
        throw new Error("Run state is not compatible with this service version.");
      }
      const state = decoded as RunState;
      state.runs = state.runs.map((run) => {
        const persistedExecution = (run.execution ?? {}) as Partial<RunExecutionState>;
        const persistedLoop = (run.reviewLoop ?? {}) as Partial<RunReviewLoop>;
        const persistedCheckpoints = Array.isArray(run.checkpoints) ? run.checkpoints : [];
        return {
          ...run,
          approvals: run.approvals ?? [],
          askUserRequests: Array.isArray(run.askUserRequests) ? run.askUserRequests : [],
          waitingForUserResume: run.waitingForUserResume,
          checkpoints: persistedCheckpoints,
          checkpointRecovery: normalizeCheckpointRecovery(run.checkpointRecovery, persistedCheckpoints),
          reviewLoop: {
            autoFixCyclesUsed:
              typeof persistedLoop.autoFixCyclesUsed === "number" && persistedLoop.autoFixCyclesUsed >= 0
                ? persistedLoop.autoFixCyclesUsed
                : 0,
            maxAutoFixCycles:
              typeof persistedLoop.maxAutoFixCycles === "number" && persistedLoop.maxAutoFixCycles > 0
                ? persistedLoop.maxAutoFixCycles
                : 1,
            latestReviewId: persistedLoop.latestReviewId,
            pendingFixInstruction: persistedLoop.pendingFixInstruction,
            userAccepted: persistedLoop.userAccepted,
            userAcceptanceSummary: persistedLoop.userAcceptanceSummary,
            reworkRequested: persistedLoop.reworkRequested
          },
          execution: {
            ...persistedExecution,
            status: persistedExecution.status ?? "idle",
            completedSteps: persistedExecution.completedSteps ?? [],
            retryable: persistedExecution.retryable ?? false,
            failureCounts: persistedExecution.failureCounts ?? {},
            maxConsecutiveFailures:
              typeof persistedExecution.maxConsecutiveFailures === "number" && persistedExecution.maxConsecutiveFailures > 0
                ? persistedExecution.maxConsecutiveFailures
                : 2
          }
        };
      });
      const service = new RunService(statePath, state, todos);
      const recoveredTodoIds = new Set<string>();
      for (const run of state.runs) {
        if (run.execution.status !== "running") continue;
        const now = new Date().toISOString();
        const reason = "服务重启导致正在执行的 Professional Agent 中断；可重试。";
        const interruptedStep = run.execution.activeStep;
        run.execution.status = "failed";
        run.execution.retryable = true;
        run.execution.lastError = reason;
        run.execution.completedAt = now;
        run.status = "interrupted";
        run.logs.push({ id: randomUUID(), level: "error", message: reason, createdAt: now });
        service.appendTimeline(run, "log", reason, now);
        service.appendTimeline(run, "agent_status", reason, now);
        if (interruptedStep) {
          service.appendCheckpoint(run, {
            step: interruptedStep,
            stepStatus: "interrupted",
            summary: reason,
            workspaceFingerprint: createEmptyFingerprint(now),
            actionKind: actionKindFromStep(interruptedStep),
            dangerous: isDangerousActionKind(actionKindFromStep(interruptedStep))
          }, now);
        } else {
          service.markRecoveryReady(run, now, "服务重启后可从最近检查点恢复。");
        }
        recoveredTodoIds.add(run.todoId);
      }
      if (recoveredTodoIds.size > 0) {
        await service.persist();
        await Promise.all([...recoveredTodoIds].map((todoId) => todos.update(todoId, { status: "awaiting_confirmation" })));
      }
      return service;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return new RunService(statePath, emptyState(), todos);
      }
      throw error;
    }
  }

  async listAll(): Promise<Run[]> {
    return [...this.state.runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listForTodo(todoId: string): Promise<Run[]> {
    await this.todos.get(todoId);
    return this.state.runs
      .filter((run) => run.todoId === todoId)
      .sort((left, right) => right.attempt - left.attempt);
  }

  async listInterruptedRuns(): Promise<InterruptedRunSummary[]> {
    return this.state.runs
      .filter((run) => isRecoveryWorthyRun(run))
      .map((run) => this.toInterruptedSummary(run))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listCheckpoints(runId: string): Promise<RunCheckpoint[]> {
    const run = await this.get(runId);
    return [...run.checkpoints];
  }

  onExecutionInterrupted(handler: (runId: string) => unknown): () => void {
    this.executionInterruptionHandlers.add(handler);
    return () => this.executionInterruptionHandlers.delete(handler);
  }

  async get(runId: string): Promise<Run> {
    const run = this.state.runs.find((entry) => entry.id === runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    return run;
  }

  /** Full durable snapshot for backup export (timeline/history — not large project files). */
  async exportSnapshot(): Promise<RunStateSnapshot> {
    return {
      schemaVersion: 1,
      runs: structuredClone(this.state.runs)
    };
  }

  /** Replace all Runs from a validated backup snapshot. */
  async importSnapshot(snapshot: RunStateSnapshot): Promise<void> {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.runs)) {
      throw new Error("Run backup snapshot is not compatible with this service version.");
    }
    this.state = {
      schemaVersion: 1,
      runs: structuredClone(snapshot.runs)
    };
    await this.persist();
  }

  async create(todoId: string, initialMessage?: string, connectionId?: string): Promise<Run> {
    return this.mutate(() => this.createUnsafe(todoId, initialMessage, connectionId));
  }

  async addUserMessage(runId: string, content: string): Promise<Run> {
    return this.mutate(() => this.addUserMessageUnsafe(runId, content));
  }

  async updatePlanning(runId: string, input: PlanningUpdateInput): Promise<Run> {
    return this.mutate(() => this.updatePlanningUnsafe(runId, input));
  }

  async recordPlanVersion(runId: string, input: { revisionNote?: string } = {}): Promise<Run> {
    return this.mutate(() => this.recordPlanVersionUnsafe(runId, input));
  }

  async decidePlan(runId: string, input: Pick<ApprovalRecord, "decision" | "summary">): Promise<Run> {
    return this.mutate(() => this.decidePlanUnsafe(runId, input));
  }

  /** Raise a structured AskUser / AskApproval / AskReplan card (blocks on waiting_for_user). */
  async requestAskUser(runId: string, input: CreateAskUserInput): Promise<Run> {
    return this.mutate(() => this.requestAskUserUnsafe(runId, input));
  }

  /** Answer a pending AskUser card and resume from its source.stepKey. */
  async answerAskUser(runId: string, requestId: string, input: AnswerAskUserInput): Promise<Run> {
    return this.mutate(() => this.answerAskUserUnsafe(runId, requestId, input));
  }

  async listAskUser(runId: string): Promise<AskUserRequest[]> {
    const run = await this.get(runId);
    return [...(run.askUserRequests ?? [])];
  }

  async beginProfessionalExecution(
    runId: string,
    agent: ProfessionalAgentSelection,
    options: { maxConsecutiveFailures?: number } = {}
  ): Promise<Run> {
    return this.mutate(() => this.beginProfessionalExecutionUnsafe(runId, agent, options));
  }

  async resumeRetryableExecution(runId: string): Promise<Run> {
    return this.mutate(() => this.resumeRetryableExecutionUnsafe(runId));
  }

  async recordExecutionStep(
    runId: string,
    step: string,
    meta: Omit<RecordCheckpointInput, "step" | "stepStatus"> = {}
  ): Promise<Run> {
    return this.mutate(() => this.recordExecutionStepUnsafe(runId, step, meta));
  }

  async beginExecutionStep(runId: string, step: string): Promise<Run> {
    return this.mutate(() => this.beginExecutionStepUnsafe(runId, step));
  }

  async recordStepCheckpoint(runId: string, input: RecordCheckpointInput): Promise<Run> {
    return this.mutate(() => this.recordStepCheckpointUnsafe(runId, input));
  }

  async resumeFromCheckpoint(runId: string, input: ResumeFromCheckpointInput = {}): Promise<CheckpointResumeResult> {
    return this.mutate(() => this.resumeFromCheckpointUnsafe(runId, input));
  }

  async finishProfessionalExecution(runId: string, summary: string): Promise<Run> {
    return this.mutate(() => this.finishProfessionalExecutionUnsafe(runId, summary));
  }

  async failProfessionalExecution(runId: string, errorMessage: string): Promise<Run> {
    return this.mutate(() => this.failProfessionalExecutionUnsafe(runId, errorMessage));
  }

  async transition(runId: string, status: RunStatus, summary: string): Promise<Run> {
    return this.mutate(() => this.transitionUnsafe(runId, status, summary));
  }

  async pauseForConnection(connectionId: string, reason: string): Promise<Run[]> {
    return this.mutate(() => this.pauseForConnectionUnsafe(connectionId, reason));
  }

  async stop(runId: string, summary: string): Promise<Run> {
    return this.mutate(() => this.stopUnsafe(runId, summary));
  }

  async requestExecutionApproval(runId: string, input: RequestExecutionApprovalInput): Promise<Run> {
    return this.mutate(() => this.requestExecutionApprovalUnsafe(runId, input));
  }

  async decideExecutionApproval(runId: string, input: DecideExecutionApprovalInput): Promise<Run> {
    return this.mutate(() => this.decideExecutionApprovalUnsafe(runId, input));
  }

  async submitCorrection(runId: string, input: SubmitCorrectionInput): Promise<CorrectionResult> {
    return this.mutate(() => this.submitCorrectionUnsafe(runId, input));
  }

  async recordLog(runId: string, input: { level: RunLog["level"]; message: string }): Promise<Run> {
    return this.mutate(() => this.recordLogUnsafe(runId, input));
  }

  async recordReview(runId: string, input: { status: ReviewIndex["status"]; summary: string }): Promise<Run> {
    return this.mutate(() => this.recordReviewUnsafe(runId, input));
  }

  async applyStructuredReview(runId: string, input: StructuredReviewInput): Promise<Run> {
    return this.mutate(() => this.applyStructuredReviewUnsafe(runId, input));
  }

  async prepareReviewFix(runId: string, instruction: string, options: { userAuthorized?: boolean } = {}): Promise<Run> {
    return this.mutate(() => this.prepareReviewFixUnsafe(runId, instruction, options));
  }

  /** Roll back an auto-fix cycle when the agent only reached write-session approval, not real execution. */
  async rollbackUnusedAutoFixCycle(runId: string): Promise<Run> {
    return this.mutate(() => this.rollbackUnusedAutoFixCycleUnsafe(runId));
  }

  async acceptReviewOutcome(runId: string, summary: string): Promise<Run> {
    return this.mutate(() => this.acceptReviewOutcomeUnsafe(runId, summary));
  }

  async rejectReviewOutcome(runId: string, summary: string): Promise<Run> {
    return this.mutate(() => this.rejectReviewOutcomeUnsafe(runId, summary));
  }

  async recordArtifact(runId: string, input: { path: string; kind: string }): Promise<Run> {
    return this.mutate(() => this.recordArtifactUnsafe(runId, input));
  }

  /**
   * Registers normalized Codex Worktree evidence on the Run.
   * Allowed after success/fail/pause so indexing is not blocked by terminal execution status.
   * Replaces any previous Codex worktree evidence for this Run (idempotent re-index).
   */
  async recordCodexWorktreeArtifacts(
    runId: string,
    input: {
      evidence: WorktreeArtifactEvidence;
      /** Real changed files only — empty when no_modification. */
      changedFiles: string[];
    }
  ): Promise<Run> {
    return this.mutate(() => this.recordCodexWorktreeArtifactsUnsafe(runId, input));
  }

  /** Keeps historical artifacts but marks Worktree evidence as discarded after worktree remove. */
  async markWorktreeArtifactsDiscarded(runId: string): Promise<Run> {
    return this.mutate(() => this.markWorktreeArtifactsDiscardedUnsafe(runId));
  }

  /** Updates consistency flags on Codex worktree evidence (e.g. after restart when worktree is missing). */
  async reconcileWorktreeArtifactConsistency(
    runId: string,
    input: { sessionStatus: "active" | "discarded" | "missing"; consistency: "ok" | "missing_worktree" | "stale"; consistencyNote?: string }
  ): Promise<Run> {
    return this.mutate(() => this.reconcileWorktreeArtifactConsistencyUnsafe(runId, input));
  }

  private async createUnsafe(todoId: string, initialMessage?: string, connectionId?: string): Promise<Run> {
    const todo = await this.todos.get(todoId);
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      todoId,
      connectionId,
      attempt: this.state.runs.filter((entry) => entry.todoId === todoId).length + 1,
      status: "created",
      messages: [],
      planVersions: [],
      execution: { status: "idle", completedSteps: [], retryable: false, failureCounts: {}, maxConsecutiveFailures: 2 },
      logs: [],
      reviews: [],
      reviewLoop: { autoFixCyclesUsed: 0, maxAutoFixCycles: 1 },
      approvals: [],
      artifacts: [],
      checkpoints: [],
      askUserRequests: [],
      timeline: [],
      createdAt: now,
      updatedAt: now
    };
    if (initialMessage?.trim()) this.appendMessage(run, initialMessage.trim(), now);
    await this.applyPlanningPipeline(run, {
      title: todo.title,
      description: todo.description
    }, now);
    this.state.runs.push(run);
    await this.persist();
    await this.todos.update(todoId, { status: "awaiting_confirmation" });
    return run;
  }

  private async addUserMessageUnsafe(runId: string, content: string): Promise<Run> {
    const run = await this.get(runId);
    const normalized = content.trim();
    if (!normalized) throw new Error("A Run message is required.");
    this.appendMessage(run, normalized, new Date().toISOString());
    await this.persist();
    return run;
  }

  private async updatePlanningUnsafe(runId: string, input: PlanningUpdateInput): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "Planning changes");
    if (run.status === "cancelled") throw new Error("A cancelled Run cannot be replanned; create a new Run instead.");
    if (run.execution.status === "running") throw new Error("An active Professional Agent must stop before planning changes.");
    if (run.planning?.approvalStatus === "cancelled") throw new Error("A cancelled plan cannot be updated; create a new Run instead.");
    if (hasPendingAskUser(run.askUserRequests) && !input.additionalContext?.trim() && input.taskType === undefined && input.requiredCapabilities === undefined) {
      throw new Error("This Run is waiting_for_user; answer the pending AskUser card or provide planning context.");
    }
    const todo = await this.todos.get(run.todoId);
    if (input.requiredCapabilities !== undefined && normalizeCapabilities(input.requiredCapabilities).length === 0) {
      throw new Error("At least one required capability is required.");
    }
    if (input.verificationCommands !== undefined && !validVerificationCommands(input.verificationCommands)) {
      throw new Error("Verification commands must be non-empty command argument arrays.");
    }
    const now = new Date().toISOString();
    if (input.additionalContext?.trim()) this.appendMessage(run, input.additionalContext.trim(), now);
    // User-provided context supersedes open critical-input asks so planning can proceed.
    if (input.additionalContext?.trim() || input.taskType || input.requiredCapabilities) {
      this.supersedeAsksForStep(run, "planning.critical_input", now, "用户已通过规划更新提供上下文。");
    }
    await this.applyPlanningPipeline(run, {
      title: todo.title,
      description: todo.description
    }, now, {
      taskType: input.taskType,
      requiredCapabilities: input.requiredCapabilities,
      verificationCommands: input.verificationCommands
    });
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return run;
  }

  private async recordPlanVersionUnsafe(runId: string, input: { revisionNote?: string } = {}): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "Plan version changes");
    if (run.status === "cancelled") throw new Error("A cancelled Run cannot receive another plan version; create a new Run instead.");
    if (run.execution.status === "running") throw new Error("An active Professional Agent must stop before planning changes.");
    if (hasPendingAskUser(run.askUserRequests)) {
      throw new Error("Cannot record a plan version while waiting_for_user on a pending AskUser card.");
    }
    const todo = await this.todos.get(run.todoId);
    const now = new Date().toISOString();
    const hadPlanning = Boolean(run.planning);
    if (!run.planning) {
      await this.applyPlanningPipeline(run, { title: todo.title, description: todo.description }, now);
    }
    // Re-read after pipeline mutation (TS control-flow cannot see the in-place assignment).
    if (!hadPlanning && run.planning?.assessment.criticalInputs.length) {
      throw new Error("A critical input is required before a plan version can be recorded.");
    }
    if (!hadPlanning && run.planVersions.length > 0 && !input.revisionNote?.trim()) {
      await this.persist();
      await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
      return run;
    }
    if (!run.planning) throw new Error("Firstmate assessment is required before generating a plan.");
    if (run.planning.approvalStatus === "cancelled") throw new Error("A cancelled plan cannot receive another version.");
    if (run.planning.assessment.criticalInputs.length > 0) throw new Error("A critical input is required before a plan version can be recorded.");
    run.planning.approvalStatus = "awaiting_approval";
    run.planning.approvedPlanVersion = undefined;
    run.status = "awaiting_plan_approval";
    await this.appendGeneratedPlan(run, now, input.revisionNote);
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return run;
  }

  private async decidePlanUnsafe(runId: string, input: Pick<ApprovalRecord, "decision" | "summary">): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "Plan decisions");
    if (run.status === "cancelled") throw new Error("A cancelled Run cannot receive a plan decision; create a new Run instead.");
    if (run.status === "waiting_for_user" && hasPendingAskUser(run.askUserRequests)) {
      throw new Error("Cannot decide a plan while waiting_for_user on a pending AskUser card.");
    }
    const planning = run.planning;
    if (!planning || run.planVersions.length === 0 || planning.approvalStatus === "awaiting_input") {
      throw new Error("A Secondmate plan is required before a decision can be recorded.");
    }
    if (planning.approvalStatus === "cancelled") throw new Error("A cancelled plan cannot be decided again.");
    if (planning.approvalStatus !== "awaiting_approval") throw new Error("Only a plan awaiting approval can be decided.");
    if (input.decision !== "approved" && input.decision !== "returned" && input.decision !== "cancelled") {
      throw new Error("Plan decision is invalid.");
    }
    if (!input.summary.trim()) throw new Error("A plan decision summary is required.");
    const now = new Date().toISOString();
    run.approvals.push({ id: randomUUID(), ...input, summary: input.summary.trim(), createdAt: now });
    this.appendTimeline(run, "approval", input.summary.trim(), now);

    if (input.decision === "approved") {
      planning.approvalStatus = "approved";
      planning.approvedPlanVersion = run.planVersions.at(-1)?.version;
      run.status = "queued";
      this.appendTimeline(run, "agent_status", "Firstmate 已完成编排；计划获批，等待获授权的执行代理。", now);
    } else if (input.decision === "returned") {
      planning.approvalStatus = "awaiting_approval";
      planning.approvedPlanVersion = undefined;
      run.status = "awaiting_plan_approval";
      // Real plan revision from feedback (AI when available, template fallback otherwise).
      await this.appendGeneratedPlan(run, now, input.summary.trim());
    } else {
      planning.approvalStatus = "cancelled";
      planning.approvedPlanVersion = undefined;
      run.status = "cancelled";
      this.appendTimeline(run, "agent_status", "用户取消了计划；Firstmate 不会启动执行。", now);
    }
    await this.persist();
    await this.todos.update(run.todoId, { status: "pending" });
    return run;
  }

  private async requestAskUserUnsafe(runId: string, input: CreateAskUserInput): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "AskUser");
    if (run.status === "cancelled" || run.status === "completed") {
      throw new Error("Cannot raise AskUser on a terminal Run.");
    }
    if (run.execution.status === "running" && input.kind !== "ask_approval") {
      // Allow ask_approval during execution; other asks require pause discipline from caller.
    }
    const now = new Date().toISOString();
    const previousStatus = run.status === "waiting_for_user"
      ? (run.waitingForUserResume?.previousStatus ?? "planning")
      : run.status;
    const { requests, created, mergedInto } = enqueueAskUser(run.askUserRequests ?? [], input, now);
    run.askUserRequests = requests;
    if (mergedInto) {
      this.appendTimeline(
        run,
        "ask_user",
        `Firstmate 合并了来自 ${created.source.agent} 的问题到已有卡片（避免重复打扰）；恢复位置：${mergedInto.source.stepKey}`,
        now
      );
    } else {
      this.appendTimeline(
        run,
        "ask_user",
        `${created.kind} 来自 ${created.source.agent}：${created.prompt}（原因：${created.reason}；恢复位置：${created.source.stepKey}；状态：${created.status}）`,
        now
      );
    }
    if (hasPendingAskUser(run.askUserRequests)) {
      if (run.status !== "waiting_for_user") {
        run.waitingForUserResume = { previousStatus, since: now };
      }
      run.status = "waiting_for_user";
      this.appendTimeline(run, "agent_status", "Run 进入 waiting_for_user；在用户回答前不会继续消耗模型或执行后续步骤。", now);
    }
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return run;
  }

  private async answerAskUserUnsafe(runId: string, requestId: string, input: AnswerAskUserInput): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "AskUser answer");
    if (!run.askUserRequests?.length) throw new Error("This Run has no AskUser requests.");
    const now = new Date().toISOString();
    const { requests, result } = answerAskUserRequest(run.askUserRequests, requestId, input, now);
    run.askUserRequests = requests;

    const answerSummary = formatAskAnswerSummary(result.request);
    this.appendTimeline(
      run,
      "ask_user",
      `用户回答 ${result.request.kind}（来源 ${result.request.source.agent}，恢复位置 ${result.resumeStepKey}）：${answerSummary}`,
      now
    );

    // Return content precisely into the original step pipeline.
    if (result.request.kind === "ask_user" || result.request.kind === "ask_replan") {
      const text = result.request.answer?.freeText
        ?? result.request.answer?.replanFeedback
        ?? result.request.answer?.selectedOptionIds?.join(", ");
      if (text?.trim()) this.appendMessage(run, text.trim(), now);
    }

    if (result.nextPending) {
      run.status = "waiting_for_user";
      this.appendTimeline(
        run,
        "ask_user",
        `队列中的下一问题已提升为 pending：${result.nextPending.prompt}（恢复位置：${result.nextPending.source.stepKey}）`,
        now
      );
      await this.persist();
      await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
      return run;
    }

    const resumeAfterAnswer = run.waitingForUserResume?.previousStatus;
    run.waitingForUserResume = undefined;
    const stepKey = result.resumeStepKey;

    if (result.request.kind === "ask_replan" || stepKey === "planning.replan" || stepKey.startsWith("planning.replan")) {
      const feedback = result.replanFeedback ?? result.request.answer?.freeText ?? "请根据用户反馈修订计划。";
      const todo = await this.todos.get(run.todoId);
      if (!run.planning) {
        await this.applyPlanningPipeline(run, { title: todo.title, description: todo.description }, now, {
          revisionNote: feedback
        });
      } else {
        run.planning.approvalStatus = "awaiting_approval";
        run.planning.approvedPlanVersion = undefined;
        run.status = "awaiting_plan_approval";
        await this.appendGeneratedPlan(run, now, feedback);
      }
    } else if (stepKey === "planning.critical_input" || stepKey.startsWith("planning.")) {
      const todo = await this.todos.get(run.todoId);
      await this.applyPlanningPipeline(run, { title: todo.title, description: todo.description }, now);
    } else if (result.request.kind === "ask_approval") {
      const approved = result.request.answer?.approved;
      this.appendTimeline(
        run,
        "approval",
        approved === false ? "用户拒绝了 AskApproval 请求。" : "用户批准了 AskApproval 请求。",
        now
      );
      run.status = resumeAfterAnswer && resumeAfterAnswer !== "waiting_for_user"
        ? resumeAfterAnswer
        : (run.planning?.approvalStatus === "approved" ? "paused" : "planning");
    } else {
      run.status = resumeAfterAnswer && resumeAfterAnswer !== "waiting_for_user" ? resumeAfterAnswer : "planning";
    }

    if (hasPendingAskUser(run.askUserRequests)) {
      run.status = "waiting_for_user";
    }

    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return run;
  }

  async recordApproval(runId: string, input: Pick<ApprovalRecord, "decision" | "summary">): Promise<Run> {
    return this.decidePlan(runId, input);
  }

  private async beginProfessionalExecutionUnsafe(
    runId: string,
    agent: ProfessionalAgentSelection,
    options: { maxConsecutiveFailures?: number } = {}
  ): Promise<Run> {
    const run = await this.assertExecutionAuthorized(runId, "Professional Agent execution");
    this.assertTerminationConfirmed(run, "Professional Agent execution");
    if (run.execution.status === "running") throw new Error("This Run already has an active Professional Agent.");
    const reviewFixPending = Boolean(run.reviewLoop?.pendingFixInstruction);
    if (run.execution.status === "succeeded" && !reviewFixPending) {
      throw new Error("This Run has already completed; create a new Run for another execution.");
    }
    if (run.execution.pendingApproval?.status === "awaiting_confirmation") {
      throw new Error("This Run has an execution approval awaiting confirmation.");
    }
    if (run.execution.status === "failed" && !run.execution.retryable && !reviewFixPending) {
      throw new Error("This Run is not retryable and requires a user correction or a new Run.");
    }
    const now = new Date().toISOString();
    run.connectionId = agent.connectionId;
    const fixInstruction = run.reviewLoop?.pendingFixInstruction;
    const maxConsecutiveFailures =
      typeof options.maxConsecutiveFailures === "number" && options.maxConsecutiveFailures > 0
        ? Math.floor(options.maxConsecutiveFailures)
        : run.execution.maxConsecutiveFailures;
    run.execution = {
      ...run.execution,
      status: "running",
      selectedAgent: agent,
      retryable: false,
      lastError: undefined,
      activeStep: undefined,
      pendingApproval: undefined,
      terminationUnconfirmed: undefined,
      maxConsecutiveFailures,
      startedAt: now,
      completedAt: undefined
    };
    run.status = "running";
    this.appendTimeline(
      run,
      "agent_status",
      fixInstruction
        ? `Firstmate 已派发审查修复给 ${agent.name}。`
        : `Firstmate 已选择 ${agent.harness === "codex-cli" ? "Codex CLI Role" : "Professional Agent"}：${agent.name}。`,
      now
    );
    if (fixInstruction) {
      this.appendTimeline(run, "correction", `审查修复指令：${fixInstruction}`, now);
    }
    await this.persist();
    await this.todos.update(run.todoId, { status: "running" });
    return run;
  }

  private async resumeRetryableExecutionUnsafe(runId: string): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "Professional Agent retry");
    if (run.status !== "paused" && run.status !== "interrupted") throw new Error("Only a paused or interrupted Run can be resumed.");
    this.assertApprovedPlan(run, "Professional Agent retry");
    if (run.execution.status !== "failed" || !run.execution.retryable || !run.execution.selectedAgent) {
      throw new Error("This Run does not have a retryable Professional Agent execution.");
    }
    if (run.execution.pendingApproval?.status === "awaiting_confirmation") {
      throw new Error("This Run has an execution approval awaiting confirmation.");
    }
    const now = new Date().toISOString();
    run.status = "queued";
    this.appendTimeline(run, "agent_status", "用户确认恢复 Professional Agent 重试。", now);
    await this.persist();
    return run;
  }

  private async recordExecutionStepUnsafe(
    runId: string,
    step: string,
    meta: Omit<RecordCheckpointInput, "step" | "stepStatus"> = {}
  ): Promise<Run> {
    const run = await this.assertExecutionAuthorized(runId, "Professional Agent tool activity", undefined, true);
    const normalized = step.trim();
    if (!normalized) throw new Error("An execution step is required.");
    const now = new Date().toISOString();
    run.execution.completedSteps.push(normalized);
    run.execution.activeStep = undefined;
    delete run.execution.failureCounts[normalized];
    const activity = `工具活动：${normalized.replace(/^write_file:/, "write_file ")}`;
    run.logs.push({ id: randomUUID(), level: "info", message: activity, createdAt: now });
    this.appendTimeline(run, "log", activity, now);
    const actionKind = meta.actionKind ?? actionKindFromStep(normalized);
    const dangerous = meta.dangerous ?? isDangerousActionKind(actionKind);
    this.appendCheckpoint(run, {
      step: normalized,
      stepStatus: "completed",
      summary: meta.summary?.trim() || activity,
      nextStep: meta.nextStep?.trim() || undefined,
      workspaceFingerprint: meta.workspaceFingerprint ?? createEmptyFingerprint(now),
      actionKind,
      dangerous
    }, now);
    await this.persist();
    return run;
  }

  private async recordStepCheckpointUnsafe(runId: string, input: RecordCheckpointInput): Promise<Run> {
    const run = await this.get(runId);
    const normalized = input.step.trim();
    if (!normalized) throw new Error("A checkpoint step is required.");
    if (input.stepStatus !== "completed" && input.stepStatus !== "failed" && input.stepStatus !== "interrupted") {
      throw new Error("Checkpoint step status is invalid.");
    }
    const now = new Date().toISOString();
    const actionKind = input.actionKind ?? actionKindFromStep(normalized);
    const dangerous = input.dangerous ?? isDangerousActionKind(actionKind);
    this.appendCheckpoint(run, {
      step: normalized,
      stepStatus: input.stepStatus,
      summary: input.summary?.trim() || `检查点：${normalized}（${input.stepStatus}）`,
      nextStep: input.nextStep?.trim() || undefined,
      workspaceFingerprint: input.workspaceFingerprint ?? createEmptyFingerprint(now),
      actionKind,
      dangerous
    }, now);
    await this.persist();
    return run;
  }

  private async resumeFromCheckpointUnsafe(runId: string, input: ResumeFromCheckpointInput): Promise<CheckpointResumeResult> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "Checkpoint resume");
    this.assertApprovedPlan(run, "Checkpoint resume");
    if (run.status === "cancelled") throw new Error("A cancelled Run cannot be resumed from a checkpoint.");
    if (run.execution.status === "running") throw new Error("An active Professional Agent must stop before checkpoint resume.");
    if (run.execution.status === "succeeded" && !run.reviewLoop?.pendingFixInstruction) {
      throw new Error("A completed execution cannot be resumed from a checkpoint.");
    }

    const now = new Date().toISOString();
    // approveDangerousReplay may settle the checkpoint dangerous-replay gate without a separate approval API call.
    if (run.execution.pendingApproval?.status === "awaiting_confirmation") {
      const pending = run.execution.pendingApproval;
      const isCheckpointDangerousGate = run.checkpointRecovery?.requiresDangerousReapproval === true
        || run.checkpointRecovery?.status === "awaiting_dangerous_reapproval"
        || /不会自动重放|危险步骤|危险操作/.test(pending.summary);
      if (input.approveDangerousReplay === true && isCheckpointDangerousGate) {
        pending.status = "approved";
        pending.decidedAt = now;
        pending.decisionSummary = "用户通过检查点恢复确认重放危险步骤。";
        run.checkpointRecovery = {
          status: "ready",
          lastCheckpointId: run.checkpointRecovery?.lastCheckpointId ?? run.checkpoints.at(-1)?.id,
          interruptedStep: run.checkpointRecovery?.interruptedStep,
          requiresDangerousReapproval: false,
          dangerousReplayApproved: true,
          recoveryNote: CHECKPOINT_RECOVERY_NOTE
        };
        this.appendTimeline(run, "approval", "用户确认危险步骤可在检查点恢复中重放。", now);
        this.appendTimeline(run, "checkpoint", "危险步骤已获检查点恢复确认。", now);
      } else {
        throw new Error("This Run has an execution approval awaiting confirmation.");
      }
    }

    const latest = run.checkpoints.at(-1);
    const baseline = [...run.checkpoints].reverse().find((entry) => entry.stepStatus === "completed") ?? latest;
    const interrupted = [...run.checkpoints].reverse().find((entry) => entry.stepStatus === "interrupted")
      ?? (run.execution.activeStep
        ? undefined
        : run.checkpoints.find((entry) => entry.step === run.checkpointRecovery?.interruptedStep && entry.stepStatus === "interrupted"));
    const interruptedStep = interrupted?.step ?? run.checkpointRecovery?.interruptedStep ?? run.execution.activeStep;
    const interruptedMeta = interrupted ?? (interruptedStep
      ? {
          step: interruptedStep,
          dangerous: isDangerousActionKind(actionKindFromStep(interruptedStep)),
          actionKind: actionKindFromStep(interruptedStep) as CheckpointActionKind,
          nextStep: undefined as string | undefined
        }
      : undefined);

    // Fail-closed: when a non-empty baseline exists, require a current fingerprint and match it.
    if (baseline && baseline.workspaceFingerprint.kind !== "empty") {
      if (!input.currentFingerprint) {
        const conflictReason = "无法获取当前工作区指纹；检查点恢复已暂停（fail-closed）。";
        return this.pauseForWorkspaceConflict(run, baseline, interruptedStep, interruptedMeta, conflictReason, now);
      }
      if (baseline.workspaceFingerprint.value !== input.currentFingerprint.value) {
        const conflictReason = "工作区在中断后被外部修改；检查点恢复已暂停，请先还原工作区后再恢复。";
        return this.pauseForWorkspaceConflict(run, baseline, interruptedStep, interruptedMeta, conflictReason, now);
      }
    }

    const dangerousApproved = input.approveDangerousReplay === true
      || run.checkpointRecovery?.dangerousReplayApproved === true
      || (run.execution.pendingApproval?.status === "approved"
        && interruptedMeta
        && isDangerousActionKind(interruptedMeta.actionKind));

    if (interruptedMeta?.dangerous && !dangerousApproved) {
      const reason = `中断步骤 ${interruptedMeta.step} 属于危险操作，不会自动重放；需要用户再次确认。`;
      run.status = "paused";
      run.execution.retryable = true;
      if (run.execution.status !== "failed" && run.execution.status !== "succeeded") {
        run.execution.status = "failed";
      }
      run.execution.lastError = reason;
      const approvalKind = dangerousApprovalKind(interruptedMeta.actionKind);
      run.execution.pendingApproval = {
        id: randomUUID(),
        kind: approvalKind,
        summary: reason,
        status: "awaiting_confirmation",
        requestedAt: now
      };
      run.checkpointRecovery = {
        status: "awaiting_dangerous_reapproval",
        lastCheckpointId: latest?.id,
        interruptedStep: interruptedMeta.step,
        requiresDangerousReapproval: true,
        dangerousReplayApproved: false,
        recoveryNote: CHECKPOINT_RECOVERY_NOTE
      };
      this.appendTimeline(run, "approval", `需要用户确认：${reason}`, now);
      this.appendTimeline(run, "checkpoint", reason, now);
      await this.persist();
      await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
      return {
        run,
        canContinue: false,
        conflict: false,
        requiresDangerousReapproval: true,
        reason
      };
    }

    // Preserve approved plan, reviews, reviewLoop, and approvals; only re-queue retryable execution.
    const approvedPlanVersion = run.planning?.approvedPlanVersion;
    const reviewIds = run.reviews.map((review) => review.id);
    const approvalIds = run.approvals.map((approval) => approval.id);
    const resumePlan: CheckpointResumePlan = {
      approvedPlanVersion,
      completedSteps: [...run.execution.completedSteps],
      interruptedStep,
      nextStep: interrupted?.nextStep ?? latest?.nextStep,
      artifactPaths: run.artifacts.map((artifact) => artifact.path),
      reviewIds,
      approvalIds,
      recoveryMode: "reconstruct_and_replay",
      note: CHECKPOINT_RECOVERY_NOTE
    };

    run.execution.retryable = true;
    if (run.execution.status === "succeeded" && run.reviewLoop?.pendingFixInstruction) {
      run.execution.status = "failed";
    }
    if (run.execution.status !== "failed" && run.execution.status !== "idle") {
      run.execution.status = "failed";
    }
    if (run.execution.status === "idle" && run.execution.selectedAgent) {
      run.execution.status = "failed";
    }
    run.execution.lastError = undefined;
    run.execution.activeStep = undefined;
    run.status = "queued";
    run.checkpointRecovery = {
      status: "ready",
      lastCheckpointId: latest?.id,
      interruptedStep,
      requiresDangerousReapproval: false,
      dangerousReplayApproved: interruptedMeta?.dangerous ? true : undefined,
      recoveryNote: CHECKPOINT_RECOVERY_NOTE
    };
    this.appendTimeline(run, "checkpoint", `检查点恢复就绪：${CHECKPOINT_RECOVERY_NOTE}`, now);
    this.appendTimeline(
      run,
      "agent_status",
      interruptedStep
        ? `将从检查点重建上下文并重新执行中断步骤：${interruptedStep}。`
        : "将从检查点重建上下文并继续执行。",
      now
    );
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return {
      run,
      canContinue: true,
      conflict: false,
      requiresDangerousReapproval: false,
      resumePlan
    };
  }

  private async beginExecutionStepUnsafe(runId: string, step: string): Promise<Run> {
    const run = await this.assertExecutionAuthorized(runId, "Professional Agent tool activity", undefined, true);
    const normalized = step.trim();
    if (!normalized) throw new Error("An execution step is required.");
    run.execution.activeStep = normalized;
    await this.persist();
    return run;
  }

  private async finishProfessionalExecutionUnsafe(runId: string, summary: string): Promise<Run> {
    const run = await this.assertExecutionAuthorized(runId, "Professional Agent completion", undefined, true);
    const now = new Date().toISOString();
    run.execution.status = "succeeded";
    run.execution.retryable = false;
    run.execution.completedAt = now;
    run.status = "awaiting_review";
    if (run.reviewLoop?.pendingFixInstruction) {
      run.reviewLoop.pendingFixInstruction = undefined;
    }
    this.ensureReviewLoop(run);
    this.appendTimeline(run, "agent_status", summary, now);
    this.appendTimeline(run, "agent_status", "执行已结束；等待独立 Reviewer 审查，不得直接标记完成。", now);
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return run;
  }

  private async failProfessionalExecutionUnsafe(runId: string, errorMessage: string): Promise<Run> {
    const run = await this.get(runId);
    const message = errorMessage.trim() || "Professional Agent execution failed.";
    const now = new Date().toISOString();
    const preserveInterruptionReason =
      (
        run.status === "paused"
        || run.status === "cancelled"
        || run.status === "interrupted"
        || run.status === "queued"
        || ((run.status === "planning" || run.status === "awaiting_plan_approval") && run.planning?.approvalStatus !== "approved")
      )
      && run.execution.status === "failed"
      && Boolean(run.execution.lastError);
    const recordedMessage = preserveInterruptionReason ? run.execution.lastError! : message;
    const activeStep = run.execution.activeStep;
    run.execution.status = "failed";
    let limitReached = false;
    if (!preserveInterruptionReason) {
      const failedStep = activeStep ?? "Professional Agent response";
      const nextFailureCount = (run.execution.failureCounts[failedStep] ?? 0) + 1;
      run.execution.failureCounts[failedStep] = nextFailureCount;
      limitReached = nextFailureCount >= run.execution.maxConsecutiveFailures;
      run.execution.retryable = run.status !== "cancelled" && !limitReached;
      run.execution.lastError = message;
    }
    run.execution.activeStep = undefined;
    run.execution.completedAt = now;
    if (limitReached && run.status !== "cancelled") run.status = "paused";
    else if (!preserveInterruptionReason && run.status !== "paused" && run.status !== "cancelled" && run.status !== "interrupted") run.status = "failed";
    run.logs.push({ id: randomUUID(), level: "error", message: recordedMessage, createdAt: now });
    this.appendTimeline(run, "log", recordedMessage, now);
    this.appendTimeline(
      run,
      "agent_status",
      limitReached
        ? `同一步骤已连续失败 ${run.execution.maxConsecutiveFailures} 次；Run 已自动暂停，不会继续重试。`
        : "Professional Agent 执行失败；已保留已完成步骤，可重试。",
      now
    );
    if (activeStep && !preserveInterruptionReason) {
      this.appendCheckpoint(run, {
        step: activeStep,
        stepStatus: limitReached ? "failed" : "interrupted",
        summary: recordedMessage,
        workspaceFingerprint: createEmptyFingerprint(now),
        actionKind: actionKindFromStep(activeStep),
        dangerous: isDangerousActionKind(actionKindFromStep(activeStep))
      }, now);
    } else if (!preserveInterruptionReason) {
      // Keep dangerous re-approval requirements already recorded on the latest checkpoint.
      if (run.checkpointRecovery?.requiresDangerousReapproval) {
        this.appendTimeline(run, "checkpoint", "执行失败后仍需用户确认危险步骤才可恢复。", now);
      } else {
        this.markRecoveryReady(run, now, "执行失败后可从最近检查点恢复。");
      }
    }
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return run;
  }

  async assertExecutionAuthorized(runId: string, operation: string, projectId?: string, requireActiveExecution = false): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, operation);
    this.assertApprovedPlan(run, operation);
    if (run.status === "waiting_for_user" || hasPendingAskUser(run.askUserRequests)) {
      throw new Error(`${operation} is blocked while waiting_for_user; answer the pending AskUser card first.`);
    }
    if (
      run.status === "paused"
      || run.status === "cancelled"
      || (run.status === "interrupted" && (run.execution.status !== "failed" || !run.execution.retryable))
    ) {
      throw new Error(`${operation} is not authorized while the Run is ${run.status}.`);
    }
    if (requireActiveExecution) this.assertActiveProfessionalExecution(run);
    if (projectId !== undefined) {
      const todo = await this.todos.get(run.todoId);
      if (todo.projectId !== projectId) throw new Error("The approved Run does not belong to this Project workspace.");
    }
    return run;
  }

  async withActiveExecution<T>(
    runId: string,
    operation: string,
    execute: () => Promise<T>,
    projectId?: string
  ): Promise<T> {
    return this.mutate(async () => {
      await this.assertExecutionAuthorized(runId, operation, projectId, true);
      return execute();
    });
  }

  private async transitionUnsafe(runId: string, status: RunStatus, summary: string): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "Run transition");
    if (run.status === "cancelled" && status !== "cancelled") throw new Error("A cancelled Run cannot transition without a new approved Run.");
    // Formal review/acceptance/completion are only reachable via finish → independent review → accept.
    if (status === "awaiting_review" || status === "awaiting_acceptance" || status === "completed") {
      throw new Error("Formal review and completion states require the controlled finish, independent review, and user acceptance path.");
    }
    if (executionLifecycleStatuses.has(status)) this.assertApprovedPlan(run, "Run execution");
    if ((status === "queued" || status === "running") && run.execution.pendingApproval?.status === "awaiting_confirmation") {
      throw new Error("This Run has an execution approval awaiting confirmation.");
    }
    if ((status === "queued" || status === "running") && run.execution.status === "failed" && !run.execution.retryable) {
      throw new Error("This Run is not retryable and requires a user correction or a new Run.");
    }
    if ((status === "queued" || status === "running") && run.execution.status === "failed") {
      throw new Error("A failed Professional Agent can only resume through its controlled retry flow.");
    }
    const now = new Date().toISOString();
    if (status === "paused" || status === "cancelled" || status === "interrupted") {
      try {
        await this.interruptProfessionalExecution(run, summary, status !== "cancelled", now);
      } catch (error) {
        await this.persistInterruptionFailure(run, error, now);
        throw error;
      }
    }
    run.status = status;
    this.appendTimeline(run, "agent_status", summary, now);
    await this.persist();
    return run;
  }

  private async pauseForConnectionUnsafe(connectionId: string, reason: string): Promise<Run[]> {
    const terminal = new Set<RunStatus>(["completed", "failed", "cancelled"]);
    const affected = this.state.runs.filter(
      (run) => run.connectionId === connectionId && !terminal.has(run.status)
    );
    if (affected.length === 0) return [];

    const now = new Date().toISOString();
    for (const run of affected) {
      try {
        await this.interruptProfessionalExecution(run, reason, true, now);
      } catch (error) {
        this.markInterruptionFailure(run, error, now);
      }
      run.status = "paused";
      this.appendTimeline(run, "agent_status", reason, now);
    }
    await this.persist();
    await Promise.all([...new Set(affected.map((run) => run.todoId))].map((todoId) =>
      this.todos.update(todoId, { status: "awaiting_confirmation" })
    ));
    return affected;
  }

  private async stopUnsafe(runId: string, summary: string): Promise<Run> {
    const run = await this.get(runId);
    if (run.execution.terminationUnconfirmed) {
      throw new Error("此前停止未确认执行进程已终止；Run 必须保持暂停，不能标记为已取消。");
    }
    const normalized = summary.trim();
    if (!normalized) throw new Error("A stop reason is required.");
    if (run.status === "completed" || run.status === "cancelled") {
      throw new Error("Only an unfinished Run can be stopped.");
    }
    const now = new Date().toISOString();
    try {
      await this.interruptProfessionalExecution(run, normalized, false, now);
    } catch (error) {
      await this.persistInterruptionFailure(run, error, now);
      throw error;
    }
    if (run.execution.status === "failed") run.execution.retryable = false;
    if (run.execution.pendingApproval?.status === "awaiting_confirmation") {
      run.execution.pendingApproval.status = "rejected";
      run.execution.pendingApproval.decidedAt = now;
      run.execution.pendingApproval.decisionSummary = `用户停止 Run：${normalized}`;
      this.appendTimeline(run, "approval", "用户停止 Run；待确认危险操作已拒绝。", now);
    }
    run.status = "cancelled";
    this.appendTimeline(run, "agent_status", normalized, now);
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return run;
  }

  private async requestExecutionApprovalUnsafe(runId: string, input: RequestExecutionApprovalInput): Promise<Run> {
    const run = await this.assertExecutionAuthorized(runId, "Execution approval request", undefined, true);
    if (!isExecutionApprovalKind(input.kind)) throw new Error("Execution approval kind is invalid.");
    const summary = input.summary.trim();
    if (!summary) throw new Error("An execution approval summary is required.");
    if (run.execution.pendingApproval?.status === "awaiting_confirmation") {
      throw new Error("This Run already has an execution approval awaiting confirmation.");
    }
    const now = new Date().toISOString();
    run.execution.pendingApproval = {
      id: randomUUID(),
      kind: input.kind,
      summary,
      status: "awaiting_confirmation",
      requestedAt: now,
      authorizationFingerprint: input.authorizationFingerprint
    };
    try {
      await this.interruptProfessionalExecution(run, summary, true, now);
    } catch (error) {
      await this.persistInterruptionFailure(run, error, now);
      throw error;
    }
    run.status = "paused";
    this.appendTimeline(run, "approval", `需要用户确认：${summary}`, now);
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return run;
  }

  private async decideExecutionApprovalUnsafe(runId: string, input: DecideExecutionApprovalInput): Promise<Run> {
    const run = await this.get(runId);
    const pending = run.execution.pendingApproval;
    if (!pending || pending.status !== "awaiting_confirmation") {
      throw new Error("This Run does not have an execution approval awaiting confirmation.");
    }
    if (input.decision !== "approved" && input.decision !== "rejected") {
      throw new Error("Execution approval decision is invalid.");
    }
    const summary = input.summary.trim();
    if (!summary) throw new Error("An execution approval decision summary is required.");
    const now = new Date().toISOString();
    pending.status = input.decision;
    pending.decidedAt = now;
    pending.decisionSummary = summary;
    this.appendTimeline(run, "approval", `用户${input.decision === "approved" ? "确认" : "拒绝"}危险操作：${summary}`, now);
    if (run.checkpointRecovery?.requiresDangerousReapproval) {
      if (input.decision === "approved") {
        run.checkpointRecovery = {
          ...run.checkpointRecovery,
          status: "ready",
          requiresDangerousReapproval: false,
          dangerousReplayApproved: true,
          recoveryNote: CHECKPOINT_RECOVERY_NOTE
        };
        this.appendTimeline(run, "checkpoint", "用户已确认可重新执行被中断的危险步骤。", now);
      } else {
        run.checkpointRecovery = {
          ...run.checkpointRecovery,
          status: "awaiting_dangerous_reapproval",
          requiresDangerousReapproval: true,
          dangerousReplayApproved: false,
          recoveryNote: CHECKPOINT_RECOVERY_NOTE
        };
        this.appendTimeline(run, "checkpoint", "用户拒绝重放危险步骤；检查点恢复保持暂停。", now);
      }
    }
    if (run.status !== "cancelled") run.status = "paused";
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return run;
  }

  private async submitCorrectionUnsafe(runId: string, input: SubmitCorrectionInput): Promise<CorrectionResult> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "Corrections");
    if (run.status === "cancelled" || run.planning?.approvalStatus === "cancelled") {
      throw new Error("A cancelled Run cannot receive a correction; create a new Run instead.");
    }
    if (run.execution.status === "succeeded") {
      throw new Error("A completed execution cannot receive a correction; create a new Run instead.");
    }
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error("A correction instruction is required.");
    if (input.changeKind !== undefined && !isCorrectionChangeKind(input.changeKind)) {
      throw new Error("Correction change kind is invalid.");
    }
    const now = new Date().toISOString();
    const requiresReapproval = correctionRequiresReapproval(instruction, input.changeKind);
    this.appendMessage(run, instruction, now);
    this.appendTimeline(
      run,
      "correction",
      requiresReapproval
        ? "用户纠偏改变了目标、范围、验收条件或禁止项；将生成计划变更并重新审批。"
        : "用户提交小范围纠偏；将在原批准计划边界内继续执行。",
      now
    );
    if (run.execution.status === "running") {
      try {
        await this.interruptProfessionalExecution(run, "用户提交纠偏，当前 Professional Agent 已暂停以安全应用变更。", true, now);
      } catch (error) {
        await this.persistInterruptionFailure(run, error, now);
        throw error;
      }
      run.status = "paused";
    }
    const invalidatesApprovedCodexWriteSession = requiresReapproval
      && run.execution.pendingApproval?.kind === "delete_file"
      && run.execution.pendingApproval.status === "approved";
    if (run.execution.pendingApproval?.status === "awaiting_confirmation" || invalidatesApprovedCodexWriteSession) {
      run.execution.pendingApproval = undefined;
      this.appendTimeline(
        run,
        "approval",
        invalidatesApprovedCodexWriteSession
          ? "用户纠偏已使先前确认的 Codex 写入会话失效；新计划需要再次确认。"
          : "用户纠偏已取代待确认的危险操作。",
        now
      );
    }
    run.execution.activeStep = undefined;
    run.execution.failureCounts = {};
    if (requiresReapproval) {
      const todo = await this.todos.get(run.todoId);
      const prior = run.planning?.assessment;
      await this.applyPlanningPipeline(run, { title: todo.title, description: todo.description }, now, {
        taskType: prior?.taskType,
        requiredCapabilities: prior?.requiredCapabilities,
        revisionNote: instruction
      });
    } else if (run.execution.selectedAgent) {
      run.execution.retryable = true;
      if (run.status !== "queued" && run.status !== "running") run.status = "paused";
    }

    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return { run, requiresReapproval };
  }

  private async recordLogUnsafe(runId: string, input: { level: RunLog["level"]; message: string }): Promise<Run> {
    const run = await this.get(runId);
    const now = new Date().toISOString();
    run.logs.push({ id: randomUUID(), ...input, createdAt: now });
    this.appendTimeline(run, "log", input.message, now);
    await this.persist();
    return run;
  }

  private async recordReviewUnsafe(runId: string, input: { status: ReviewIndex["status"]; summary: string }): Promise<Run> {
    const run = await this.get(runId);
    const now = new Date().toISOString();
    // Timeline-only note: never gates acceptance (kind is not independent; no findings/evidence).
    run.reviews.push({ id: randomUUID(), ...input, createdAt: now, kind: "timeline" });
    this.appendTimeline(run, "review", `时间线备注：${input.summary}`, now);
    await this.persist();
    return run;
  }

  private async applyStructuredReviewUnsafe(runId: string, input: StructuredReviewInput): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "Independent review");
    if (run.status !== "awaiting_review") {
      throw new Error("Structured review requires a Run that is awaiting review.");
    }
    if (run.execution.status !== "succeeded") {
      throw new Error("Structured review requires a succeeded execution.");
    }
    if (input.status !== "passed" && input.status !== "changes_requested") {
      throw new Error("Review conclusion is invalid.");
    }
    if (!Array.isArray(input.findings) || !Array.isArray(input.evidence)) {
      throw new Error("Independent review requires structured findings and evidence.");
    }
    const summary = input.summary.trim();
    if (!summary) throw new Error("A review summary is required.");
    const loop = this.ensureReviewLoop(run);
    const now = new Date().toISOString();
    const review: ReviewIndex = {
      id: randomUUID(),
      status: input.status,
      summary,
      createdAt: now,
      kind: "independent",
      severity: input.severity,
      evidence: [...input.evidence],
      fixScope: input.fixScope?.trim() || undefined,
      findings: input.findings.map((finding) => ({ ...finding })),
      cycle: input.cycle,
      role: "reviewer"
    };
    run.reviews.push(review);
    loop.latestReviewId = review.id;
    loop.userAccepted = undefined;
    loop.userAcceptanceSummary = undefined;
    loop.reworkRequested = undefined;
    this.appendTimeline(
      run,
      "review",
      `Reviewer（独立）：${summary}${input.fixScope ? `；修复范围：${input.fixScope}` : ""}`,
      now
    );
    if (input.status === "passed") {
      run.status = "awaiting_acceptance";
      this.appendTimeline(run, "agent_status", "独立审查通过；等待用户最终验收。", now);
      await this.persist();
      await this.todos.update(run.todoId, { status: "awaiting_acceptance" });
      return run;
    }
    this.appendTimeline(run, "agent_status", "独立审查未通过；Firstmate 可派发至多一次自动修复，或由用户授权再次修复。", now);
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return run;
  }

  private async prepareReviewFixUnsafe(
    runId: string,
    instruction: string,
    options: { userAuthorized?: boolean } = {}
  ): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "Review fix dispatch");
    const loop = this.ensureReviewLoop(run);
    const gating = this.resolveGatingReview(run);
    const userAuthorized = options.userAuthorized === true;
    const changesRequested = gating?.status === "changes_requested";
    const reworkAfterReject = loop.reworkRequested === true
      && (run.status === "awaiting_acceptance" || run.status === "awaiting_review" || run.status === "queued" || run.status === "paused" || run.status === "failed");
    if (!changesRequested && !(userAuthorized && reworkAfterReject)) {
      if (!gating) throw new Error("An independent Reviewer changes_requested conclusion is required before Firstmate can dispatch a fix.");
      if (gating.status === "passed" && !userAuthorized) {
        throw new Error("Automatic fix requires a changes_requested independent review; use a user-authorized fix after rejection.");
      }
      throw new Error("A changes_requested independent review is required before Firstmate can dispatch a fix.");
    }
    if (!userAuthorized && loop.autoFixCyclesUsed >= loop.maxAutoFixCycles) {
      throw new Error("Automatic fix cycle limit reached; user must authorize an additional fix or start a new Run.");
    }
    const normalized = instruction.trim();
    if (!normalized) throw new Error("A fix instruction is required.");
    if (!run.execution.selectedAgent) {
      throw new Error("An original Professional Agent is required for review fix dispatch.");
    }
    // Idempotent re-dispatch while waiting for write-session approval keeps the same instruction.
    if (run.reviewLoop?.pendingFixInstruction && run.execution.pendingApproval?.status === "awaiting_confirmation") {
      return run;
    }
    const now = new Date().toISOString();
    if (!userAuthorized) loop.autoFixCyclesUsed += 1;
    loop.pendingFixInstruction = normalized;
    loop.reworkRequested = undefined;
    run.execution.status = "failed";
    run.execution.retryable = true;
    run.execution.lastError = "独立审查要求修复。";
    run.execution.activeStep = undefined;
    // Queued so Firstmate can immediately restart the original agent without a separate resume step.
    run.status = "queued";
    this.appendTimeline(
      run,
      "agent_status",
      userAuthorized
        ? "用户授权再次修复；Firstmate 已将问题派发给原专业代理。"
        : `Firstmate 已将明确问题派发给原专业代理（自动修复 ${loop.autoFixCyclesUsed}/${loop.maxAutoFixCycles}）。`,
      now
    );
    // Persist the fix instruction as a user-visible correction message so the original agent receives it.
    this.appendMessage(run, normalized, now);
    // appendMessage already writes a user_message timeline event; add an explicit correction marker.
    this.appendTimeline(run, "correction", "Firstmate 审查修复派发（Reviewer 未修改成果）。", now);
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return run;
  }

  private async rollbackUnusedAutoFixCycleUnsafe(runId: string): Promise<Run> {
    const run = await this.get(runId);
    const loop = this.ensureReviewLoop(run);
    if (loop.autoFixCyclesUsed > 0 && run.execution.pendingApproval?.status === "awaiting_confirmation") {
      loop.autoFixCyclesUsed -= 1;
      this.appendTimeline(
        run,
        "agent_status",
        "修复会话尚未真正启动（等待写入确认）；未消耗自动修复次数。",
        new Date().toISOString()
      );
      await this.persist();
    }
    return run;
  }

  private async acceptReviewOutcomeUnsafe(runId: string, summary: string): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "User acceptance");
    if (run.status !== "awaiting_acceptance") {
      throw new Error("User acceptance requires a Run that is awaiting acceptance after a passed review.");
    }
    const gating = this.resolveGatingReview(run);
    if (!gating || gating.status !== "passed" || gating.kind !== "independent") {
      throw new Error("User acceptance requires a passed independent structured review.");
    }
    // User may re-accept after a prior reject (change of mind) until rework execution starts.
    if (run.reviewLoop?.pendingFixInstruction) {
      throw new Error("A review fix is in progress; wait for re-review before acceptance.");
    }
    const normalized = summary.trim();
    if (!normalized) throw new Error("An acceptance summary is required.");
    const loop = this.ensureReviewLoop(run);
    const now = new Date().toISOString();
    loop.userAccepted = true;
    loop.userAcceptanceSummary = normalized;
    loop.reworkRequested = undefined;
    run.approvals.push({ id: randomUUID(), decision: "approved", summary: normalized, createdAt: now });
    run.status = "completed";
    this.appendTimeline(run, "approval", `用户接受成果：${normalized}`, now);
    this.appendTimeline(run, "agent_status", "审查通过且用户已验收；Run 正式完成。", now);
    await this.persist();
    await this.todos.update(run.todoId, { status: "completed", formalAcceptance: true });
    return run;
  }

  private async rejectReviewOutcomeUnsafe(runId: string, summary: string): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "User acceptance rejection");
    if (run.status !== "awaiting_acceptance") {
      throw new Error("Only a Run awaiting acceptance can be rejected by the user.");
    }
    const gating = this.resolveGatingReview(run);
    if (!gating || gating.status !== "passed" || gating.kind !== "independent") {
      throw new Error("User rejection of acceptance requires a passed independent structured review first.");
    }
    const normalized = summary.trim();
    if (!normalized) throw new Error("A rejection summary is required.");
    const loop = this.ensureReviewLoop(run);
    const now = new Date().toISOString();
    loop.userAccepted = false;
    loop.userAcceptanceSummary = normalized;
    // Allow user-authorized rework without counting against the automatic fix cycle budget.
    loop.reworkRequested = true;
    run.approvals.push({ id: randomUUID(), decision: "returned", summary: normalized, createdAt: now });
    // Leave formal acceptance; user may still accept later or authorize rework.
    run.status = "awaiting_acceptance";
    this.appendTimeline(run, "approval", `用户未接受成果：${normalized}`, now);
    this.appendTimeline(
      run,
      "agent_status",
      "用户未接受；Todo 与 Run 不得标记为完成。可再次接受，或授权用户修复后复审。",
      now
    );
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_acceptance" });
    return run;
  }

  /** Only independent structured reviews recorded via applyStructuredReview gate acceptance. */
  private resolveGatingReview(run: Run): ReviewIndex | undefined {
    const latestId = run.reviewLoop?.latestReviewId;
    if (!latestId) return undefined;
    const review = run.reviews.find((entry) => entry.id === latestId);
    if (!review || review.kind !== "independent" || review.role !== "reviewer") return undefined;
    if (!Array.isArray(review.findings) || !Array.isArray(review.evidence)) return undefined;
    return review;
  }

  private ensureReviewLoop(run: Run): RunReviewLoop {
    if (!run.reviewLoop) {
      run.reviewLoop = { autoFixCyclesUsed: 0, maxAutoFixCycles: 1 };
    }
    if (typeof run.reviewLoop.maxAutoFixCycles !== "number" || run.reviewLoop.maxAutoFixCycles < 1) {
      run.reviewLoop.maxAutoFixCycles = 1;
    }
    if (typeof run.reviewLoop.autoFixCyclesUsed !== "number" || run.reviewLoop.autoFixCyclesUsed < 0) {
      run.reviewLoop.autoFixCyclesUsed = 0;
    }
    return run.reviewLoop;
  }

  private async recordArtifactUnsafe(runId: string, input: { path: string; kind: string }): Promise<Run> {
    const run = await this.assertExecutionAuthorized(runId, "Formal Artifact registration");
    if (run.execution.status !== "idle") this.assertActiveProfessionalExecution(run);
    const now = new Date().toISOString();
    run.artifacts.push({ id: randomUUID(), ...input, createdAt: now });
    this.appendTimeline(run, "artifact", input.path, now);
    await this.persist();
    return run;
  }

  private async recordCodexWorktreeArtifactsUnsafe(
    runId: string,
    input: {
      evidence: WorktreeArtifactEvidence;
      changedFiles: string[];
    }
  ): Promise<Run> {
    const run = await this.get(runId);
    this.assertTerminationConfirmed(run, "Codex Worktree Artifact indexing");
    this.assertApprovedPlan(run, "Codex Worktree Artifact indexing");
    const evidence = input.evidence;
    if (evidence.source !== "codex-worktree" || evidence.worktreeRunId !== runId) {
      throw new Error("Codex Worktree evidence must be bound to the current Run.");
    }
    const now = new Date().toISOString();
    // Drop prior Codex worktree index entries so re-runs replace rather than accumulate fakes.
    run.artifacts = run.artifacts.filter(
      (artifact) =>
        artifact.kind !== CODEX_WORKTREE_EVIDENCE_KIND
        && artifact.kind !== CODEX_WORKTREE_FILE_KIND
        && artifact.evidence?.source !== "codex-worktree"
    );

    const bundlePath = `worktree/${runId}`;
    run.artifacts.push({
      id: randomUUID(),
      path: bundlePath,
      kind: CODEX_WORKTREE_EVIDENCE_KIND,
      createdAt: now,
      evidence: { ...evidence, changedFiles: [...evidence.changedFiles] }
    });
    this.appendTimeline(run, "artifact", evidence.summary, now);

    if (evidence.changeStatus === "modified") {
      for (const filePath of input.changedFiles) {
        const normalized = filePath.trim();
        if (!normalized) continue;
        run.artifacts.push({
          id: randomUUID(),
          path: normalized,
          kind: CODEX_WORKTREE_FILE_KIND,
          createdAt: now,
          evidence: {
            ...evidence,
            changedFiles: [normalized],
            // Per-file entries keep identity only; full diff lives on the evidence bundle.
            diff: undefined,
            verificationResults: evidence.verificationResults
          }
        });
        this.appendTimeline(run, "artifact", `Worktree 修改：${normalized}`, now);
      }
    } else {
      this.appendTimeline(run, "agent_status", "Codex Worktree 无实际修改；未登记虚假成果 Artifact。", now);
    }

    run.updatedAt = now;
    await this.persist();
    return run;
  }

  private async markWorktreeArtifactsDiscardedUnsafe(runId: string): Promise<Run> {
    const run = await this.get(runId);
    const now = new Date().toISOString();
    let changed = false;
    for (const artifact of run.artifacts) {
      if (artifact.evidence?.source !== "codex-worktree" || artifact.evidence.worktreeRunId !== runId) continue;
      artifact.evidence = {
        ...artifact.evidence,
        discarded: true,
        sessionStatus: "discarded",
        consistency: "ok",
        consistencyNote: "隔离 Worktree 已放弃；历史 Diff 与证据保留。",
        summary: artifact.evidence.changeStatus === "no_modification"
          ? "隔离 Worktree 已放弃（原本无修改）。"
          : `${artifact.evidence.summary}（已放弃）`
      };
      changed = true;
    }
    if (changed) {
      this.appendTimeline(run, "artifact", "隔离 Worktree 已放弃；相关 Artifact 保留历史并标记为已丢弃。", now);
      run.updatedAt = now;
      await this.persist();
    }
    return run;
  }

  private async reconcileWorktreeArtifactConsistencyUnsafe(
    runId: string,
    input: { sessionStatus: "active" | "discarded" | "missing"; consistency: "ok" | "missing_worktree" | "stale"; consistencyNote?: string }
  ): Promise<Run> {
    const run = await this.get(runId);
    const now = new Date().toISOString();
    let changed = false;
    for (const artifact of run.artifacts) {
      if (artifact.evidence?.source !== "codex-worktree" || artifact.evidence.worktreeRunId !== runId) continue;
      const nextNote = input.consistencyNote ?? artifact.evidence.consistencyNote;
      if (
        artifact.evidence.sessionStatus === input.sessionStatus
        && artifact.evidence.consistency === input.consistency
        && artifact.evidence.consistencyNote === nextNote
      ) {
        continue;
      }
      artifact.evidence = {
        ...artifact.evidence,
        sessionStatus: input.sessionStatus,
        consistency: input.consistency,
        consistencyNote: nextNote,
        discarded: input.sessionStatus === "discarded" ? true : artifact.evidence.discarded
      };
      changed = true;
    }
    if (changed) {
      if (input.consistency === "missing_worktree") {
        this.appendTimeline(
          run,
          "agent_status",
          input.consistencyNote ?? "Worktree 已缺失；Artifact 索引标记为失效，请恢复隔离区或重新执行。",
          now
        );
      }
      run.updatedAt = now;
      await this.persist();
    }
    return run;
  }

  /**
   * AI Firstmate/Secondmate when configured; deterministic template only as fallback.
   * Never mutates formal files; approval gates remain enforced by existing Run APIs.
   */
  private async applyPlanningPipeline(
    run: Run,
    subject: { title: string; description?: string },
    now: string,
    options: {
      taskType?: TaskType;
      requiredCapabilities?: string[];
      verificationCommands?: string[][];
      revisionNote?: string;
    } = {}
  ): Promise<void> {
    run.status = "planning";
    if (this.aiPlanning) {
      const project = this.resolveProject ? await this.resolveProject(run.todoId) : undefined;
      const outcome = await this.aiPlanning.plan({
        runId: run.id,
        todo: subject,
        messages: run.messages,
        project,
        revisionNote: options.revisionNote,
        overrides: {
          taskType: options.taskType,
          requiredCapabilities: options.requiredCapabilities
        }
      });

      if (outcome.status === "awaiting_approval") {
        run.planning = {
          assessment: toTaskAssessment(outcome.assessment),
          approvalStatus: "awaiting_approval",
          verificationCommands: options.verificationCommands
            ?? outcome.plan.verificationCommands
            ?? defaultVerificationCommands(outcome.assessment.taskType)
        };
        this.appendFirstmateAssessment(run, now);
        this.pushPlanVersion(run, outcome.plan, now, options.revisionNote);
        run.status = "awaiting_plan_approval";
        return;
      }

      if (outcome.status === "awaiting_input") {
        run.planning = {
          assessment: toTaskAssessment(outcome.assessment),
          approvalStatus: "awaiting_input",
          verificationCommands: options.verificationCommands
            ?? defaultVerificationCommands(outcome.assessment.taskType)
        };
        this.appendFirstmateAssessment(run, now);
        this.raiseCriticalInputAsk(run, outcome.assessment.criticalInputs, now);
        return;
      }

      // Model failure / insufficient evidence: pause clearly — do not fabricate a template plan.
      if (outcome.assessment) {
        run.planning = {
          assessment: toTaskAssessment(outcome.assessment),
          approvalStatus: "awaiting_input",
          verificationCommands: options.verificationCommands
            ?? defaultVerificationCommands(outcome.assessment.taskType)
        };
        this.appendFirstmateAssessment(run, now);
      }
      run.status = "paused";
      this.appendTimeline(run, "agent_status", `规划已暂停：${outcome.reason}`, now);
      if (outcome.evidenceGaps?.length) {
        this.appendTimeline(run, "agent_status", `证据缺口：${outcome.evidenceGaps.join("；")}`, now);
      }
      return;
    }

    // Template fallback when API roles / AiPlanningService are not available.
    this.applyTemplatePlanning(run, subject, now, options);
  }

  private applyTemplatePlanning(
    run: Run,
    subject: { title: string; description?: string },
    now: string,
    options: {
      taskType?: TaskType;
      requiredCapabilities?: string[];
      verificationCommands?: string[][];
      revisionNote?: string;
    }
  ): void {
    const assessment = assessTask(
      {
        ...subject,
        instructions: run.messages.map((message) => message.content).join("\n")
      },
      { taskType: options.taskType, requiredCapabilities: options.requiredCapabilities }
    );
    run.planning = {
      assessment,
      approvalStatus: assessment.criticalInputs.length > 0 ? "awaiting_input" : "awaiting_approval",
      verificationCommands: options.verificationCommands ?? defaultVerificationCommands(assessment.taskType)
    };
    this.appendFirstmateAssessment(run, now);
    if (assessment.criticalInputs.length > 0) {
      this.raiseCriticalInputAsk(run, assessment.criticalInputs, now);
      return;
    }
    run.status = "awaiting_plan_approval";
    this.pushPlanVersion(run, generateSecondmatePlan(assessment, options.revisionNote), now, options.revisionNote);
  }

  private raiseCriticalInputAsk(run: Run, criticalInputs: string[], now: string): void {
    const card = criticalInputsToAskUser(criticalInputs);
    const previousStatus = run.status === "waiting_for_user"
      ? (run.waitingForUserResume?.previousStatus ?? "planning")
      : (run.status === "planning" ? "planning" : run.status);
    const { requests, created, mergedInto } = enqueueAskUser(run.askUserRequests ?? [], {
      kind: "ask_user",
      prompt: card.prompt,
      reason: card.reason,
      recommendedAnswer: card.recommendedAnswer,
      recommendationRationale: card.recommendationRationale,
      inputMode: "free_text",
      required: true,
      source: { agent: "firstmate", stepKey: "planning.critical_input", label: "Firstmate 关键输入" }
    }, now);
    run.askUserRequests = requests;
    if (mergedInto) {
      this.appendTimeline(run, "ask_user", `Firstmate 合并关键输入问题（恢复位置：${mergedInto.source.stepKey}）`, now);
    } else {
      this.appendTimeline(
        run,
        "ask_user",
        `ask_user 来自 firstmate：${created.prompt}（原因：${created.reason}；恢复位置：${created.source.stepKey}）`,
        now
      );
    }
    if (!run.waitingForUserResume) {
      run.waitingForUserResume = { previousStatus, since: now };
    }
    run.status = "waiting_for_user";
    this.appendTimeline(run, "agent_status", "Run 进入 waiting_for_user；在用户回答前不会继续消耗模型或执行后续步骤。", now);
  }

  private supersedeAsksForStep(run: Run, stepKey: string, now: string, summary: string): void {
    if (!run.askUserRequests?.length) return;
    let changed = false;
    run.askUserRequests = run.askUserRequests.map((entry) => {
      if ((entry.status === "pending" || entry.status === "queued") && entry.source.stepKey === stepKey) {
        changed = true;
        return { ...entry, status: "superseded" as const };
      }
      return entry;
    });
    if (changed) {
      this.appendTimeline(run, "ask_user", summary, now);
    }
    if (!hasPendingAskUser(run.askUserRequests)) {
      run.waitingForUserResume = undefined;
    }
  }

  private appendFirstmateAssessment(run: Run, now: string): void {
    const assessment = run.planning?.assessment;
    if (!assessment) return;
    const summary = `Firstmate 识别：${assessment.taskType}；所需能力：${assessment.requiredCapabilities.join("、") || "无"}。`;
    this.appendTimeline(run, "agent_status", summary, now);
    if (assessment.criticalInputs.length > 0) {
      this.appendTimeline(run, "agent_status", `仅等待关键输入：${assessment.criticalInputs.join("；")}`, now);
    } else {
      this.appendTimeline(run, "agent_status", `一般缺失按假设继续：${assessment.assumptions.join("；")}`, now);
    }
  }

  /** Generate Secondmate plan (AI preferred) and append a version with optional diff. */
  private async appendGeneratedPlan(run: Run, now: string, revisionNote?: string): Promise<void> {
    if (!run.planning) throw new Error("Firstmate assessment is required before generating a plan.");

    if (this.aiPlanning) {
      const todo = await this.todos.get(run.todoId);
      const project = this.resolveProject ? await this.resolveProject(run.todoId) : undefined;
      const outcome = await this.aiPlanning.plan({
        runId: run.id,
        todo: { title: todo.title, description: todo.description },
        messages: run.messages,
        project,
        revisionNote,
        overrides: {
          taskType: run.planning.assessment.taskType,
          requiredCapabilities: run.planning.assessment.requiredCapabilities
        }
      });
      if (outcome.status === "awaiting_approval") {
        run.planning.assessment = toTaskAssessment(outcome.assessment);
        run.planning.verificationCommands = outcome.plan.verificationCommands
          ?? run.planning.verificationCommands
          ?? defaultVerificationCommands(outcome.assessment.taskType);
        this.pushPlanVersion(run, outcome.plan, now, revisionNote);
        return;
      }
      if (outcome.status === "awaiting_input") {
        run.planning.assessment = toTaskAssessment(outcome.assessment);
        run.planning.approvalStatus = "awaiting_input";
        this.raiseCriticalInputAsk(run, outcome.assessment.criticalInputs, now);
        return;
      }
      run.status = "paused";
      this.appendTimeline(run, "agent_status", `计划修订暂停：${outcome.reason}`, now);
      return;
    }

    this.pushPlanVersion(
      run,
      generateSecondmatePlan(run.planning.assessment, revisionNote),
      now,
      revisionNote
    );
  }

  private pushPlanVersion(
    run: Run,
    generated: GeneratedPlan | AiGeneratedPlan,
    now: string,
    revisionNote?: string
  ): void {
    if (!run.planning) throw new Error("Firstmate assessment is required before generating a plan.");
    const previous = run.planVersions.at(-1);
    const version = Math.max(0, ...run.planVersions.map((plan) => plan.version)) + 1;
    const plan: PlanVersionIndex = {
      version,
      createdAt: now,
      summary: generated.summary,
      complexity: generated.complexity,
      steps: generated.steps,
      acceptanceCriteria: generated.acceptanceCriteria,
      risks: generated.risks,
      prohibitions: generated.prohibitions,
      generatedBy: "secondmate",
      revisionNote: revisionNote?.trim() || generated.revisionNote,
      verificationCommands: run.planning.verificationCommands
        ?? generated.verificationCommands
        ?? defaultVerificationCommands(run.planning.assessment.taskType),
      dependencies: generated.dependencies,
      expectedArtifacts: generated.expectedArtifacts,
      allowedScope: generated.allowedScope,
      verificationMethods: generated.verificationMethods
    };
    if (previous) {
      plan.diffFromPrevious = computePlanVersionDiff(previous, plan);
      this.appendTimeline(
        run,
        "plan_version",
        `Secondmate 计划 v${plan.version}：${plan.summary}（相对 v${previous.version} 变更字段 ${plan.diffFromPrevious.changedFieldCount} 项）`,
        now
      );
    } else {
      this.appendTimeline(run, "plan_version", `Secondmate 计划 v${plan.version}：${plan.summary}`, now);
    }
    run.planVersions.push(plan);
  }

  private assertApprovedPlan(run: Run, operation: string): void {
    if (run.planning?.approvalStatus !== "approved" || !run.planning.approvedPlanVersion) {
      throw new Error(`${operation} requires an approved plan.`);
    }
  }

  private assertActiveProfessionalExecution(run: Run): void {
    if (run.execution.status !== "running" || run.status !== "running") {
      throw new Error("Run is not actively executing.");
    }
  }

  private async interruptProfessionalExecution(run: Run, reason: string, retryable: boolean, now: string): Promise<void> {
    if (run.execution.status !== "running") return;
    const activeStep = run.execution.activeStep;
    run.execution.status = "failed";
    run.execution.retryable = retryable;
    run.execution.lastError = reason;
    run.execution.completedAt = now;
    run.logs.push({ id: randomUUID(), level: "warn", message: reason, createdAt: now });
    this.appendTimeline(run, "log", reason, now);
    if (activeStep) {
      this.appendCheckpoint(run, {
        step: activeStep,
        stepStatus: "interrupted",
        summary: reason,
        workspaceFingerprint: createEmptyFingerprint(now),
        actionKind: actionKindFromStep(activeStep),
        dangerous: isDangerousActionKind(actionKindFromStep(activeStep))
      }, now);
      run.execution.activeStep = undefined;
    } else if (retryable) {
      this.markRecoveryReady(run, now, "执行中断后可从最近检查点恢复。");
    }
    const results = await Promise.allSettled(
      [...this.executionInterruptionHandlers].map(async (handler) => handler(run.id))
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("无法确认执行进程已终止；Run 已暂停，需先处理该进程后再继续。");
    }
  }

  private appendCheckpoint(
    run: Run,
    input: {
      step: string;
      stepStatus: CheckpointStepStatus;
      summary: string;
      nextStep?: string;
      workspaceFingerprint: WorkspaceFingerprint;
      actionKind: CheckpointActionKind;
      dangerous: boolean;
    },
    now: string
  ): RunCheckpoint {
    if (!run.checkpoints) run.checkpoints = [];
    const checkpoint: RunCheckpoint = {
      id: randomUUID(),
      sequence: run.checkpoints.length + 1,
      createdAt: now,
      step: input.step,
      stepStatus: input.stepStatus,
      summary: input.summary,
      completedSteps: [...run.execution.completedSteps],
      artifactPaths: run.artifacts.map((artifact) => artifact.path),
      nextStep: input.nextStep,
      workspaceFingerprint: input.workspaceFingerprint,
      actionKind: input.actionKind,
      dangerous: input.dangerous,
      recoveryMode: "reconstruct_and_replay"
    };
    run.checkpoints.push(checkpoint);
    this.appendTimeline(
      run,
      "checkpoint",
      `检查点 #${checkpoint.sequence} ${checkpoint.stepStatus}：${checkpoint.step} — ${checkpoint.summary}`,
      now
    );
    run.checkpointRecovery = {
      status: input.stepStatus === "completed"
        ? (run.checkpointRecovery?.status === "conflict" ? "conflict" : "ready")
        : input.dangerous && input.stepStatus === "interrupted"
          ? "awaiting_dangerous_reapproval"
          : "ready",
      lastCheckpointId: checkpoint.id,
      interruptedStep: input.stepStatus === "interrupted" || input.stepStatus === "failed" ? input.step : run.checkpointRecovery?.interruptedStep,
      conflictReason: run.checkpointRecovery?.conflictReason,
      requiresDangerousReapproval: input.dangerous && input.stepStatus === "interrupted",
      dangerousReplayApproved: input.dangerous && input.stepStatus === "interrupted"
        ? false
        : run.checkpointRecovery?.dangerousReplayApproved,
      recoveryNote: CHECKPOINT_RECOVERY_NOTE
    };
    return checkpoint;
  }

  private markRecoveryReady(run: Run, now: string, summary: string): void {
    const latest = run.checkpoints.at(-1);
    const dangerousPending = Boolean(
      latest?.dangerous && latest.stepStatus === "interrupted" && !run.checkpointRecovery?.dangerousReplayApproved
    );
    run.checkpointRecovery = {
      status: dangerousPending ? "awaiting_dangerous_reapproval" : "ready",
      lastCheckpointId: latest?.id,
      interruptedStep: run.checkpointRecovery?.interruptedStep
        ?? (latest?.stepStatus === "interrupted" ? latest.step : undefined)
        ?? run.execution.activeStep,
      requiresDangerousReapproval: dangerousPending,
      dangerousReplayApproved: run.checkpointRecovery?.dangerousReplayApproved,
      recoveryNote: CHECKPOINT_RECOVERY_NOTE
    };
    this.appendTimeline(run, "checkpoint", summary, now);
  }

  private toInterruptedSummary(run: Run): InterruptedRunSummary {
    const failedSteps = run.checkpoints
      .filter((checkpoint) => checkpoint.stepStatus === "failed" || checkpoint.stepStatus === "interrupted")
      .map((checkpoint) => checkpoint.step);
    const latestInterrupted = [...run.checkpoints].reverse().find((checkpoint) => checkpoint.stepStatus === "interrupted");
    return {
      runId: run.id,
      todoId: run.todoId,
      status: run.status,
      attempt: run.attempt,
      completedSteps: [...run.execution.completedSteps],
      interruptedStep: latestInterrupted?.step ?? run.checkpointRecovery?.interruptedStep,
      failedSteps: [...new Set(failedSteps)],
      latestCheckpoint: run.checkpoints.at(-1),
      checkpointRecovery: run.checkpointRecovery,
      updatedAt: run.updatedAt
    };
  }

  private async pauseForWorkspaceConflict(
    run: Run,
    baseline: RunCheckpoint,
    interruptedStep: string | undefined,
    interruptedMeta: { dangerous?: boolean } | undefined,
    conflictReason: string,
    now: string
  ): Promise<CheckpointResumeResult> {
    run.status = "paused";
    run.execution.retryable = true;
    if (run.execution.status !== "failed") run.execution.status = "failed";
    run.checkpointRecovery = {
      status: "conflict",
      lastCheckpointId: baseline.id,
      interruptedStep,
      conflictReason,
      requiresDangerousReapproval: Boolean(interruptedMeta?.dangerous),
      dangerousReplayApproved: run.checkpointRecovery?.dangerousReplayApproved,
      recoveryNote: CHECKPOINT_RECOVERY_NOTE
    };
    this.appendTimeline(run, "checkpoint", conflictReason, now);
    this.appendTimeline(run, "agent_status", conflictReason, now);
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
    return {
      run,
      canContinue: false,
      conflict: true,
      requiresDangerousReapproval: Boolean(interruptedMeta?.dangerous),
      reason: conflictReason
    };
  }

  private markInterruptionFailure(run: Run, error: unknown, now: string): void {
    const message = error instanceof Error
      ? error.message
      : "无法确认执行进程已终止；Run 已暂停，需先处理该进程后再继续。";
    run.execution.retryable = false;
    run.execution.terminationUnconfirmed = true;
    run.execution.lastError = message;
    run.execution.completedAt = now;
    run.status = "paused";
    run.logs.push({ id: randomUUID(), level: "error", message, createdAt: now });
    this.appendTimeline(run, "log", message, now);
    this.appendTimeline(run, "agent_status", "执行进程终止未确认；Run 保持暂停，不会继续或标记为已取消。", now);
  }

  private async persistInterruptionFailure(run: Run, error: unknown, now: string): Promise<void> {
    this.markInterruptionFailure(run, error, now);
    await this.persist();
    await this.todos.update(run.todoId, { status: "awaiting_confirmation" });
  }

  private assertTerminationConfirmed(run: Run, operation: string): void {
    if (run.execution.terminationUnconfirmed) {
      throw new Error(`${operation} is blocked because the prior process termination is unconfirmed.`);
    }
  }

  private appendMessage(run: Run, content: string, now: string): void {
    run.messages.push({ id: randomUUID(), role: "user", content, createdAt: now });
    this.appendTimeline(run, "user_message", content, now);
  }

  private appendTimeline(run: Run, kind: TimelineKind, summary: string, now: string): void {
    run.timeline.push({ id: randomUUID(), kind, summary, createdAt: now });
    run.updatedAt = now;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: constants.S_IRUSR | constants.S_IWUSR
    });
    await rename(temporaryPath, this.statePath);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: (() => void) | undefined;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function toTaskAssessment(assessment: AiTaskAssessment | TaskAssessment): TaskAssessment {
  return {
    taskType: assessment.taskType,
    requiredCapabilities: assessment.requiredCapabilities,
    criticalInputs: assessment.criticalInputs,
    assumptions: assessment.assumptions,
    complexity: assessment.complexity,
    rationale: "rationale" in assessment ? assessment.rationale : undefined,
    evidenceGaps: "evidenceGaps" in assessment ? assessment.evidenceGaps : undefined,
    insufficientEvidence: "insufficientEvidence" in assessment ? assessment.insufficientEvidence : undefined,
    contextUsage: "contextUsage" in assessment ? assessment.contextUsage : undefined
  };
}

function formatAskAnswerSummary(request: AskUserRequest): string {
  const answer = request.answer;
  if (!answer) return "(空)";
  const parts: string[] = [];
  if (answer.selectedOptionIds?.length) {
    const labels = (request.options ?? [])
      .filter((option) => answer.selectedOptionIds!.includes(option.id))
      .map((option) => option.label);
    parts.push(`选项=${labels.join("、") || answer.selectedOptionIds.join(",")}`);
  }
  if (answer.freeText) parts.push(`文本=${answer.freeText}`);
  if (answer.replanFeedback) parts.push(`修订反馈=${answer.replanFeedback}`);
  if (answer.approved !== undefined) parts.push(answer.approved ? "批准" : "拒绝");
  return parts.join("；") || "(空)";
}

function normalizeCapabilities(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function validVerificationCommands(commands: string[][]): boolean {
  return commands.every((command) => command.length > 0 && command.every((part) => part.trim().length > 0));
}

function isExecutionApprovalKind(value: string): value is ExecutionApprovalKind {
  return ["outside_workspace", "delete_file", "system_install", "external_send", "unapproved_skill", "unapproved_tool", "unsupported_operation"].includes(value);
}

function isCorrectionChangeKind(value: string): value is CorrectionChangeKind {
  return ["minor", "goal", "scope", "acceptance", "prohibition"].includes(value);
}

function correctionRequiresReapproval(instruction: string, changeKind?: CorrectionChangeKind): boolean {
  if (changeKind && changeKind !== "minor") return true;
  return /(目标|范围|验收|禁止|goal|scope|acceptance|prohibition)/i.test(instruction);
}

function isRecoveryWorthyRun(run: Run): boolean {
  if (run.status === "completed" || run.status === "cancelled") return false;
  if (run.status === "interrupted" || run.status === "paused") return true;
  if (run.execution.status === "failed" && run.execution.retryable) return true;
  const recovery = run.checkpointRecovery?.status;
  return recovery === "conflict" || recovery === "awaiting_dangerous_reapproval";
}

function normalizeCheckpointRecovery(
  value: CheckpointRecoveryState | undefined,
  checkpoints: RunCheckpoint[]
): CheckpointRecoveryState | undefined {
  if (!value && checkpoints.length === 0) return undefined;
  if (!value) {
    const latest = checkpoints.at(-1);
    return {
      status: latest ? "ready" : "none",
      lastCheckpointId: latest?.id,
      interruptedStep: [...checkpoints].reverse().find((entry) => entry.stepStatus === "interrupted")?.step,
      requiresDangerousReapproval: Boolean(latest?.dangerous && latest.stepStatus === "interrupted"),
      recoveryNote: CHECKPOINT_RECOVERY_NOTE
    };
  }
  return {
    status: value.status ?? "none",
    lastCheckpointId: value.lastCheckpointId,
    interruptedStep: value.interruptedStep,
    conflictReason: value.conflictReason,
    requiresDangerousReapproval: Boolean(value.requiresDangerousReapproval),
    dangerousReplayApproved: value.dangerousReplayApproved,
    recoveryNote: value.recoveryNote?.trim() || CHECKPOINT_RECOVERY_NOTE
  };
}

function dangerousApprovalKind(actionKind: CheckpointActionKind | string): ExecutionApprovalKind {
  if (actionKind === "delete_file" || actionKind === "overwrite_file") return "delete_file";
  if (actionKind === "system_install") return "system_install";
  if (actionKind === "external_send") return "external_send";
  return "unsupported_operation";
}
