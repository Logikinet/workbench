import { useEffect, useState } from "react";
import {
  createRunClient,
  type CheckpointListRecord,
  type InterruptedRunSummaryRecord,
  type RunRecord
} from "../lib/runs.js";
import {
  EmptyHint,
  ListCard,
  Notice,
  Panel,
  PrimaryButton,
  QuietButton,
  RowActions,
  Stack,
  Tag
} from "./ui.js";

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
  const recoveryWorthy =
    ["interrupted", "paused", "failed"].includes(run.status) ||
    recovery?.status === "conflict" ||
    recovery?.status === "awaiting_dangerous_reapproval" ||
    (run.execution.status === "failed" && run.execution.retryable);
  const showRecovery = recoveryWorthy || checkpoints.length > 0;

  if (!showRecovery) return null;

  return (
    <Panel
      eyebrow="CHECKPOINT RECOVERY"
      title="步骤检查点与中断恢复"
      description={
        detail?.recoveryNote ??
        recovery?.recoveryNote ??
        "恢复通过批准计划与最近检查点重建模型会话上下文；不会恢复原模型内部会话状态。"
      }
    >
      {recovery ? (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <Tag color={recovery.status === "conflict" ? "danger" : "accent"}>{recovery.status}</Tag>
          {recovery.interruptedStep ? (
            <EmptyHint>中断步骤：{recovery.interruptedStep}</EmptyHint>
          ) : null}
          {recovery.conflictReason ? <Notice tone="warning">{recovery.conflictReason}</Notice> : null}
          {recovery.requiresDangerousReapproval ? (
            <Notice tone="warning">危险操作需再次确认后才会重放。</Notice>
          ) : null}
        </div>
      ) : null}

      {checkpoints.length > 0 ? (
        <Stack>
          {checkpoints.map((checkpoint) => (
            <ListCard key={checkpoint.id}>
              <strong>
                #{checkpoint.sequence} · {checkpoint.stepStatus}
              </strong>
              <p className="m-0 text-sm">{checkpoint.step}</p>
              <EmptyHint>{checkpoint.summary}</EmptyHint>
              {checkpoint.nextStep ? <EmptyHint>下一步：{checkpoint.nextStep}</EmptyHint> : null}
              {checkpoint.dangerous ? <Tag color="danger">危险步骤</Tag> : null}
              {checkpoint.artifactPaths.length > 0 ? (
                <EmptyHint>成果：{checkpoint.artifactPaths.join("、")}</EmptyHint>
              ) : null}
            </ListCard>
          ))}
        </Stack>
      ) : null}

      {interrupted.length > 0 ? (
        <Stack>
          <strong>本 Todo 可恢复 Run</strong>
          {interrupted.map((entry) => (
            <ListCard key={entry.runId}>
              <p className="m-0 text-sm">
                第 {entry.attempt} 次 · {entry.status}
                {entry.completedSteps.length > 0 ? ` · 已完成 ${entry.completedSteps.length} 步` : ""}
                {entry.interruptedStep ? ` · 中断于 ${entry.interruptedStep}` : ""}
                {entry.failedSteps.length > 0 ? ` · 失败/中断 ${entry.failedSteps.length} 步` : ""}
              </p>
            </ListCard>
          ))}
        </Stack>
      ) : null}

      {!readOnly && recoveryWorthy ? (
        <RowActions>
          <PrimaryButton
            isDisabled={busy || run.execution.terminationUnconfirmed}
            onPress={() => void resume(false)}
          >
            从检查点恢复
          </PrimaryButton>
          {recovery?.requiresDangerousReapproval || recovery?.status === "awaiting_dangerous_reapproval" ? (
            <QuietButton isDisabled={busy} onPress={() => void resume(true)}>
              确认危险步骤并恢复
            </QuietButton>
          ) : null}
        </RowActions>
      ) : null}
    </Panel>
  );
}
