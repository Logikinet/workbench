/**
 * Shows plan steps → assigned agents (multi-agent dispatch view).
 * This is the main visualization of:
 *   规划 Agent 出计划 → 拆分子任务 → 分给不同执行 Agent
 */

import { useCallback, useEffect, useState } from "react";
import { createSubtaskClient, type SubtaskDagRecord, type SubtaskRecord } from "../lib/subtasks.js";
import type { RunRecord } from "../lib/runs.js";
import { EmptyHint, ListCard, QuietButton, Stack, Tag } from "./ui.js";

interface AgentDispatchPanelProps {
  serviceUrl: string;
  run: RunRecord;
  onNotice?(message: string): void;
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "等待依赖",
    ready: "就绪",
    running: "执行中",
    completed: "完成",
    failed: "失败",
    blocked: "阻塞",
    cancelled: "取消",
    paused: "暂停"
  };
  return map[status] ?? status;
}

function statusTone(status: string): "success" | "warning" | "danger" | undefined {
  if (status === "completed") return "success";
  if (status === "running" || status === "ready") return "warning";
  if (status === "failed" || status === "blocked") return "danger";
  return undefined;
}

export function AgentDispatchPanel({ serviceUrl, run, onNotice }: AgentDispatchPanelProps) {
  const client = createSubtaskClient(serviceUrl);
  const [dag, setDag] = useState<SubtaskDagRecord | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      const next = await client.getByRunId(run.id);
      setDag(next);
      setError("");
    } catch (e) {
      setDag(null);
      setError(e instanceof Error ? e.message : "暂无子任务编排");
    }
  }, [client, run.id]);

  useEffect(() => {
    void reload();
  }, [reload, run.status, run.updatedAt]);

  useEffect(() => {
    if (run.status !== "running" && run.execution?.status !== "running") return;
    const timer = window.setInterval(() => void reload(), 2000);
    return () => window.clearInterval(timer);
  }, [run.status, run.execution?.status, reload]);

  const planSteps = run.planVersions.at(-1)?.steps ?? [];

  return (
    <Stack className="agent-dispatch-panel rounded-xl border border-border bg-field/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong style={{ fontSize: "0.9rem" }}>多 Agent 分工</strong>
        <QuietButton onPress={() => void reload()}>刷新</QuietButton>
      </div>
      <p className="m-0 text-xs text-muted">
        规划出步骤 → 拆成子任务 → 分给不同 Agent 按依赖执行（完成一个自动派下一个）
      </p>

      {planSteps.length > 0 ? (
        <div className="rounded-lg border border-border bg-background p-2">
          <div className="text-xs text-muted mb-1">计划步骤（Planner）</div>
          <ol className="m-0 pl-4 text-sm" style={{ display: "grid", gap: "0.2rem" }}>
            {planSteps.map((step, index) => (
              <li key={`${index}-${step.slice(0, 12)}`}>{step}</li>
            ))}
          </ol>
        </div>
      ) : (
        <EmptyHint>尚无计划步骤。创建 Run 后会由规划 Agent 生成。</EmptyHint>
      )}

      {dag ? (
        <div className="rounded-lg border border-border bg-background p-2">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <div className="text-xs text-muted">执行分工（Builders）</div>
            <Tag>{dag.status}</Tag>
            <span className="text-xs text-muted">
              前沿 {dag.frontier.length} · 共 {dag.subtasks.length} 步
            </span>
          </div>
          <Stack>
            {dag.subtasks.map((subtask) => (
              <SubtaskRow key={subtask.id} subtask={subtask} />
            ))}
          </Stack>
        </div>
      ) : (
        <EmptyHint>
          {error.includes("not found") || error.includes("未找到") || error.includes("was not found")
            ? "批准计划后会自动拆分子任务并分配 Agent。"
            : error || "批准计划后显示分工。"}
        </EmptyHint>
      )}

      {dag?.lastError ? (
        <p className="m-0 text-xs" style={{ color: "var(--status-red)" }}>
          {dag.lastError}
        </p>
      ) : null}
    </Stack>
  );
}

function SubtaskRow({ subtask }: { subtask: SubtaskRecord }) {
  const agent = subtask.agentInstance;
  return (
    <ListCard>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">{subtask.title}</strong>
        <Tag color={statusTone(subtask.status)}>{statusLabel(subtask.status)}</Tag>
      </div>
      <div className="text-xs text-muted" style={{ marginTop: "0.25rem" }}>
        {agent ? (
          <>
            Agent：<strong>{agent.name}</strong>
            {agent.harness ? ` · ${agent.harness}` : ""}
            {agent.modelId ? ` · ${agent.modelId}` : ""}
            {agent.source ? ` · ${agent.source}` : ""}
          </>
        ) : (
          "Agent：待分配"
        )}
      </div>
      {subtask.dependsOn.length > 0 ? (
        <div className="text-xs text-muted">依赖 {subtask.dependsOn.length} 项完成后启动</div>
      ) : null}
      {subtask.error ? (
        <div className="text-xs" style={{ color: "var(--status-red)" }}>
          {subtask.error}
        </div>
      ) : null}
    </ListCard>
  );
}
