import { createJsonRequest } from "./apiClient.js";

export type RunStatus =
  | "created"
  | "planning"
  | "waiting_for_user"
  | "awaiting_plan_approval"
  | "queued"
  | "running"
  | "paused"
  | "awaiting_review"
  | "awaiting_acceptance"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TaskType = "implementation" | "bug_fix" | "research" | "writing" | "analysis" | "automation" | "other";
export type PlanApprovalStatus = "awaiting_input" | "awaiting_approval" | "approved" | "cancelled";

export interface PlanningContextUsageRecord {
  projectFacts?: string[];
  files?: string[];
  assumptions?: string[];
  workspaceSummary?: string;
  instructionSources?: string[];
  omittedBecauseUnnecessary?: string[];
}

export interface TaskAssessmentRecord {
  taskType: TaskType;
  requiredCapabilities: string[];
  criticalInputs: string[];
  assumptions: string[];
  complexity: "low" | "medium" | "high";
  /** Present when AI Firstmate recorded why/how it classified the task. */
  rationale?: string;
  contextUsage?: PlanningContextUsageRecord;
  evidenceGaps?: string[];
  insufficientEvidence?: boolean;
}

export interface RunPlanningRecord {
  assessment: TaskAssessmentRecord;
  approvalStatus: PlanApprovalStatus;
  approvedPlanVersion?: number;
  verificationCommands?: string[][];
}

export interface PlanVersionDiffRecord {
  fromVersion: number;
  toVersion: number;
  summaryChanged: boolean;
  complexityChanged: boolean;
  stepsAdded: string[];
  stepsRemoved: string[];
  acceptanceAdded: string[];
  acceptanceRemoved: string[];
  risksAdded: string[];
  risksRemoved: string[];
  prohibitionsAdded: string[];
  prohibitionsRemoved: string[];
  dependenciesAdded: string[];
  dependenciesRemoved: string[];
  expectedArtifactsAdded: string[];
  expectedArtifactsRemoved: string[];
  allowedScopeAdded: string[];
  allowedScopeRemoved: string[];
  verificationMethodsAdded: string[];
  verificationMethodsRemoved: string[];
  changedFieldCount: number;
}

export interface PlanVersionRecord {
  version: number;
  summary: string;
  complexity?: "low" | "medium" | "high";
  steps?: string[];
  acceptanceCriteria?: string[];
  risks?: string[];
  prohibitions?: string[];
  generatedBy?: "secondmate";
  revisionNote?: string;
  verificationCommands?: string[][];
  /** AI Secondmate structured plan fields (optional for legacy template plans). */
  dependencies?: string[];
  expectedArtifacts?: string[];
  allowedScope?: string[];
  verificationMethods?: string[];
  /** Present when Secondmate regenerated after return/replan feedback. */
  diffFromPrevious?: PlanVersionDiffRecord;
}

export type AskUserKind = "ask_user" | "ask_approval" | "ask_replan";
export type AskUserInputMode =
  | "single_select"
  | "multi_select"
  | "free_text"
  | "single_select_with_text"
  | "multi_select_with_text";
export type AskUserStatus = "pending" | "queued" | "answered" | "cancelled" | "superseded";

export interface AskUserOptionRecord {
  id: string;
  label: string;
}

export interface AskUserRequestRecord {
  id: string;
  kind: AskUserKind;
  status: AskUserStatus;
  prompt: string;
  reason: string;
  recommendedAnswer?: string;
  recommendationRationale?: string;
  inputMode: AskUserInputMode;
  options?: AskUserOptionRecord[];
  required: boolean;
  source: { agent: string; stepKey: string; roleId?: string; label?: string };
  mergedFrom?: string[];
  createdAt: string;
  answeredAt?: string;
  answer?: {
    selectedOptionIds?: string[];
    freeText?: string;
    approved?: boolean;
    replanFeedback?: string;
  };
}

export interface AskUserAnswerPayload {
  selectedOptionIds?: string[];
  freeText?: string;
  approved?: boolean;
  replanFeedback?: string;
}

export interface PlanningUpdate {
  taskType?: TaskType;
  requiredCapabilities?: string[];
  additionalContext?: string;
  verificationCommands?: string[][];
}

