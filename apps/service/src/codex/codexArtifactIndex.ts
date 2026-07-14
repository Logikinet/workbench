import type { GitWorktreeService, VerificationResult } from "../git/gitWorktreeService.js";
import {
  CODEX_WORKTREE_EVIDENCE_KIND,
  type ArtifactVerificationEvidence,
  type Run,
  type RunService,
  type WorktreeArtifactEvidence
} from "../runs/runService.js";

export type CodexArtifactOutcome = "success" | "failure" | "paused" | "interrupted";

export interface CodexArtifactIndexWorktrees {
  get(runId: string): Promise<{
    runId: string;
    worktreePath?: string;
    workspacePath: string;
    baselineCommit?: string;
    status: "active" | "discarded" | "applied";
    verificationResults: VerificationResult[];
  }>;
  captureDiff(runId: string): Promise<{ changedFiles: string[]; diff: string }>;
  runApprovedChecks?(runId: string, commands: string[][]): Promise<VerificationResult[]>;
}

export interface IndexCodexWorktreeArtifactsInput {
  runId: string;
  outcome: CodexArtifactOutcome;
  worktrees: CodexArtifactIndexWorktrees;
  runs: Pick<RunService, "get" | "recordCodexWorktreeArtifacts" | "recordLog">;
  /** When true and session is active with changes, run approved plan verification commands. */
  autoVerify?: boolean;
  verificationCommands?: string[][];
}

export interface IndexCodexWorktreeArtifactsResult {
  indexed: boolean;
  noModification: boolean;
  evidence?: WorktreeArtifactEvidence;
  run?: Run;
  reason?: string;
}

/** Maps git verification rows to structured evidence with an explicit `passed` flag. */
export function toVerificationEvidence(results: VerificationResult[]): ArtifactVerificationEvidence[] {
  return results.map((result) => ({
    command: [...result.command],
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    passed: result.exitCode === 0
  }));
}

export function buildWorktreeEvidence(input: {
  runId: string;
  worktreePath?: string;
  baselineCommit?: string;
  sessionStatus: WorktreeArtifactEvidence["sessionStatus"];
  changedFiles: string[];
  diff: string;
  verificationResults: ArtifactVerificationEvidence[];
  outcome: CodexArtifactOutcome;
  discarded?: boolean;
  consistency?: WorktreeArtifactEvidence["consistency"];
  consistencyNote?: string;
}): WorktreeArtifactEvidence {
  const changedFiles = [...new Set(input.changedFiles.map((file) => file.trim()).filter(Boolean))];
  const changeStatus: WorktreeArtifactEvidence["changeStatus"] =
    changedFiles.length > 0 ? "modified" : "no_modification";
  const verificationSummary = summarizeVerification(input.verificationResults);
  const outcomeLabel =
    input.outcome === "success"
      ? "成功"
      : input.outcome === "failure"
        ? "失败"
        : input.outcome === "interrupted"
          ? "中断"
          : "暂停";
  const summary =
    changeStatus === "no_modification"
      ? `Codex Worktree 索引（${outcomeLabel}）：无实际修改。`
      : `Codex Worktree 索引（${outcomeLabel}）：${changedFiles.length} 个文件变更；${verificationSummary}`;

  return {
    source: "codex-worktree",
    worktreeRunId: input.runId,
    worktreePath: input.worktreePath,
    baselineCommit: input.baselineCommit,
    sessionStatus: input.sessionStatus,
    changeStatus,
    discarded: input.discarded === true || input.sessionStatus === "discarded",
    changedFiles,
    diff: changeStatus === "modified" ? input.diff : "",
    verificationResults: input.verificationResults,
    summary,
    consistency: input.consistency ?? (input.sessionStatus === "missing" ? "missing_worktree" : "ok"),
    consistencyNote: input.consistencyNote
  };
}

export function summarizeVerification(results: ArtifactVerificationEvidence[]): string {
  if (results.length === 0) return "尚无结构化验证结果";
  const passed = results.filter((entry) => entry.passed).length;
  return `验证 ${passed}/${results.length} 通过（exitCode 结构化）`;
}

/**
 * Finds the normalized Codex evidence bundle on a Run (shared by Reviewer and PWA).
 */
export function findCodexWorktreeEvidence(run: Run): WorktreeArtifactEvidence | undefined {
  const bundle = run.artifacts.find((artifact) => artifact.kind === CODEX_WORKTREE_EVIDENCE_KIND && artifact.evidence?.source === "codex-worktree");
  return bundle?.evidence;
}

/**
 * After restart or on demand: compare artifact index with live worktree session.
 * Returns the reconciliation payload; callers persist via RunService when needed.
 */
