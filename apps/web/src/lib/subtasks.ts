import { createJsonRequest } from "./apiClient.js";

export type SubtaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "paused";

export interface SubtaskRecord {
  id: string;
  runId: string;
  planVersion: number;
  stepIndex: number;
  title: string;
  requiredCapabilities: string[];
  inputs: string[];
  outputs: string[];
  dependsOn: string[];
  accessMode: "read_only" | "write";
  independentWorktree: boolean;
  status: SubtaskStatus;
  agentInstance?: {
    roleId?: string;
    name: string;
    harness?: "api" | "codex-cli";
    modelId?: string;
  };
  startedAt?: string;
  completedAt?: string;
  artifacts: string[];
  error?: string;
  blockedReason?: string;
  correctionNotes: string[];
  acceptanceCriteria: string[];
}

export interface SubtaskDagRecord {
  id: string;
  runId: string;
  planVersion: number;
  status: string;
  autoSchedule: boolean;
  frontier: string[];
  needsAskReplan: boolean;
  replanFeedback?: string;
  subtasks: SubtaskRecord[];
  lastScheduleAt?: string;
  lastError?: string;
  correctionNote?: string;
}

export interface CreateDagFromPlanInput {
  runId: string;
  planVersion: number;
  steps: string[];
  planApproved?: boolean;
  autoSchedule?: boolean;
  taskType?: string;
  requiredCapabilities?: string[];
  acceptanceCriteria?: string[];
}

export function createSubtaskClient(serviceUrl: string) {
  const requestJson = createJsonRequest(serviceUrl);

  return {
    createFromPlan(input: CreateDagFromPlanInput) {
      return requestJson<SubtaskDagRecord>("/api/subtasks/from-plan", {
        method: "POST",
        body: JSON.stringify(input)
      });
    },
    getByRunId(runId: string) {
      return requestJson<SubtaskDagRecord>(`/api/subtasks/runs/${encodeURIComponent(runId)}`);
    },
    frontier(runId: string) {
      return requestJson<{ runId: string; frontier: string[]; dagStatus: string }>(
        `/api/subtasks/runs/${encodeURIComponent(runId)}/frontier`
      );
    },
    schedule(runId: string) {
      return requestJson<{ dag: SubtaskDagRecord; started: string[]; frontier: string[] }>(
        `/api/subtasks/runs/${encodeURIComponent(runId)}/schedule`,
        { method: "POST", body: "{}" }
      );
    },
    complete(runId: string, subtaskId: string, body: { artifacts?: string[]; summary?: string } = {}) {
      return requestJson<{ dag: SubtaskDagRecord }>(
        `/api/subtasks/runs/${encodeURIComponent(runId)}/subtasks/${encodeURIComponent(subtaskId)}/complete`,
        { method: "POST", body: JSON.stringify(body) }
      );
    },
    fail(runId: string, subtaskId: string, body: { error: string; pause?: boolean }) {
      return requestJson<{ dag: SubtaskDagRecord }>(
        `/api/subtasks/runs/${encodeURIComponent(runId)}/subtasks/${encodeURIComponent(subtaskId)}/fail`,
        { method: "POST", body: JSON.stringify(body) }
      );
    },
    correct(runId: string, body: { note: string; major?: boolean; relatedSubtaskIds?: string[] }) {
      return requestJson<{ dag: SubtaskDagRecord; needsAskReplan: boolean; affectedSubtaskIds: string[] }>(
        `/api/subtasks/runs/${encodeURIComponent(runId)}/correct`,
        { method: "POST", body: JSON.stringify(body) }
      );
    },
    checkpoint(runId: string, note?: string) {
      return requestJson<SubtaskDagRecord>(
        `/api/subtasks/runs/${encodeURIComponent(runId)}/checkpoint`,
        { method: "POST", body: JSON.stringify({ note }) }
      );
    },
    resume(runId: string) {
      return requestJson<{ dag: SubtaskDagRecord; resumed: boolean; frontier: string[] }>(
        `/api/subtasks/runs/${encodeURIComponent(runId)}/resume`,
        { method: "POST", body: "{}" }
      );
    }
  };
}