/** Ticket 25 — project-aware verification (view/edit before approve). */
export type ProjectStackKind =
  | "nodejs"
  | "python"
  | "html"
  | "git"
  | "harmonyos"
  | "cangjie"
  | "mixed"
  | "unknown";

export type VerificationCommandSource = "project_evidence" | "user_specified" | "hypothesis";

export interface VerificationCommandEntryRecord {
  command: string[];
  enabled: boolean;
  source: VerificationCommandSource;
  rationale: string;
  evidencePath?: string;
}

export interface ManualChecklistItemRecord {
  id: string;
  description: string;
  source: VerificationCommandSource;
  rationale: string;
  completed?: boolean;
}

export interface VerificationPlanRecord {
  stack: {
    primary: ProjectStackKind;
    kinds: ProjectStackKind[];
    hasAutomatedTests: boolean;
    packageManager?: string;
    availableScripts?: Array<{ name: string; command?: string; source: string }>;
  };
  commands: VerificationCommandEntryRecord[];
  manualChecklist: ManualChecklistItemRecord[];
  assumptions: string[];
  status: "draft" | "approved" | "superseded";
  approvedPlanVersion?: number;
  taskType?: TaskType;
}

export interface VerificationEvidenceRecord {
  kind: "project-verification";
  planVersion?: number;
  stackPrimary: ProjectStackKind;
  results: Array<{
    command: string[];
    exitCode: number | null;
    stdout: string;
    stderr: string;
    passed: boolean;
  }>;
  manualChecklist: Array<{ id: string; description: string; completed: boolean; note?: string }>;
  summary: string;
  allPassed: boolean;
  recordedAt: string;
}

