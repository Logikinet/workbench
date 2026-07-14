import { useEffect, useState } from "react";
import { createRunClient, type GitWorktreeDiffRecord, type RunRecord } from "../lib/runs.js";

interface GitWorktreePanelProps {
  serviceUrl: string;
  run: RunRecord;
  onNotice(message: string): void;
}

/** Shows isolated code changes; main workspace is never modified by this panel. */
export function GitWorktreePanel({ serviceUrl, run, onNotice }: GitWorktreePanelProps) {
  const client = createRunClient(serviceUrl);
  const [result, setResult] = useState<GitWorktreeDiffRecord | null>(null);
  const [busy, setBusy] = useState<"idle" | "checking" | "discarding">("idle");

  const load = async () => {
    try { setResult(await client.getWorktree(run.id)); }
    catch { setResult(null); }
  };

  useEffect(() => { void load(); }, [serviceUrl, run.id, run.updatedAt]);

  const runIsActive = run.status === "running" || run.execution.status === "running" || Boolean(run.execution.terminationUnconfirmed);
  const sessionDiscarded = result?.session.status === "discarded";
  const canRunChecks = busy === "idle" && !runIsActive && !sessionDiscarded;
  const canDiscard = busy === "idle" && !runIsActive && result?.session.status === "active";

  const discard = async () => {
    if (!canDiscard) return;
    setBusy("discarding");
    try {
      await client.discardWorktree(run.id);
      setResult(null);
      onNotice("已放弃此 Run 的隔离修改；主工作区未受影响。");
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

  if (!result) return null;
  return <section className="git-worktree-panel" aria-label="隔离 Git Worktree 修改">
    <header><p className="eyebrow">ISOLATED GIT WORKTREE</p><h4>修改与 Diff</h4></header>
    <p>当前修改位于隔离 Worktree；用户验收前不会写入主工作区。</p>
    <p>修改文件：{result.changedFiles.length ? result.changedFiles.join("、") : "无"}</p>
    <details><summary>查看完整 Git Diff</summary><pre>{result.diff || "没有未提交修改。"}</pre></details>
    {(run.planVersions.find((entry) => entry.version === run.planning?.approvedPlanVersion)?.verificationCommands?.length ?? 0) > 0 && (
      <button type="button" className="quiet-button" disabled={!canRunChecks} onClick={() => void runChecks()}>
        {busy === "checking" ? "验证运行中…" : "运行批准的验证"}
      </button>
    )}
    {result.session.verificationResults?.length ? <details><summary>查看已保存的验证结果</summary><ul>{result.session.verificationResults.map((entry, index) => <li key={`${entry.command.join(" ")}-${index}`}><strong>{entry.command.join(" ")}</strong> · exit {entry.exitCode ?? "unknown"}<pre>{entry.stdout}{entry.stderr ? `\n${entry.stderr}` : ""}</pre></li>)}</ul></details> : null}
    {result.session.status === "active" && (
      <button type="button" className="danger-button" disabled={!canDiscard} onClick={() => void discard()}>
        {busy === "discarding" ? "正在放弃…" : busy === "checking" ? "验证运行中，无法放弃" : "放弃本次隔离修改"}
      </button>
    )}
  </section>;
}
