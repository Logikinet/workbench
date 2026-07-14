/**
 * Worktree accept / apply / keep-pending helpers.
 * Git merge into Main Workspace; never auto-push.
 * Run-layer completion gates should call `canCompleteDevRunAfterWorktree`.
 */

export type WorktreeApplyDecision =
  | "none"
  | "keep_pending"
  | "applied"
  | "conflict"
  | "blocked";

export interface WorktreeApplyRecord {
  decision: WorktreeApplyDecision;
  /** Chinese commit message draft for user confirmation (never auto-pushed). */
  commitMessageDraft?: string;
  /** Message used for the local commit after a successful apply. */
  commitMessage?: string;
  commitSha?: string;
  conflictFiles?: string[];
  blockedReason?: string;
  dirtyFiles?: string[];
  mainHeadAtDecision?: string;
  baselineCommitAtDecision?: string;
  /** True when main HEAD moved past the worktree baseline before apply. */
  externalChangeDetected?: boolean;
  appliedAt?: string;
  decidedAt?: string;
  /** Always false — this product never auto-pushes. */
  pushed: false;
}

export type WorktreeApplyOutcomeStatus =
  | "applied"
  | "conflict"
  | "blocked"
  | "already_applied"
  | "busy"
  | "no_changes"
  | "keep_pending";

export interface WorktreeApplyPreview {
  runId: string;
  ok: boolean;
  status: "ready" | "blocked" | "already_applied" | "no_session" | "no_changes" | "keep_pending";
  reason?: string;
  changedFiles: string[];
  commitMessageDraft: string;
  dirtyFiles: string[];
  conflictFiles: string[];
  mainHead?: string;
  baselineCommit?: string;
  externalChangeDetected: boolean;
  /** True only after a successful local apply; never means pushed. */
  applied: boolean;
  appliedCommitSha?: string;
  pushed: false;
  /** Gate for development Runs: formal complete only after successful apply when changes exist. */
  canCompleteDevRun: boolean;
  applyRecord?: WorktreeApplyRecord;
}

export interface WorktreeApplyResult {
  status: WorktreeApplyOutcomeStatus;
  runId: string;
  reason?: string;
  commitSha?: string;
  commitMessage?: string;
  conflictFiles?: string[];
  dirtyFiles?: string[];
  externalChangeDetected?: boolean;
  /** Always false — callers must not treat apply as remote publish. */
  pushed: false;
  sessionStatus: "active" | "discarded" | "applied";
  applyRecord?: WorktreeApplyRecord;
  canCompleteDevRun: boolean;
}

export interface KeepPendingResult {
  runId: string;
  status: "keep_pending";
  sessionStatus: "active";
  applyRecord: WorktreeApplyRecord;
  canCompleteDevRun: false;
  pushed: false;
}

/** Builds a user-confirmable Chinese commit message draft from changed paths. */
export function buildChineseCommitMessageDraft(input: {
  runId: string;
  changedFiles: string[];
  summary?: string;
}): string {
  const files = [...new Set(input.changedFiles.map((file) => file.trim()).filter(Boolean))];
  if (files.length === 0) {
    return `应用 Run ${input.runId} 的隔离 Worktree 修改（无文件变更）。`;
  }
  const preview = files.slice(0, 8).join("、");
  const more = files.length > 8 ? ` 等 ${files.length} 个文件` : `（${files.length} 个文件）`;
  const summary = input.summary?.trim();
  if (summary) {
    return `应用 Run ${input.runId} 的隔离修改：${summary}。涉及：${preview}${more}。`;
  }
  return `应用 Run ${input.runId} 的隔离 Worktree 修改：${preview}${more}。`;
}

/**
 * Development Runs with real Worktree modifications may complete only after a successful apply.
 * Discard / keep-pending / unresolved conflict do not unlock formal completion via this gate.
 * No session or no_modification → nothing to apply → gate open.
 */
export function canCompleteDevRunAfterWorktree(input: {
  session: {
    status: "active" | "discarded" | "applied" | "missing";
    applyRecord?: WorktreeApplyRecord;
  } | null | undefined;
  changeStatus?: "modified" | "no_modification";
  hasChangedFiles?: boolean;
}): boolean {
  if (!input.session || input.session.status === "missing") {
    return true;
  }
  const modified =
    input.changeStatus === "modified"
    || (input.changeStatus !== "no_modification" && input.hasChangedFiles === true);
  if (input.changeStatus === "no_modification" || input.hasChangedFiles === false) {
    return true;
  }
  if (!modified && input.hasChangedFiles === undefined && input.changeStatus === undefined) {
    // Unknown change set: only unlock after explicit applied.
    return input.session.status === "applied" || input.session.applyRecord?.decision === "applied";
  }
  if (input.session.status === "applied" || input.session.applyRecord?.decision === "applied") {
    return true;
  }
  return false;
}

/** Parses `git status --porcelain=v1` paths (supports rename `R  a -> b` lightly). */
export function parsePorcelainPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      // XY<space>path or XY<path for some formats; porcelain v1 is "XY path"
      if (line.length < 4) return "";
      const pathPart = line.slice(3);
      if (pathPart.includes(" -> ")) {
        return pathPart.split(" -> ").at(-1)?.trim() ?? pathPart.trim();
      }
      return pathPart.trim();
    })
    .filter(Boolean);
}

/** Parses unmerged paths from `git ls-files -u` (stage entries). */
export function parseUnmergedConflictFiles(stdout: string): string[] {
  const files = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // format: <mode> <hash> <stage>\t<path>
    const tab = trimmed.indexOf("\t");
    if (tab >= 0) {
      files.add(trimmed.slice(tab + 1).trim());
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const path = parts.at(-1);
    if (path) files.add(path);
  }
  return [...files];
}

/** True when an error message indicates apply/verify/discard mutual exclusion. */
export function isWorktreeApplyBusyMessage(message: string): boolean {
  return /正在应用|应用进行中|验证命令正在运行中|验证运行中|正在放弃|正在保留待处理/.test(message);
}
