import { createJsonRequest } from "./apiClient.js";

export interface QueueConfigRecord {
  maxWriteParallel: number;
  maxReadOnlyParallel: number;
  maxIsolatedSameProjectWriteParallel: number;
  executionTimeoutMs: number;
  maxRetries: number;
  minFreeDiskBytes: number;
  minFreeMemoryBytes: number;
}

export type QueueConfigUpdate = Partial<QueueConfigRecord>;

export interface QueueLeaseRecord {
  runId: string;
  lane: "write" | "readonly";
  projectId?: string;
  worktreeIsolated: boolean;
  acquiredAt: string;
  timeoutMs: number;
}

export interface QueueStatusRecord {
  config: QueueConfigRecord;
  active: QueueLeaseRecord[];
  writeCount: number;
  readOnlyCount: number;
  resource?: {
    freeDiskBytes: number;
    freeMemoryBytes: number;
    path: string;
    checkedAt: string;
  };
  newTasksPaused: boolean;
  pauseReason?: string;
}

export interface StopAllProcessResultRecord {
  runId: string;
  todoId: string;
  previousStatus: string;
  outcome: "cancelled" | "paused" | "skipped" | "error";
  processTerminated: boolean | null;
  message: string;
}

export interface StopAllResultRecord {
  summary: string;
  results: StopAllProcessResultRecord[];
  stopped: number;
  failed: number;
  skipped: number;
}

export function createQueueClient(serviceUrl: string) {
  const request = createJsonRequest(serviceUrl);
  return {
    getConfig: () => request<QueueConfigRecord>("/api/queue/config"),
    updateConfig: (update: QueueConfigUpdate) =>
      request<QueueConfigRecord>("/api/queue/config", {
        method: "PUT",
        body: JSON.stringify(update)
      }),
    status: () => request<QueueStatusRecord>("/api/queue/status"),
    stopAll: (summary?: string) =>
      request<StopAllResultRecord>("/api/runs/stop-all", {
        method: "POST",
        body: JSON.stringify({ summary: summary ?? "用户一键停止全部 Run。" })
      })
  };
}