export function assessWorktreeArtifactConsistency(
  run: Run,
  session: { status: "active" | "discarded" | "applied" } | null
): {
  needsUpdate: boolean;
  sessionStatus: "active" | "discarded" | "missing";
  consistency: "ok" | "missing_worktree" | "stale";
  consistencyNote?: string;
} {
  const evidence = findCodexWorktreeEvidence(run);
  if (!evidence) {
    // Applied sessions are terminal for isolation; map to discarded-like for evidence shape.
    if (session?.status === "applied") {
      return { needsUpdate: false, sessionStatus: "discarded", consistency: "ok" };
    }
    return {
      needsUpdate: false,
      sessionStatus: session?.status === "discarded" || session?.status === "active" ? session.status : "missing",
      consistency: "ok"
    };
  }
  if (!session) {
    if (evidence.sessionStatus === "missing" && evidence.consistency === "missing_worktree") {
      return {
        needsUpdate: false,
        sessionStatus: "missing",
        consistency: "missing_worktree",
        consistencyNote: evidence.consistencyNote
      };
    }
    return {
      needsUpdate: true,
      sessionStatus: "missing",
      consistency: "missing_worktree",
      consistencyNote: "隔离 Worktree 已缺失；Artifact 索引仍保留历史 Diff，请恢复 Worktree 或重新执行 Codex。"
    };
  }
  if (session.status === "applied") {
    // Isolation removed after successful apply; keep historical evidence, do not flag missing.
    if (evidence.discarded || evidence.sessionStatus === "discarded") {
      return { needsUpdate: false, sessionStatus: "discarded", consistency: "ok" };
    }
    return {
      needsUpdate: true,
      sessionStatus: "discarded",
      consistency: "ok",
      consistencyNote: "隔离修改已成功应用到主工作区（本地提交，未推送）；历史 Diff 保留。"
    };
  }
  if (session.status === "discarded") {
    if (evidence.discarded && evidence.sessionStatus === "discarded") {
      return { needsUpdate: false, sessionStatus: "discarded", consistency: "ok" };
    }
    return {
      needsUpdate: true,
      sessionStatus: "discarded",
      consistency: "ok",
      consistencyNote: "隔离 Worktree 已放弃；历史 Diff 与证据保留。"
    };
  }
  if (evidence.sessionStatus !== "active" || evidence.consistency === "missing_worktree" || evidence.discarded) {
    return {
      needsUpdate: true,
      sessionStatus: "active",
      consistency: "ok",
      consistencyNote: "隔离 Worktree 已恢复为可用。"
    };
  }
  return { needsUpdate: false, sessionStatus: "active", consistency: "ok" };
}

/**
 * After Codex success/fail/pause/interrupt: refresh Worktree diff and register Run artifacts.
 * No-modification runs get an explicit marker without fake file artifacts.
 */
export async function indexCodexWorktreeArtifacts(
  input: IndexCodexWorktreeArtifactsInput
): Promise<IndexCodexWorktreeArtifactsResult> {
  const { runId, worktrees, runs } = input;
  let session: Awaited<ReturnType<CodexArtifactIndexWorktrees["get"]>>;
  try {
    session = await worktrees.get(runId);
  } catch {
    return { indexed: false, noModification: true, reason: "no_worktree_session" };
  }

  if (session.status === "discarded" || session.status === "applied") {
    const evidence = buildWorktreeEvidence({
      runId,
      worktreePath: session.worktreePath ?? session.workspacePath,
      baselineCommit: session.baselineCommit,
      sessionStatus: "discarded",
      changedFiles: [],
      diff: "",
      verificationResults: toVerificationEvidence(session.verificationResults ?? []),
      outcome: input.outcome,
      discarded: session.status === "discarded",
      consistencyNote:
        session.status === "applied"
          ? "隔离修改已应用到主工作区（本地提交，未推送）。"
          : undefined
    });
    const run = await runs.recordCodexWorktreeArtifacts(runId, {
      evidence,
      changedFiles: []
    });
    return { indexed: true, noModification: true, evidence, run };
  }

  let changedFiles: string[] = [];
  let diff = "";
  try {
    const captured = await worktrees.captureDiff(runId);
    changedFiles = captured.changedFiles;
    diff = captured.diff;
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取 Worktree Diff";
    try {
      await runs.recordLog(runId, { level: "warn", message: `Worktree 索引：${message}` });
    } catch {
      /* log best-effort */
    }
    return { indexed: false, noModification: true, reason: message };
  }

  let verificationResults = toVerificationEvidence(session.verificationResults ?? []);
  if (
    input.autoVerify
    && changedFiles.length > 0
    && (input.verificationCommands?.length ?? 0) > 0
    && worktrees.runApprovedChecks
  ) {
    try {
      const fresh = await worktrees.runApprovedChecks(runId, input.verificationCommands!);
      verificationResults = toVerificationEvidence(fresh);
    } catch (error) {
      const message = error instanceof Error ? error.message : "自动验证失败";
      try {
        await runs.recordLog(runId, { level: "warn", message: `Worktree 自动验证：${message}` });
      } catch {
        /* keep prior verificationResults */
      }
    }
  }

  const evidence = buildWorktreeEvidence({
    runId,
    worktreePath: session.worktreePath ?? session.workspacePath,
    baselineCommit: session.baselineCommit,
    sessionStatus: "active",
    changedFiles,
    diff,
    verificationResults,
    outcome: input.outcome
  });

  const run = await runs.recordCodexWorktreeArtifacts(runId, {
    evidence,
    changedFiles: evidence.changeStatus === "modified" ? evidence.changedFiles : []
  });

  return {
    indexed: true,
    noModification: evidence.changeStatus === "no_modification",
    evidence,
    run
  };
}

/** Worktree DI surface used by Codex CLI for prepare/index/discard. */
export type CodexWorktreeDependency = Pick<
  GitWorktreeService,
  "isGitWorkspace" | "prepare" | "discard" | "get" | "captureDiff"
> & {
  runApprovedChecks?: GitWorktreeService["runApprovedChecks"];
};
