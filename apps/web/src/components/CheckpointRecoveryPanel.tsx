import { useEffect, useState } from "react";
import {
  createRunClient,
  type CheckpointListRecord,
  type InterruptedRunSummaryRecord,
  type RunRecord
} from "../lib/runs.js";

interface CheckpointRecoveryPanelProps {
  serviceUrl: string;
  run: RunRecord;
  onRunChange(run: RunRecord): void;
  onNotice(message: string): void;
  readOnly?: boolean;
}

export function CheckpointRecoveryPanel({
  serviceUrl,
  run,
  onRunChange,
  onNotice,
  readOnly = false
}: CheckpointRecoveryPanelProps) {
  const client = createRunClient(serviceUrl);
  const [detail, setDetail] = useState<CheckpointListRecord | null>(null);
  const [interrupted, setInterrupted] = useState<InterruptedRunSummaryRecord[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      const [checkpoints, interruptedRuns] = await Promise.all([
        client.listCheckpoints(run.id),
        client.listInterruptedRuns()
      ]);
      setDetail(checkpoints);
      setInterrupted(interruptedRuns.filter((entry) => entry.todoId === run.todoId || entry.runId === run.id));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法读取检查点");
    }
  };

  useEffect(() => {
    void reload();
  }, [run.id, run.updatedAt, run.status, run.checkpoints?.length, run.checkpointRecovery?.status]);

  const resume = async (approveDangerousReplay = false) => {
    setBusy(true);
    try {
      const result = await client.resumeFromCheckpoint(run.id, { approveDangerousReplay });
      onRunChange(result.run);
      if (result.conflict) {
        onNotice(result.reason ?? result.run.checkpointRecovery?.conflictReason ?? "工作区冲突，恢复已暂停。");
      } else if (result.requiresDangerousReapproval) {
        onNotice(result.reason ?? "危险步骤不会自动重放；请先确认后再恢复。");
      } else if (result.canContinue) {
        onNotice("已从检查点恢复：重建模型会话上下文并继续中断步骤（不会恢复原模型内部会话）。");
      } else {
        onNotice(result.reason ?? "无法从检查点恢复。");
      }
      await reload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法从检查点恢复");
    } finally {
      setBusy(false);
    }
  };

  const checkpoints = detail?.checkpoints ?? run.checkpoints ?? [];
  const recovery = detail?.checkpointRecovery ?? run.checkpointRecovery;
  const recoveryWorthy = ["interrupted", "paused", "failed"].includes(run.status)
    || recovery?.status === "conflict"
    || recovery?.status === "awaiting_dangerous_reapproval"
    || (run.execution.status === "failed" && run.execution.retryable);
  const showRecovery = recoveryWorthy || checkpoints.length > 0;

  if (!showRecovery) return null;

  return (
    <section className="checkpoint-panel" aria-label="检查点与中断恢复">
      <header>
        <p className="eyebrow">CHECKPOINT RECOVERY</p>
        <h4>步骤检查点与中断恢复</h4>
      </header>
      <p className="checkpoint-note">
        {detail?.recoveryNote
          ?? recovery?.recoveryNote
          ?? "恢复通过批准计划与最近检查点重建模型会话上下文；不会恢复原模型内部会话状态。"}
      </p>
      {recovery && (
        <div className="checkpoint-recovery-state" role="status">
          <span className={`tag ${recovery.status === "conflict" ? "archived" : "active"}`}>{recovery.status}</span>
          {recovery.interruptedStep && <small>中断步骤：{recovery.interruptedStep}</small>}
          {recovery.conflictReason && <p className="notice">{recovery.conflictReason}</p>}
          {recovery.requiresDangerousReapproval && <p className="notice">危险操作需再次确认后才会重放。</p>}
        </div>
      )}
      {checkpoints.length > 0 && (
        <ol className="checkpoint-list">
          {checkpoints.map((checkpoint) => (
            <li key={checkpoint.id}>
              <strong>#{checkpoint.sequence} · {checkpoint.stepStatus}</strong>
              <span>{checkpoint.step}</span>
              <small>{checkpoint.summary}</small>
              {checkpoint.nextStep && <small>下一步：{checkpoint.nextStep}</small>}
              {checkpoint.dangerous && <small className="danger-label">危险步骤</small>}
              {checkpoint.artifactPaths.length > 0 && <small>成果：{checkpoint.artifactPaths.join("、")}</small>}
            </li>
          ))}
        </ol>
      )}
      {interrupted.length > 0 && (
        <div className="interrupted-runs">
          <strong>本 Todo 可恢复 Run</strong>
          <ul>
            {interrupted.map((entry) => (
              <li key={entry.runId}>
                第 {entry.attempt} 次 · {entry.status}
                {entry.completedSteps.length > 0 && ` · 已完成 ${entry.completedSteps.length} 步`}
                {entry.interruptedStep && ` · 中断于 ${entry.interruptedStep}`}
                {entry.failedSteps.length > 0 && ` · 失败/中断 ${entry.failedSteps.length} 步`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!readOnly && recoveryWorthy && (
        <div className="checkpoint-actions">
          <button type="button" disabled={busy || run.execution.terminationUnconfirmed} onClick={() => void resume(false)}>
            从检查点恢复
          </button>
          {(recovery?.requiresDangerousReapproval || recovery?.status === "awaiting_dangerous_reapproval") && (
            <button type="button" className="quiet-button" disabled={busy} onClick={() => void resume(true)}>
              确认危险步骤并恢复
            </button>
          )}
        </div>
      )}
    </section>
  );
}
