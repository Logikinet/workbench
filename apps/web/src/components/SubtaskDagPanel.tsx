import { useState } from "react";
import { createSubtaskClient, type SubtaskDagRecord } from "../lib/subtasks.js";

interface SubtaskDagPanelProps {
  serviceUrl: string;
  available: boolean;
  runId?: string;
  onNotice?(message: string): void;
}

/**
 * Optional inspector for Task 21 Subtask DAG:
 * status, agent instance, start/end times, artifacts, errors, frontier.
 * Mount from App when subtask-dag capability is present.
 */
export function SubtaskDagPanel({ serviceUrl, available, runId, onNotice }: SubtaskDagPanelProps) {
  const client = createSubtaskClient(serviceUrl);
  const [localRunId, setLocalRunId] = useState(runId ?? "");
  const [steps, setSteps] = useState("确认范围\n调研现有实现\n实现最小改动\n验证");
  const [dag, setDag] = useState<SubtaskDagRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [correction, setCorrection] = useState("");

  const notify = (message: string) => onNotice?.(message);

  const createDag = async () => {
    if (!available || !localRunId.trim()) return;
    setBusy(true);
    try {
      const next = await client.createFromPlan({
        runId: localRunId.trim(),
        planVersion: 1,
        planApproved: true,
        autoSchedule: true,
        steps: steps.split("\n").map((line) => line.trim()).filter(Boolean)
      });
      setDag(next);
      notify(`子任务 DAG 已创建，前沿 ${next.frontier.length} 项，自动调度中。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法创建子任务图");
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!localRunId.trim()) return;
    setBusy(true);
    try {
      setDag(await client.getByRunId(localRunId.trim()));
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法加载子任务图");
    } finally {
      setBusy(false);
    }
  };

  const completeRunning = async () => {
    if (!dag) return;
    const running = dag.subtasks.find((s) => s.status === "running");
    if (!running) {
      notify("没有运行中的子任务。");
      return;
    }
    setBusy(true);
    try {
      const result = await client.complete(dag.runId, running.id, { summary: "手动标记完成" });
      setDag(result.dag);
      notify(`已完成 ${running.title}，自动调度继续。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法完成子任务");
    } finally {
      setBusy(false);
    }
  };

  const applyMajorCorrection = async () => {
    if (!dag || !correction.trim()) return;
    setBusy(true);
    try {
      const result = await client.correct(dag.runId, { note: correction.trim(), major: true });
      setDag(result.dag);
      notify(result.needsAskReplan ? "重大纠偏：需要 AskReplan。" : "纠偏已应用。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法应用纠偏");
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!localRunId.trim()) return;
    setBusy(true);
    try {
      const result = await client.resume(localRunId.trim());
      setDag(result.dag);
      notify(result.resumed ? `已从前沿恢复（${result.frontier.length}）` : "未能恢复。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法恢复");
    } finally {
      setBusy(false);
    }
  };

  if (!available) {
    return (
      <section className="panel">
        <h2>子任务依赖图</h2>
        <p className="muted">服务不可用或未启用 subtask-dag 能力。</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>子任务依赖图</h2>
      <p className="muted">
        计划批准后 Firstmate 按依赖连续调度；写任务串行，只读 / 独立 Worktree 可受控并行。
        失败阻止下游；重大纠偏触发 AskReplan；支持检查点恢复。
      </p>

      <div className="form-grid">
        <label>
          Run ID
          <input value={localRunId} onChange={(event) => setLocalRunId(event.target.value)} />
        </label>
        <label>
          计划步骤（每行一步）
          <textarea rows={4} value={steps} onChange={(event) => setSteps(event.target.value)} />
        </label>
      </div>

      <div className="button-row">
        <button type="button" disabled={busy} onClick={() => void createDag()}>从计划创建并自动调度</button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>刷新</button>
        <button type="button" disabled={busy || !dag} onClick={() => void completeRunning()}>完成当前运行项</button>
        <button type="button" disabled={busy} onClick={() => void resume()}>从前沿恢复</button>
      </div>

      <div className="form-grid">
        <label>
          纠偏说明（重大 → AskReplan）
          <input value={correction} onChange={(event) => setCorrection(event.target.value)} />
        </label>
        <button type="button" disabled={busy || !dag} onClick={() => void applyMajorCorrection()}>
          提交重大纠偏
        </button>
      </div>

      {dag && (
        <div className="subtask-dag">
          <p>
            状态 <strong>{dag.status}</strong>
            {" · "}
            前沿 {dag.frontier.length}
            {" · "}
            自动调度 {dag.autoSchedule ? "开" : "关"}
            {dag.needsAskReplan ? " · 等待 AskReplan" : ""}
          </p>
          <ul className="subtask-list">
            {dag.subtasks.map((sub) => (
              <li key={sub.id} className={`subtask-item status-${sub.status}`}>
                <div>
                  <strong>{sub.title}</strong>
                  <span className="muted"> · {sub.status} · {sub.accessMode}</span>
                </div>
                <div className="muted">
                  依赖: {sub.dependsOn.length ? sub.dependsOn.join(", ") : "无"}
                  {sub.agentInstance ? ` · 代理: ${sub.agentInstance.name}${sub.agentInstance.modelId ? ` / ${sub.agentInstance.modelId}` : ""}` : ""}
                </div>
                <div className="muted">
                  {sub.startedAt ? `开始 ${sub.startedAt}` : "未开始"}
                  {sub.completedAt ? ` · 结束 ${sub.completedAt}` : ""}
                </div>
                {sub.artifacts.length > 0 && (
                  <div className="muted">产物: {sub.artifacts.join(", ")}</div>
                )}
                {sub.error && <div className="error">错误: {sub.error}</div>}
                {sub.blockedReason && <div className="muted">阻塞: {sub.blockedReason}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
