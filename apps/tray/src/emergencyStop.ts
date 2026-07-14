export interface EmergencyStopProcessResult {
  runId: string;
  todoId: string;
  previousStatus: string;
  outcome: "cancelled" | "paused" | "skipped" | "error";
  processTerminated: boolean | null;
  message: string;
}

export interface EmergencyStopResult {
  summary: string;
  results: EmergencyStopProcessResult[];
  stopped: number;
  failed: number;
  skipped: number;
}

export interface EmergencyStopOptions {
  serviceUrl: string;
  summary?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Calls the local Agent Service emergency stop endpoint (loopback only).
 * Does not start the service — if offline, returns a clear actionable error.
 */
export async function emergencyStopAll(options: EmergencyStopOptions): Promise<EmergencyStopResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const summary = options.summary?.trim() || "托盘紧急停止：停止全部任务。";
  const base = options.serviceUrl.replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/runs/stop-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary })
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `无法连接本地服务以执行紧急停止（${base}）。请先从托盘启动服务，然后重试。详情：${detail}`
    );
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `紧急停止失败：服务返回 ${response.status}。`);
  }

  return (await response.json()) as EmergencyStopResult;
}
