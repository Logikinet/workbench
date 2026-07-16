import { createJsonRequest } from "./apiClient.js";

export interface AutomationSchedule {
  kind: "once" | "every" | "cron" | "manual";
  at?: string;
  everyMs?: number;
  expr?: string;
}

export interface AutomationAction {
  type: "create_todo" | "append_run_message" | "create_run" | "trigger_flow";
  title?: string;
  description?: string;
  projectId?: string;
  startRun?: boolean;
  initialMessage?: string;
  runId?: string;
  message?: string;
  todoId?: string;
  flowId?: string;
  input?: Record<string, unknown>;
}

export interface AutomationJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  action: AutomationAction;
  missedRunPolicy: string;
  state: {
    nextRunAt?: string | null;
    lastRunAt?: string | null;
    lastStatus?: string | null;
    lastError?: string | null;
  };
  deleteAfterRun: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationStatus {
  running?: boolean;
  jobCount?: number;
  enabledJobCount?: number;
  [key: string]: unknown;
}

export interface CreateJobInput {
  name: string;
  schedule: AutomationSchedule;
  action: AutomationAction;
  enabled?: boolean;
  deleteAfterRun?: boolean;
}

export function createAutomationClient(serviceUrl: string) {
  const json = createJsonRequest(serviceUrl);

  return {
    status: () => json<AutomationStatus>("/api/automation/status"),
    listJobs: async (includeDisabled = true) => {
      const qs = includeDisabled ? "" : "?includeDisabled=false";
      const body = await json<{ jobs: AutomationJob[] }>(`/api/automation/jobs${qs}`);
      return body.jobs ?? [];
    },
    createJob: (input: CreateJobInput) =>
      json<AutomationJob>("/api/automation/jobs", {
        method: "POST",
        body: JSON.stringify(input)
      }),
    enable: (id: string) =>
      json(`/api/automation/jobs/${encodeURIComponent(id)}/enable`, {
        method: "POST",
        body: "{}"
      }),
    disable: (id: string) =>
      json(`/api/automation/jobs/${encodeURIComponent(id)}/disable`, {
        method: "POST",
        body: "{}"
      }),
    runNow: (id: string) =>
      json(`/api/automation/jobs/${encodeURIComponent(id)}/run`, {
        method: "POST",
        body: "{}"
      }),
    remove: (id: string) =>
      json<void>(`/api/automation/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    history: (id?: string) =>
      id
        ? json(`/api/automation/jobs/${encodeURIComponent(id)}/history`)
        : json("/api/automation/history")
  };
}

export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === "manual") return "仅手动";
  if (schedule.kind === "once") return `单次 · ${schedule.at ?? "—"}`;
  if (schedule.kind === "every") {
    const ms = schedule.everyMs ?? 0;
    if (ms >= 3_600_000) return `每 ${Math.round(ms / 3_600_000)} 小时`;
    if (ms >= 60_000) return `每 ${Math.round(ms / 60_000)} 分钟`;
    return `每 ${Math.round(ms / 1000)} 秒`;
  }
  if (schedule.kind === "cron") return `Cron · ${schedule.expr ?? "—"}`;
  return schedule.kind;
}

export function describeAction(action: AutomationAction): string {
  switch (action.type) {
    case "create_todo":
      return `创建 Todo：${action.title ?? "—"}`;
    case "create_run":
      return `为 Todo 创建 Run：${action.todoId ?? "—"}`;
    case "append_run_message":
      return `向 Run 追加消息：${action.runId ?? "—"}`;
    case "trigger_flow":
      return `触发流程：${action.flowId ?? "—"}`;
    default:
      return action.type;
  }
}
