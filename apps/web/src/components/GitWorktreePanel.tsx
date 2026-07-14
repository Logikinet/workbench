import { useEffect, useState } from "react";
import {
  createRunClient,
  type GitWorktreeDiffRecord,
  type RunRecord,
  type WorktreeApplyPreviewRecord,
  type WorktreeApplyResultRecord
} from "../lib/runs.js";

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

  useEffect(() => { void load(); }, [serviceUrl, run.id, run.updatedAt]);

  const runIsActive = run.status === "running" || run.execution.status === "running" || Boolean(run.execution.terminationUnconfirmed);
  const sessionUnavailable = result?.session.status === "discarded" || result?.session.status === "missing" || result?.session.status === "applied";
  const canRunChecks = busy === "idle" && !runIsActive && !sessionUnavailable && result?.session.status === "active";
  const canDiscard = busy === "idle" && !runIsActive && result?.session.status === "active";
  const canApply = busy === "idle" && !runIsActive && result?.session.status === "active" && preview?.ok !== false
    && preview?.status !== "already_applied" && preview?.status !== "no_session";
  const canKeepPending = busy === "idle" && !runIsActive && result?.session.status === "active";

  const discard = async () => {
    if (!canDiscard) return;
    setBusy("discarding");
    try {
      await client.discardWorktree(run.id);
      setLastApply(null);
      await load();
      onNotice("已放弃此 Run 的隔离修改；历史 Artifact 已标记丢弃，主工作区未受影响。开发型 Run 未因放弃而标记完成。");
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
      const applied = await client.applyWorktree(run.id, { commitMessage: commitMessage.trim() || undefined });
      setLastApply(applied);
      await load();
      if (applied.status === "applied" || applied.status === "already_applied" || applied.status === "no_changes") {
        onNotice(
          applied.status === "no_changes"
            ? "无实际修改；已关闭隔离 Worktree。开发型 Run 可进入正式完成。"
            : `已接受并应用到主工作区（本地提交 ${applied.commitSha?.slice(0, 8) ?? ""}，未推送）。开发型 Run 可在此后正式标记完成。`
        );
      } else if (applied.status === "conflict") {
        onNotice(`合并冲突，已暂停并保留主工作区与隔离区。冲突文件：${(applied.conflictFiles ?? []).join("、") || "见详情"}。可处理后重试。`);
      } else if (applied.status === "blocked") {
        onNotice(applied.reason ?? `主工作区不可应用：${(applied.dirtyFiles ?? []).join("、") || "请检查脏状态或外部变更"}`);
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
  const conflictFiles = lastApply?.conflictFiles ?? preview?.conflictFiles ?? result.session.applyRecord?.conflictFiles ?? [];
  const dirtyFiles = lastApply?.dirtyFiles ?? preview?.dirtyFiles ?? result.session.applyRecord?.dirtyFiles ?? [];
  const applied = result.session.status === "applied" || preview?.status === "already_applied";
  const keepPendingMarked = preview?.status === "keep_pending" || result.session.applyRecord?.decision === "keep_pending";

  return <section className="git-worktree-panel" aria-label="隔离 Git Worktree 修改">
    <header><p className="eyebrow">ISOLATED GIT WORKTREE</p><h4>修改、验收与应用</h4></header>
    <p>当前修改位于隔离 Worktree；用户选择「接受应用」前不会写入主工作区，且永不自动 Push。</p>
    {evidence && <p role="status">Artifact 索引：{evidence.summary}</p>}
    {evidence?.discarded && <p role="status">Worktree 已放弃；历史 Diff 与证据保留。</p>}
    {applied && (
      <p role="status">
        已成功应用到主工作区
        {preview?.appliedCommitSha || result.session.applyRecord?.commitSha
          ? `（提交 ${(preview?.appliedCommitSha ?? result.session.applyRecord?.commitSha ?? "").slice(0, 8)}，未推送）`
          : "（未推送）"}
        。开发型 Run 可正式标记完成。
      </p>
    )}
    {keepPendingMarked && !applied && <p role="status">已保留待处理；可稍后接受应用或放弃修改。</p>}
    {result.consistency === "missing_worktree" && (
      <p role="alert">{result.consistencyNote ?? "Worktree 已缺失；请恢复隔离区或重新执行 Codex。"}</p>
    )}
    {changeStatus === "no_modification" && <p role="status">无实际修改；未生成虚假成果 Artifact。</p>}
    {preview?.externalChangeDetected && !applied && (
      <p role="status">主工作区相对基线已有新提交；接受应用时将尝试合并，冲突会暂停并列出文件。</p>
    )}
    {dirtyFiles.length > 0 && !applied && (
      <p role="alert">主工作区脏文件（请先处理）：{dirtyFiles.join("、")}</p>
    )}
    {conflictFiles.length > 0 && !applied && (
      <p role="alert">合并冲突文件：{conflictFiles.join("、")}。已中止合并，可安全重试。</p>
    )}
    <p>修改文件：{result.changedFiles.length ? result.changedFiles.join("、") : "无"}</p>
    {evidence?.worktreeRunId && <p>Worktree 标识：{evidence.worktreeRunId}</p>}
    <details><summary>查看完整 Git Diff</summary><pre>{result.diff || "没有未提交修改。"}</pre></details>
    {(run.planVersions.find((entry) => entry.version === run.planning?.approvedPlanVersion)?.verificationCommands?.length ?? 0) > 0 && (
      <button type="button" className="quiet-button" disabled={!canRunChecks} onClick={() => void runChecks()}>
        {busy === "checking" ? "验证运行中…" : "运行批准的验证"}
      </button>
    )}
    {verificationRows.length ? <details><summary>查看已保存的验证结果（结构化）</summary><ul>{verificationRows.map((entry, index) => <li key={`${entry.command.join(" ")}-${index}`}><strong>{entry.command.join(" ")}</strong> · exit {entry.exitCode ?? "unknown"} · passed={String(entry.passed)}<pre>{entry.stdout}{entry.stderr ? `\n${entry.stderr}` : ""}</pre></li>)}</ul></details> : null}

    {result.session.status === "active" && (
      <div className="worktree-acceptance-actions" aria-label="Worktree 验收动作">
        <p className="eyebrow">验收动作</p>
        <label>
          中文提交说明草案（可编辑；仅本地提交，不推送）
          <textarea
            aria-label="中文提交说明草案"
            value={commitMessage}
            disabled={busy !== "idle"}
            onChange={(event) => setCommitMessage(event.target.value)}
            rows={3}
          />
        </label>
        <div className="worktree-action-buttons">
          <button type="button" disabled={!canApply} onClick={() => void acceptApply()}>
            {busy === "applying" ? "正在接受应用…" : "接受应用"}
          </button>
          <button type="button" className="quiet-button" disabled={!canKeepPending} onClick={() => void keepPending()}>
            {busy === "pending" ? "正在保留…" : "保留待处理"}
          </button>
          <button type="button" className="danger-button" disabled={!canDiscard} onClick={() => void discard()}>
            {busy === "discarding" ? "正在放弃…" : busy === "checking" ? "验证运行中，无法放弃" : "放弃修改"}
          </button>
        </div>
        {preview?.reason && <p role="status">{preview.reason}</p>}
        {preview && !preview.canCompleteDevRun && !applied && (
          <p role="status">提示：存在隔离修改时，开发型 Run 仅在成功「接受应用」后才能正式标记完成。</p>
        )}
      </div>
    )}
  </section>;
}
