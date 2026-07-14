import { createJsonRequest } from "./apiClient.js";

export type RunStatus =
  | "created"
  | "planning"
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

export interface TaskAssessmentRecord {
  taskType: TaskType;
  requiredCapabilities: string[];
  criticalInputs: string[];
  assumptions: string[];
  complexity: "low" | "medium" | "high";
}

export interface RunPlanningRecord {
  assessment: TaskAssessmentRecord;
  approvalStatus: PlanApprovalStatus;
  approvedPlanVersion?: number;
  verificationCommands?: string[][];
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
}

export interface PlanningUpdate {
  taskType?: TaskType;
  requiredCapabilities?: string[];
  additionalContext?: string;
  verificationCommands?: string[][];
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

export interface GitWorktreeRecord {
  runId: string;
  mainWorkspacePath: string;
  workspacePath: string;
  status: "active" | "discarded";
  verificationResults?: Array<{ command: string[]; exitCode: number | null; stdout: string; stderr: string }>;
}

export interface GitWorktreeDiffRecord {
  session: GitWorktreeRecord;
  changedFiles: string[];
  diff: string;
}

export interface TimelineEvent {
  id: string;
  kind: "user_message" | "plan_version" | "correction" | "agent_status" | "log" | "review" | "artifact" | "approval" | "checkpoint";
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
  artifacts: Array<{ id: string; path: string; kind: string }>;
  checkpoints?: RunCheckpointRecord[];
  checkpointRecovery?: CheckpointRecoveryRecord;
  createdAt: string;
  updatedAt: string;
}

export function reconcileRunSelection(runIds: string[], currentId: string): string {
  return runIds.includes(currentId) ? currentId : (runIds[0] ?? "");
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
    decidePlan: (runId: string, payload: { decision: "approved" | "returned" | "cancelled"; summary: string }) =>
      requestJson<RunRecord>(`/api/runs/${encodeURIComponent(runId)}/plan-decisions`, {
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