export interface ProfessionalAgentSelectionRecord {
  source: "role" | "temporary";
  roleId?: string;
  name: string;
  responsibility: string;
  systemInstruction: string;
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

export type ExecutionApprovalKind = "outside_workspace" | "delete_file" | "system_install" | "external_send" | "unapproved_skill" | "unapproved_tool" | "unsupported_operation";

export interface PendingExecutionApprovalRecord {
  id: string;
  kind: ExecutionApprovalKind;
  summary: string;
  status: "awaiting_confirmation" | "approved" | "rejected";
  requestedAt: string;
  decidedAt?: string;
  decisionSummary?: string;
  authorizationFingerprint?: string;
}

export type CorrectionChangeKind = "minor" | "goal" | "scope" | "acceptance" | "prohibition";

export interface RunExecutionRecord {
  status: "idle" | "running" | "succeeded" | "failed";
  selectedAgent?: ProfessionalAgentSelectionRecord;
  completedSteps: string[];
  lastError?: string;
  retryable: boolean;
  activeStep?: string;
  failureCounts: Record<string, number>;
  maxConsecutiveFailures: number;
  pendingApproval?: PendingExecutionApprovalRecord;
  terminationUnconfirmed?: boolean;
}

export interface TemporaryProfessionalAgentInput {
  name: string;
  responsibility: string;
  systemInstruction: string;
  connectionId: string;
  modelId?: string;
  tools?: string[];
}

export interface ProfessionalAgentStartInput {
  roleId?: string;
  temporaryAgent?: TemporaryProfessionalAgentInput;
  saveTemporaryRole?: boolean;
  confirmSaveTemporaryRole?: boolean;
}

export interface CodexCliStatusRecord {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  reason?: string;
}

export interface CodexCliStartInput {
  roleId?: string;
}

export interface WorktreeApplyRecord {
  decision: "none" | "keep_pending" | "applied" | "conflict" | "blocked";
  commitMessageDraft?: string;
  commitMessage?: string;
  commitSha?: string;
  conflictFiles?: string[];
  blockedReason?: string;
  dirtyFiles?: string[];
  externalChangeDetected?: boolean;
  appliedAt?: string;
  decidedAt?: string;
  pushed: false;
}

export interface GitWorktreeRecord {
  runId: string;
  mainWorkspacePath: string;
  workspacePath: string;
  status: "active" | "discarded" | "missing" | "applied";
  verificationResults?: Array<{ command: string[]; exitCode: number | null; stdout: string; stderr: string; passed?: boolean }>;
  applyRecord?: WorktreeApplyRecord;
}

/** Preflight + Chinese commit draft before accepting Worktree changes into main. */
export interface WorktreeApplyPreviewRecord {
  runId: string;
  ok: boolean;
  status: "ready" | "blocked" | "already_applied" | "no_session" | "no_changes" | "keep_pending";
  reason?: string;
  changedFiles: string[];
  commitMessageDraft: string;
  dirtyFiles: string[];
  conflictFiles: string[];
  mainHead?: string;
  baselineCommit?: string;
  externalChangeDetected: boolean;
  applied: boolean;
  appliedCommitSha?: string;
  pushed: false;
  canCompleteDevRun: boolean;
  applyRecord?: WorktreeApplyRecord;
}

export interface WorktreeApplyResultRecord {
  status: "applied" | "conflict" | "blocked" | "already_applied" | "busy" | "no_changes" | "keep_pending";
  runId: string;
  reason?: string;
  commitSha?: string;
  commitMessage?: string;
  conflictFiles?: string[];
  dirtyFiles?: string[];
  externalChangeDetected?: boolean;
  pushed: false;
  sessionStatus: "active" | "discarded" | "applied";
  applyRecord?: WorktreeApplyRecord;
  canCompleteDevRun: boolean;
}

export interface WorktreeKeepPendingResultRecord {
  runId: string;
  status: "keep_pending";
  sessionStatus: "active";
  applyRecord: WorktreeApplyRecord;
  canCompleteDevRun: false;
  pushed: false;
}

/** Same normalized Codex Worktree evidence as Reviewer — not log keyword scraping. */
export interface WorktreeArtifactEvidenceRecord {
  source: "codex-worktree";
  worktreeRunId: string;
  worktreePath?: string;
  baselineCommit?: string;
  sessionStatus: "active" | "discarded" | "missing";
  changeStatus: "modified" | "no_modification";
  discarded: boolean;
  changedFiles: string[];
  diff?: string;
  verificationResults: Array<{
    command: string[];
    exitCode: number | null;
    stdout: string;
    stderr: string;
    passed: boolean;
  }>;
  summary: string;
  consistency?: "ok" | "missing_worktree" | "stale";
  consistencyNote?: string;
}

export interface GitWorktreeDiffRecord {
  session: GitWorktreeRecord;
  changedFiles: string[];
  diff: string;
  artifactEvidence?: WorktreeArtifactEvidenceRecord | null;
  consistency?: "ok" | "missing_worktree" | "stale";
  consistencyNote?: string;
}

export interface TimelineEvent {
  id: string;
  kind: "user_message" | "plan_version" | "correction" | "agent_status" | "log" | "review" | "artifact" | "approval" | "checkpoint" | "ask_user";
  summary: string;
  createdAt: string;
}

export interface WorkspaceFingerprintRecord {
  kind: "git_status" | "content_hash" | "empty";
  value: string;
  capturedAt: string;
  pathCount: number;
}

export interface RunCheckpointRecord {
  id: string;
  sequence: number;
  createdAt: string;
  step: string;
  stepStatus: "completed" | "failed" | "interrupted";
  summary: string;
  completedSteps: string[];
  artifactPaths: string[];
  nextStep?: string;
  workspaceFingerprint: WorkspaceFingerprintRecord;
  actionKind: string;
  dangerous: boolean;
  recoveryMode: "reconstruct_and_replay";
}

export interface CheckpointRecoveryRecord {
  status: "none" | "ready" | "conflict" | "awaiting_dangerous_reapproval";
  lastCheckpointId?: string;
  interruptedStep?: string;
  conflictReason?: string;
  requiresDangerousReapproval: boolean;
  dangerousReplayApproved?: boolean;
  recoveryNote: string;
}

export interface InterruptedRunSummaryRecord {
  runId: string;
  todoId: string;
  status: RunStatus;
  attempt: number;
  completedSteps: string[];
  interruptedStep?: string;
  failedSteps: string[];
  latestCheckpoint?: RunCheckpointRecord;
  checkpointRecovery?: CheckpointRecoveryRecord;
  updatedAt: string;
}

export interface CheckpointListRecord {
  runId: string;
  status: RunStatus;
  completedSteps: string[];
  activeStep?: string;
  checkpointRecovery?: CheckpointRecoveryRecord;
  checkpoints: RunCheckpointRecord[];
  recoveryNote: string;
}

export interface CheckpointResumeResultRecord {
  run: RunRecord;
  canContinue: boolean;
  conflict: boolean;
  requiresDangerousReapproval: boolean;
  resumePlan?: {
    approvedPlanVersion?: number;
    completedSteps: string[];
    interruptedStep?: string;
    nextStep?: string;
    artifactPaths: string[];
    reviewIds: string[];
    approvalIds: string[];
    recoveryMode: "reconstruct_and_replay";
    note: string;
  };
  reason?: string;
}

export type ReviewSeverity = "none" | "low" | "medium" | "high" | "critical";

export interface ReviewFindingRecord {
  criterion: string;
  met: boolean;
  evidence: string;
  severity: ReviewSeverity;
  fixScope?: string;
}

export interface ReviewRecord {
  id: string;
  status: "passed" | "changes_requested" | string;
  summary: string;
  createdAt?: string;
  kind?: "independent" | "timeline";
  severity?: ReviewSeverity;
  evidence?: string[];
  fixScope?: string;
  findings?: ReviewFindingRecord[];
  cycle?: number;
  role?: "reviewer";
}

export interface RunReviewLoopRecord {
  autoFixCyclesUsed: number;
  maxAutoFixCycles: number;
  latestReviewId?: string;
  pendingFixInstruction?: string;
  userAccepted?: boolean;
  userAcceptanceSummary?: string;
  reworkRequested?: boolean;
}

export interface ReviewContextRecord {
  originalGoal: { title: string; description?: string; instructions: string[] };
  approvedPlan?: {
    version: number;
    summary: string;
    steps: string[];
    acceptanceCriteria: string[];
    prohibitions: string[];
    verificationCommands: string[][];
  };
  outcomes: {
    executionStatus: string;
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

export interface PerformReviewResultRecord {
  run: RunRecord;
  review: ReviewRecord;
  fixDispatched: boolean;
}

export interface AcceptanceResultRecord {
  run: RunRecord;
  todo: { id: string; status: string; title: string };
}

/** Per-model token counters for a Run (todos-style Token 用量). */
export interface RunUsageModelRecord {
  modelId: string;
  connectionId?: string;
  roleId?: string;
  label?: string;
  promptTokens: number;
  completionTokens: number;
  cacheTokens: number;
  totalTokens: number;
  calls: number;
  estimated: boolean;
}

export interface RunUsageRecord {
  promptTokens: number;
  completionTokens: number;
  cacheTokens: number;
  totalTokens: number;
  estimated: boolean;
  byModel: RunUsageModelRecord[];
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  todoId: string;
  attempt: number;
  status: RunStatus;
  timeline: TimelineEvent[];
  messages: Array<{ id: string; content: string }>;
  planVersions: PlanVersionRecord[];
  planning?: RunPlanningRecord;
  execution: RunExecutionRecord;
  logs: Array<{ id: string; level: string; message: string }>;
  reviews: ReviewRecord[];
  reviewLoop?: RunReviewLoopRecord;
  approvals: Array<{ id: string; decision: "approved" | "returned" | "cancelled"; summary: string }>;
  artifacts: Array<{
    id: string;
    path: string;
    kind: string;
    evidence?: WorktreeArtifactEvidenceRecord;
  }>;
  checkpoints?: RunCheckpointRecord[];
  checkpointRecovery?: CheckpointRecoveryRecord;
  askUserRequests?: AskUserRequestRecord[];
  waitingForUserResume?: { previousStatus: RunStatus; since: string };
  usage?: RunUsageRecord;
  createdAt: string;
  updatedAt: string;
}

/** Compact display like todos (202.5k / 1.2M / 850). */
export function formatTokenCount(n: number): string {
  const value = Math.max(0, Math.floor(n || 0));
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 10_000) {
    const k = value / 1000;
    return `${k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(value);
}

export function reconcileRunSelection(runIds: string[], currentId: string): string {
  return runIds.includes(currentId) ? currentId : (runIds[0] ?? "");
}

/** Result of server-side multi-agent orchestration after plan approval. */
export interface PlanOrchestrationResult {
  runId?: string;
  dagCreated?: boolean;
  scheduled?: string[];
  startedAgents?: Array<{ subtaskId: string; harness: "api" | "codex-cli"; roleId?: string }>;
  completedSubtasks?: string[];
  dagComplete?: boolean;
  errors?: string[];
  error?: string;
}

/**
 * Plan approval may return `{ run, orchestration }` when post-plan orchestration is enabled.
 * Always surface a bare RunRecord to UI state.
 */
export function unwrapRunRecord(body: RunRecord | { run: RunRecord; orchestration?: unknown } | null | undefined): RunRecord {
  if (!body || typeof body !== "object") {
    throw new Error("服务返回了无效的 Run 数据。");
  }
  if ("run" in body && body.run && typeof body.run === "object" && "id" in body.run) {
    return body.run;
  }
  if ("id" in body && typeof (body as RunRecord).id === "string") {
    return body as RunRecord;
  }
  throw new Error("服务返回了无效的 Run 数据。");
}

export function createRunClient(serviceUrl: string) {
  const requestJson = createJsonRequest(serviceUrl);
  return {
    list: (todoId: string) => requestJson<RunRecord[]>(`/api/todos/${encodeURIComponent(todoId)}/runs`),
    create: (todoId: string, message: string) =>
      requestJson<RunRecord>(`/api/todos/${encodeURIComponent(todoId)}/runs`, {
        method: "POST",
        body: JSON.stringify({ message })
      }),
    get: (runId: string) => requestJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}`),
    usage: (runId: string) => requestJson<RunUsageRecord>(`/api/runs/${encodeURIComponent(runId)}/usage`),
    addMessage: (runId: string, content: string) =>
      requestJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ content })
      }),
    updatePlanning: (runId: string, payload: PlanningUpdate) =>
      requestJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}/planning`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    /** Ticket 25: propose project-aware verification for a Run (requires mounted verification routes). */
    proposeVerification: (runId: string, payload: {
      workspacePath?: string;
      taskType?: TaskType;
      userCommands?: string[][];
      disabledCommands?: string[][];
      supplementalCommands?: string[][];
      userConstraints?: string;
    } = {}) =>
      requestJson<VerificationPlanRecord>(`/api/runs/${encodeURIComponent(runId)}/verification/propose`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    /** Ticket 25: persist edited verification commands onto Run planning (requires mounted verification routes). */
    updateVerification: (runId: string, payload: {
      verificationCommands: string[][];
      taskType?: TaskType;
      requiredCapabilities?: string[];
      additionalContext?: string;
    }) =>
      requestJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}/verification`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    /** Approve/return/cancel plan; when approved, server multi-agent orchestrates (DAG + roles). */
    decidePlanDetailed: async (
      runId: string,
      payload: { decision: "approved" | "returned" | "cancelled"; summary: string }
    ): Promise<{ run: RunRecord; orchestration?: PlanOrchestrationResult }> => {
      const body = await requestJson<RunRecord | { run: RunRecord; orchestration?: PlanOrchestrationResult }>(
        `/api/runs/${encodeURIComponent(runId)}/plan-decisions`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );
      if (body && typeof body === "object" && "run" in body && body.run) {
        return {
          run: body.run,
          orchestration: body.orchestration
        };
      }
      return { run: unwrapRunRecord(body) };
    },
    decidePlan: async (runId: string, payload: { decision: "approved" | "returned" | "cancelled"; summary: string }) => {
      const body = await requestJson<RunRecord | { run: RunRecord; orchestration?: PlanOrchestrationResult }>(
        `/api/runs/${encodeURIComponent(runId)}/plan-decisions`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );
      return unwrapRunRecord(body);
    },
    listAskUser: (runId: string) =>
      requestJson<{ runId: string; requests: AskUserRequestRecord[]; pending: AskUserRequestRecord[]; queued: AskUserRequestRecord[] }>(
        `/api/runs/${encodeURIComponent(runId)}/ask-user`
      ),
    answerAskUser: (runId: string, requestId: string, payload: AskUserAnswerPayload) =>
      requestJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}/ask-user/${encodeURIComponent(requestId)}/answer`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    executeProfessionalAgent: (runId: string, payload: ProfessionalAgentStartInput = {}) =>
      requestJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}/professional-agent/execute`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    codexCliStatus: () => requestJson<CodexCliStatusRecord>("/api/codex-cli/status"),
    executeCodexCli: (runId: string, payload: CodexCliStartInput = {}) =>
      requestJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}/codex-cli/execute`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    getWorktree: (runId: string) => requestJson<GitWorktreeDiffRecord>(`/api/runs/${encodeURIComponent(runId)}/worktree`),
    runWorktreeChecks: (runId: string, commands: string[][]) => requestJson<Array<{ command: string[]; exitCode: number | null; stdout: string; stderr: string }>>(`/api/runs/${encodeURIComponent(runId)}/worktree/checks`, {
      method: "POST",
      body: JSON.stringify({ commands })
    }),
    discardWorktree: (runId: string) => requestJson<GitWorktreeRecord>(`/api/runs/${encodeURIComponent(runId)}/worktree`, { method: "DELETE" }),
    /** Pre-check main dirty/external change and load Chinese commit message draft. */
    previewWorktreeApply: (runId: string) =>
      requestJson<WorktreeApplyPreviewRecord>(`/api/runs/${encodeURIComponent(runId)}/worktree/apply/preview`),
    /** Accept and apply isolated changes into main (local commit only; never auto-push). */
    applyWorktree: (runId: string, payload: { commitMessage?: string } = {}) =>
      requestJson<WorktreeApplyResultRecord>(`/api/runs/${encodeURIComponent(runId)}/worktree/apply`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    /** Keep isolated changes pending without modifying main or removing the worktree. */
    keepWorktreePending: (runId: string) =>
      requestJson<WorktreeKeepPendingResultRecord>(`/api/runs/${encodeURIComponent(runId)}/worktree/keep-pending`, {
        method: "POST",
        body: JSON.stringify({})
      }),
    stop: (runId: string, summary: string) =>
      requestJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}/stop`, {
        method: "POST",
        body: JSON.stringify({ summary })
      }),
    correctAndContinue: (runId: string, payload: { instruction: string; changeKind?: CorrectionChangeKind }) =>
      requestJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}/corrections`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    decideExecutionApproval: (runId: string, payload: { decision: "approved" | "rejected"; summary: string }) =>
      requestJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}/execution-approvals`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    reviewContext: (runId: string) =>
      requestJson<ReviewContextRecord>(`/api/runs/${encodeURIComponent(runId)}/review/context`),
    performReview: (runId: string, payload: { autoDispatchFix?: boolean } = {}) =>
      requestJson<PerformReviewResultRecord>(`/api/runs/${encodeURIComponent(runId)}/review/perform`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    dispatchReviewFix: (runId: string, payload: { userAuthorized?: boolean; force?: boolean } = {}) =>
      requestJson<{ run: RunRecord; continued: boolean; reason?: string }>(`/api/runs/${encodeURIComponent(runId)}/review/fix`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    decideAcceptance: (runId: string, payload: { decision: "accepted" | "rejected"; summary: string }) =>
      requestJson<AcceptanceResultRecord>(`/api/runs/${encodeURIComponent(runId)}/acceptance`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    listInterruptedRuns: () => requestJson<InterruptedRunSummaryRecord[]>("/api/interrupted-runs"),
    listCheckpoints: (runId: string) =>
      requestJson<CheckpointListRecord>(`/api/runs/${encodeURIComponent(runId)}/checkpoints`),
    /** Accepts 202 success and structured 403/409 recovery outcomes (not generic error throws). */
    resumeFromCheckpoint: async (runId: string, payload: { approveDangerousReplay?: boolean } = {}) => {
      const response = await fetch(`${serviceUrl}/api/runs/${encodeURIComponent(runId)}/checkpoint-resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = (await response.json().catch(() => null)) as
        | (CheckpointResumeResultRecord & { error?: string })
        | null;
      if (response.status === 202 || response.status === 403 || response.status === 409) {
        if (!body || typeof body !== "object" || !body.run) {
          throw new Error(body?.error ?? `服务返回 ${response.status}`);
        }
        return {
          run: body.run,
          canContinue: Boolean(body.canContinue),
          conflict: Boolean(body.conflict) || response.status === 409,
          requiresDangerousReapproval: Boolean(body.requiresDangerousReapproval) || response.status === 403,
          resumePlan: body.resumePlan,
          reason: body.reason ?? body.error
        } satisfies CheckpointResumeResultRecord;
      }
      throw new Error(body?.error ?? `服务返回 ${response.status}`);
    }
  };
}
