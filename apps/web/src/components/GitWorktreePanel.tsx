import { useEffect, useState } from "react";
import {
  createRunClient,
  type GitWorktreeDiffRecord,
  type RunRecord,
  type WorktreeApplyPreviewRecord,
  type WorktreeApplyResultRecord
} from "../lib/runs.js";
import {
  DangerButton,
  EmptyHint,
  Field,
  Notice,
  Panel,
  PrimaryButton,
  QuietButton,
  RowActions,
  Stack,
  TextAreaField
} from "./ui.js";

interface GitWorktreePanelProps {
  serviceUrl: string;
  run: RunRecord;
  onNotice(message: string): void;
  onRunChange?(run: RunRecord): void;
}

/**
 * Isolated code changes + accept / keep-pending / discard apply loop.
 * Main workspace is never modified until the user accepts apply; never auto-pushes.
 */
export function GitWorktreePanel({ serviceUrl, run, onNotice }: GitWorktreePanelProps) {
  const client = createRunClient(serviceUrl);
  const [result, setResult] = useState<GitWorktreeDiffRecord | null>(null);
  const [preview, setPreview] = useState<WorktreeApplyPreviewRecord | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [lastApply, setLastApply] = useState<WorktreeApplyResultRecord | null>(null);
  const [busy, setBusy] = useState<"idle" | "checking" | "discarding" | "applying" | "pending">("idle");

  const load = async () => {
    try {
      const worktree = await client.getWorktree(run.id);
      setResult(worktree);
      try {
        const nextPreview = await client.previewWorktreeApply(run.id);
        setPreview(nextPreview);
        if (nextPreview.commitMessageDraft && !commitMessage) {
          setCommitMessage(nextPreview.commitMessageDraft);
        }
      } catch {
        setPreview(null);
      }
    } catch {
      setResult(null);
      setPreview(null);
    }
  };

  useEffect(() => {
    void load();
  }, [serviceUrl, run.id, run.updatedAt]);

  const runIsActive =
    run.status === "running" ||
    run.execution.status === "running" ||
    Boolean(run.execution.terminationUnconfirmed);
  const sessionUnavailable =
    result?.session.status === "discarded" ||
    result?.session.status === "missing" ||
    result?.session.status === "applied";
  const canRunChecks = busy === "idle" && !runIsActive && !sessionUnavailable && result?.session.status === "active";
  const canDiscard = busy === "idle" && !runIsActive && result?.session.status === "active";
  const canApply =
    busy === "idle" &&
    !runIsActive &&
    result?.session.status === "active" &&
    preview?.ok !== false &&
    preview?.status !== "already_applied" &&
    preview?.status !== "no_session";
  const canKeepPending = busy === "idle" && !runIsActive && result?.session.status === "active";

  const discard = async () => {
    if (!canDiscard) return;
    setBusy("discarding");
    try {
      await client.discardWorktree(run.id);
      setLastApply(null);
      await load();
      onNotice(
        "已放弃此 Run 的隔离修改；历史 Artifact 已标记丢弃，主工作区未受影响。开发型 Run 未因放弃而标记完成。"
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法放弃隔离修改");
      await load();
    } finally {
      setBusy("idle");
    }
  };

  const runChecks = async () => {
    const plan = run.planVersions.find((entry) => entry.version === run.planning?.approvedPlanVersion);
    const commands = plan?.verificationCommands ?? [];
    if (!commands.length || !canRunChecks) return;
    setBusy("checking");
    try {
      await client.runWorktreeChecks(run.id, commands);
      await load();
      onNotice("已在隔离 Worktree 运行批准计划中的验证命令，结果已保存。");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法运行批准的隔离验证");
      await load();
    } finally {
      setBusy("idle");
    }
  };

  const acceptApply = async () => {
    if (!canApply || busy !== "idle") return;
    setBusy("applying");
    try {
      const applied = await client.applyWorktree(run.id, {
        commitMessage: commitMessage.trim() || undefined
      });
      setLastApply(applied);
      await load();
      if (applied.status === "applied" || applied.status === "already_applied" || applied.status === "no_changes") {
        onNotice(
          applied.status === "no_changes"
            ? "无实际修改；已关闭隔离 Worktree。开发型 Run 可进入正式完成。"
            : `已接受并应用到主工作区（本地提交 ${applied.commitSha?.slice(0, 8) ?? ""}，未推送）。开发型 Run 可在此后正式标记完成。`
        );
      } else if (applied.status === "conflict") {
        onNotice(
          `合并冲突，已暂停并保留主工作区与隔离区。冲突文件：${(applied.conflictFiles ?? []).join("、") || "见详情"}。可处理后重试。`
        );
      } else if (applied.status === "blocked") {
        onNotice(
          applied.reason ??
            `主工作区不可应用：${(applied.dirtyFiles ?? []).join("、") || "请检查脏状态或外部变更"}`
        );
      } else {
        onNotice(applied.reason ?? "应用未完成");
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法应用隔离修改");
      await load();
    } finally {
      setBusy("idle");
    }
  };

  const keepPending = async () => {
    if (!canKeepPending) return;
    setBusy("pending");
    try {
      await client.keepWorktreePending(run.id);
      setLastApply(null);
      await load();
      onNotice("已保留待处理：隔离 Worktree 仍在，主工作区未改动；开发型 Run 在成功应用前不会正式完成。");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法保留待处理");
      await load();
    } finally {
      setBusy("idle");
    }
  };

  if (!result) return null;

  const evidence = result.artifactEvidence;
  const changeStatus = evidence?.changeStatus;
  const verificationRows = evidence?.verificationResults?.length
    ? evidence.verificationResults
    : (result.session.verificationResults ?? []).map((entry) => ({
        ...entry,
        passed: entry.passed ?? entry.exitCode === 0
      }));
  const conflictFiles =
    lastApply?.conflictFiles ?? preview?.conflictFiles ?? result.session.applyRecord?.conflictFiles ?? [];
  const dirtyFiles =
    lastApply?.dirtyFiles ?? preview?.dirtyFiles ?? result.session.applyRecord?.dirtyFiles ?? [];
  const applied = result.session.status === "applied" || preview?.status === "already_applied";
  const keepPendingMarked =
    preview?.status === "keep_pending" || result.session.applyRecord?.decision === "keep_pending";

  return (
    <Panel
      eyebrow="ISOLATED GIT WORKTREE"
      title="修改、验收与应用"
      description="当前修改位于隔离 Worktree；用户选择「接受应用」前不会写入主工作区，且永不自动 Push。"
    >
      {evidence ? <Notice>Artifact 索引：{evidence.summary}</Notice> : null}
      {evidence?.discarded ? <Notice tone="warning">Worktree 已放弃；历史 Diff 与证据保留。</Notice> : null}
      {applied ? (
        <Notice>
          已成功应用到主工作区
          {preview?.appliedCommitSha || result.session.applyRecord?.commitSha
            ? `（提交 ${(preview?.appliedCommitSha ?? result.session.applyRecord?.commitSha ?? "").slice(0, 8)}，未推送）`
            : "（未推送）"}
          。开发型 Run 可正式标记完成。
        </Notice>
      ) : null}
      {keepPendingMarked && !applied ? (
        <Notice tone="warning">已保留待处理；可稍后接受应用或放弃修改。</Notice>
      ) : null}
      {result.consistency === "missing_worktree" ? (
        <Notice tone="danger">
          {result.consistencyNote ?? "Worktree 已缺失；请恢复隔离区或重新执行 Codex。"}
        </Notice>
      ) : null}
      {changeStatus === "no_modification" ? (
        <Notice>无实际修改；未生成虚假成果 Artifact。</Notice>
      ) : null}
      {preview?.externalChangeDetected && !applied ? (
        <Notice tone="warning">
          主工作区相对基线已有新提交；接受应用时将尝试合并，冲突会暂停并列出文件。
        </Notice>
      ) : null}
      {dirtyFiles.length > 0 && !applied ? (
        <Notice tone="danger">主工作区脏文件（请先处理）：{dirtyFiles.join("、")}</Notice>
      ) : null}
      {conflictFiles.length > 0 && !applied ? (
        <Notice tone="danger">合并冲突文件：{conflictFiles.join("、")}。已中止合并，可安全重试。</Notice>
      ) : null}

      <EmptyHint>修改文件：{result.changedFiles.length ? result.changedFiles.join("、") : "无"}</EmptyHint>
      {evidence?.worktreeRunId ? <EmptyHint>Worktree 标识：{evidence.worktreeRunId}</EmptyHint> : null}

      <details className="rounded-xl border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">查看完整 Git Diff</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-field p-3 text-xs">
          {result.diff || "没有未提交修改。"}
        </pre>
      </details>

      {(run.planVersions.find((entry) => entry.version === run.planning?.approvedPlanVersion)
        ?.verificationCommands?.length ?? 0) > 0 ? (
        <QuietButton isDisabled={!canRunChecks} onPress={() => void runChecks()}>
          {busy === "checking" ? "验证运行中…" : "运行批准的验证"}
        </QuietButton>
      ) : null}

      {verificationRows.length ? (
        <details className="rounded-xl border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">查看已保存的验证结果（结构化）</summary>
          <Stack className="mt-3">
            {verificationRows.map((entry, index) => (
              <div key={`${entry.command.join(" ")}-${index}`} className="rounded-lg border border-border p-3">
                <strong className="text-sm">
                  {entry.command.join(" ")} · exit {entry.exitCode ?? "unknown"} · passed=
                  {String(entry.passed)}
                </strong>
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-field p-2 text-xs">
                  {entry.stdout}
                  {entry.stderr ? `\n${entry.stderr}` : ""}
                </pre>
              </div>
            ))}
          </Stack>
        </details>
      ) : null}

      {result.session.status === "active" ? (
        <Stack>
          <p className="m-0 text-[0.7rem] font-bold tracking-[0.14em] text-accent uppercase">验收动作</p>
          <Field label="中文提交说明草案（可编辑；仅本地提交，不推送）">
            <TextAreaField
              aria-label="中文提交说明草案"
              value={commitMessage}
              disabled={busy !== "idle"}
              onChange={(event) => setCommitMessage(event.target.value)}
              rows={3}
            />
          </Field>
          <RowActions>
            <PrimaryButton isDisabled={!canApply} onPress={() => void acceptApply()}>
              {busy === "applying" ? "正在接受应用…" : "接受应用"}
            </PrimaryButton>
            <QuietButton isDisabled={!canKeepPending} onPress={() => void keepPending()}>
              {busy === "pending" ? "正在保留…" : "保留待处理"}
            </QuietButton>
            <DangerButton isDisabled={!canDiscard} onPress={() => void discard()}>
              {busy === "discarding"
                ? "正在放弃…"
                : busy === "checking"
                  ? "验证运行中，无法放弃"
                  : "放弃修改"}
            </DangerButton>
          </RowActions>
          {preview?.reason ? <Notice>{preview.reason}</Notice> : null}
          {preview && !preview.canCompleteDevRun && !applied ? (
            <Notice tone="warning">
              提示：存在隔离修改时，开发型 Run 仅在成功「接受应用」后才能正式标记完成。
            </Notice>
          ) : null}
        </Stack>
      ) : null}
    </Panel>
  );
}
