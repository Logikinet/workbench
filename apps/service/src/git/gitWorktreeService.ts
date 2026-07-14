import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  buildChineseCommitMessageDraft,
  canCompleteDevRunAfterWorktree,
  parsePorcelainPaths,
  parseUnmergedConflictFiles,
  type KeepPendingResult,
  type WorktreeApplyPreview,
  type WorktreeApplyRecord,
  type WorktreeApplyResult
} from "./worktreeApply.js";

export interface GitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Executes one local command without a shell; arguments are never interpolated. */
export interface GitRuntime {
  run(args: string[], cwd: string): Promise<GitCommandResult>;
}

export interface GitWorktreeSession {
  runId: string;
  mainWorkspacePath: string;
  /** Repository root used for `git worktree remove`; may be above the Project root. */
  repositoryPath: string;
  worktreePath: string;
  projectRelativePath: string;
  baselineCommit: string;
  workspacePath: string;
  /** active = isolatable; applied = merged into main; discarded = removed without apply. */
  status: "active" | "discarded" | "applied";
  createdAt: string;
  updatedAt: string;
  verificationResults: VerificationResult[];
  /** Accept / keep-pending / conflict / blocked state for the apply loop. */
  applyRecord?: WorktreeApplyRecord;
}

/** Result of prepare; `created` is ephemeral and not persisted. */
export type PreparedGitWorktreeSession = GitWorktreeSession & { created: boolean };

export interface VerificationResult {
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface GitWorktreeState {
  schemaVersion: 2;
  sessions: GitWorktreeSession[];
}

const emptyState = (): GitWorktreeState => ({ schemaVersion: 2, sessions: [] });
const maxVerificationOutputLength = 4_000;

/** Keeps code Runs in a detached Git worktree until the user accepts the changes. */
export class GitWorktreeService {
  private readonly verifying = new Set<string>();
  private readonly discarding = new Set<string>();
  private readonly applying = new Set<string>();

  private constructor(
    private readonly statePath: string,
    private readonly worktreeRoot: string,
    private state: GitWorktreeState,
    private readonly runtime: GitRuntime
  ) {}

  static async open(statePath: string, runtime: GitRuntime = new NodeGitRuntime()): Promise<GitWorktreeService> {
    let state = emptyState();
    try {
      const decoded = JSON.parse(await readFile(statePath, "utf8")) as Partial<GitWorktreeState>;
      if (decoded.schemaVersion !== 2 || !Array.isArray(decoded.sessions)) {
        throw new Error("Git worktree state requires a safe migration before it can be used. Schema v1 sessions cannot be loaded; discard legacy worktrees.json after manual cleanup, then restart.");
      }
      state = decoded as GitWorktreeState;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return new GitWorktreeService(statePath, join(dirname(statePath), "worktrees"), state, runtime);
  }

  async get(runId: string): Promise<GitWorktreeSession> {
    const session = this.state.sessions.find((entry) => entry.runId === runId);
    if (!session) throw new Error(`Git worktree session for Run ${runId} was not found.`);
    return session;
  }

  async isGitWorkspace(workspacePath: string): Promise<boolean> {
    const git = await this.runtime.run(["rev-parse", "--is-inside-work-tree"], workspacePath);
    return git.exitCode === 0 && git.stdout.trim() === "true";
  }

  async prepare(runId: string, mainWorkspacePath: string): Promise<PreparedGitWorktreeSession> {
    const existing = this.state.sessions.find((entry) => entry.runId === runId);
    if (existing?.status === "active") return { ...existing, created: false };
    if (!await this.isGitWorkspace(mainWorkspacePath)) {
      throw new Error("当前 Project 不是可识别的 Git 项目，无法创建隔离 Worktree。");
    }
    const root = await this.runtime.run(["rev-parse", "--show-toplevel"], mainWorkspacePath);
    const repositoryPath = root.exitCode === 0 ? root.stdout.trim() : "";
    if (!repositoryPath) throw new Error("无法确定 Git 仓库根目录；已阻止创建隔离 Worktree。");
    const projectRelativePath = relative(resolve(repositoryPath), resolve(mainWorkspacePath));
    if (projectRelativePath === ".." || projectRelativePath.startsWith(`..${sep}`)) {
      throw new Error("Project 不在其 Git 仓库根目录内；已阻止创建隔离 Worktree。");
    }
    const baseline = await this.runtime.run(["rev-parse", "HEAD"], repositoryPath);
    const baselineCommit = baseline.exitCode === 0 ? baseline.stdout.trim() : "";
    if (!baselineCommit) throw new Error("Git Project 需要至少一个初始提交才能创建可审查的隔离 Worktree。");
    const status = await this.runtime.run(["status", "--porcelain=v1"], mainWorkspacePath);
    if (status.exitCode !== 0) throw new Error("无法检查主工作区状态；已阻止创建隔离 Worktree。");
    if (status.stdout.trim()) throw new Error("主工作区存在未提交修改；请先处理后再启动代码 Run。");

    const worktreePath = join(this.worktreeRoot, runId);
    const workspacePath = projectRelativePath ? join(worktreePath, projectRelativePath) : worktreePath;
    await mkdir(this.worktreeRoot, { recursive: true });
    const created = await this.runtime.run(["worktree", "add", "--detach", worktreePath, baselineCommit], repositoryPath);
    if (created.exitCode !== 0) throw new Error("无法创建隔离 Git Worktree；主工作区未被修改。");
    const now = new Date().toISOString();
    const session: GitWorktreeSession = {
      runId,
      mainWorkspacePath,
      repositoryPath,
      worktreePath,
      projectRelativePath,
      baselineCommit,
      workspacePath,
      status: "active",
      createdAt: now,
      updatedAt: now,
      verificationResults: []
    };
    if (existing) Object.assign(existing, session); else this.state.sessions.push(session);
    await this.persist();
    return { ...session, created: true };
  }

  async captureDiff(runId: string): Promise<{ changedFiles: string[]; diff: string }> {
    const session = await this.active(runId);
    const scope = session.projectRelativePath ? ["--", session.projectRelativePath] : [];
    const files = await this.runtime.run(["diff", session.baselineCommit, "--name-only", "-z", ...scope], session.worktreePath);
    const diff = await this.runtime.run(["diff", session.baselineCommit, "--no-ext-diff", "--binary", ...scope], session.worktreePath);
    const status = await this.runtime.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", ...scope], session.worktreePath);
    if (files.exitCode !== 0 || diff.exitCode !== 0 || status.exitCode !== 0) throw new Error("无法读取 Worktree 修改清单或 Git Diff。");
    const untracked = status.stdout.split("\0")
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3));
    const untrackedDiffs: string[] = [];
    for (const file of untracked) {
      const result = await this.runtime.run(
        ["diff", "--no-index", "--no-ext-diff", "--binary", "--", process.platform === "win32" ? "NUL" : "/dev/null", file],
        session.worktreePath
      );
      // git diff --no-index returns 1 when files differ; CRLF warnings may appear on stderr.
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error("无法读取未跟踪文件的 Git Diff。");
      }
      untrackedDiffs.push(result.stdout);
    }
    return {
      changedFiles: [...new Set([
        ...files.stdout.split("\0").map((value) => displayProjectRelativePath(value, session.projectRelativePath)).filter(Boolean),
        ...untracked.map((value) => displayProjectRelativePath(value, session.projectRelativePath))
      ])],
      diff: `${diff.stdout}${untrackedDiffs.join("")}`
    };
  }

  async runApprovedChecks(runId: string, commands: string[][]): Promise<VerificationResult[]> {
    // Acquire exclusive lock before any await so concurrent HTTP callers cannot interleave.
    if (this.verifying.has(runId)) throw new Error("验证命令正在运行中。");
    if (this.discarding.has(runId)) throw new Error("此 Worktree 正在放弃或已放弃，无法运行验证。");
    if (commands.length === 0) throw new Error("至少需要一条已批准的验证命令。");
    for (const command of commands) {
      if (command.length === 0 || command.some((part) => !part.trim())) throw new Error("验证命令无效。");
    }
    this.verifying.add(runId);
    try {
      const session = await this.active(runId);
      const results: VerificationResult[] = [];
      for (const command of commands) {
        const result = await this.runtime.run(command, session.workspacePath);
        results.push({
          command: [...command],
          exitCode: result.exitCode,
          stdout: redactVerificationOutput(result.stdout).slice(0, maxVerificationOutputLength),
          stderr: redactVerificationOutput(result.stderr).slice(0, maxVerificationOutputLength)
        });
      }
      session.verificationResults.push(...results);
      session.updatedAt = new Date().toISOString();
      await this.persist();
      return results;
    } finally {
      this.verifying.delete(runId);
    }
  }

  async discard(runId: string): Promise<GitWorktreeSession> {
    // Acquire exclusive lock before any await so concurrent HTTP callers cannot interleave.
    if (this.verifying.has(runId)) throw new Error("验证运行中，无法放弃此 Worktree。");
    if (this.applying.has(runId)) throw new Error("正在应用此 Worktree，无法放弃。");
    if (this.discarding.has(runId)) throw new Error("正在放弃此 Worktree。");
    this.discarding.add(runId);
    try {
      const session = await this.active(runId);
      const removed = await this.runtime.run(
        ["worktree", "remove", "--force", session.worktreePath ?? session.workspacePath],
        session.repositoryPath ?? session.mainWorkspacePath
      );
      if (removed.exitCode !== 0) throw new Error("无法放弃此 Worktree；主工作区未被修改。");
      session.status = "discarded";
      const now = new Date().toISOString();
      session.updatedAt = now;
      session.applyRecord = {
        decision: "none",
        decidedAt: now,
        pushed: false,
        blockedReason: "用户放弃隔离修改；历史 Diff/审查记录已保留。"
      };
      await this.persist();
      return session;
    } finally {
      this.discarding.delete(runId);
    }
  }

  /**
   * Pre-check Main Workspace + draft Chinese commit message.
   * Does not mutate main or the worktree.
   */
  async previewApply(runId: string): Promise<WorktreeApplyPreview> {
    const session = await this.get(runId);
    if (session.status === "applied") {
      return {
        runId,
        ok: true,
        status: "already_applied",
        reason: "修改已成功应用到主工作区（本地提交，未推送）。",
        changedFiles: [],
        commitMessageDraft: session.applyRecord?.commitMessage ?? session.applyRecord?.commitMessageDraft ?? "",
        dirtyFiles: [],
        conflictFiles: session.applyRecord?.conflictFiles ?? [],
        mainHead: session.applyRecord?.mainHeadAtDecision,
        baselineCommit: session.baselineCommit,
        externalChangeDetected: session.applyRecord?.externalChangeDetected === true,
        applied: true,
        appliedCommitSha: session.applyRecord?.commitSha,
        pushed: false,
        canCompleteDevRun: true,
        applyRecord: session.applyRecord
      };
    }
    if (session.status === "discarded") {
      return {
        runId,
        ok: false,
        status: "no_session",
        reason: "隔离 Worktree 已放弃，无法再应用。",
        changedFiles: [],
        commitMessageDraft: "",
        dirtyFiles: [],
        conflictFiles: [],
        baselineCommit: session.baselineCommit,
        externalChangeDetected: false,
        applied: false,
        pushed: false,
        canCompleteDevRun: false,
        applyRecord: session.applyRecord
      };
    }

    const { changedFiles } = await this.captureDiff(runId);
    const draft = buildChineseCommitMessageDraft({ runId, changedFiles });
    const mainHead = await this.readHead(session.repositoryPath);
    const dirtyFiles = await this.readDirtyFiles(session.mainWorkspacePath);
    const externalChangeDetected = Boolean(mainHead && mainHead !== session.baselineCommit);
    const keepPending = session.applyRecord?.decision === "keep_pending";

    if (changedFiles.length === 0) {
      return {
        runId,
        ok: true,
        status: "no_changes",
        reason: "隔离 Worktree 无实际修改；无需应用到主工作区。",
        changedFiles: [],
        commitMessageDraft: draft,
        dirtyFiles,
        conflictFiles: [],
        mainHead,
        baselineCommit: session.baselineCommit,
        externalChangeDetected,
        applied: false,
        pushed: false,
        canCompleteDevRun: true,
        applyRecord: session.applyRecord
      };
    }

    if (dirtyFiles.length > 0) {
      return {
        runId,
        ok: false,
        status: "blocked",
        reason: "主工作区存在未提交修改；请先处理后再接受应用，以免覆盖用户改动。",
        changedFiles,
        commitMessageDraft: draft,
        dirtyFiles,
        conflictFiles: [],
        mainHead,
        baselineCommit: session.baselineCommit,
        externalChangeDetected,
        applied: false,
        pushed: false,
        canCompleteDevRun: false,
        applyRecord: session.applyRecord
      };
    }

    return {
      runId,
      ok: true,
      status: keepPending ? "keep_pending" : "ready",
      reason: keepPending
        ? "修改已保留待处理；可随时接受应用或放弃。"
        : externalChangeDetected
          ? "主工作区相对基线已有新提交；将尝试合并，冲突时会暂停并列出文件。"
          : "主工作区干净，可以接受应用（仅本地提交，不自动推送）。",
      changedFiles,
      commitMessageDraft: session.applyRecord?.commitMessageDraft ?? draft,
      dirtyFiles: [],
      conflictFiles: session.applyRecord?.conflictFiles ?? [],
      mainHead,
      baselineCommit: session.baselineCommit,
      externalChangeDetected,
      applied: false,
      pushed: false,
      canCompleteDevRun: canCompleteDevRunAfterWorktree({
        session,
        hasChangedFiles: changedFiles.length > 0
      }),
      applyRecord: session.applyRecord
    };
  }

  /**
   * Accept and apply isolated changes into the main workspace with a local commit.
   * Never pushes. Safe to retry after conflict/blocked; double-click while applying is rejected.
   * Already-applied is idempotent (no second commit).
   */
  async applyToMain(runId: string, options: { commitMessage?: string } = {}): Promise<WorktreeApplyResult> {
    if (this.applying.has(runId)) throw new Error("正在应用此 Worktree 修改。");
    if (this.verifying.has(runId)) throw new Error("验证运行中，无法应用此 Worktree。");
    if (this.discarding.has(runId)) throw new Error("正在放弃此 Worktree，无法应用。");
    this.applying.add(runId);
    try {
      const session = await this.get(runId);
      if (session.status === "applied" && session.applyRecord?.commitSha) {
        return {
          status: "already_applied",
          runId,
          commitSha: session.applyRecord.commitSha,
          commitMessage: session.applyRecord.commitMessage,
          pushed: false,
          sessionStatus: "applied",
          applyRecord: session.applyRecord,
          canCompleteDevRun: true,
          reason: "修改已应用；未创建重复提交，亦未推送。"
        };
      }
      if (session.status === "discarded") {
        return {
          status: "blocked",
          runId,
          reason: "隔离 Worktree 已放弃，无法应用。",
          pushed: false,
          sessionStatus: "discarded",
          applyRecord: session.applyRecord,
          canCompleteDevRun: false
        };
      }
      if (session.status !== "active") {
        throw new Error("此 Run 的隔离 Worktree 不可应用。");
      }

      const preview = await this.previewApply(runId);
      if (preview.status === "no_changes") {
        const now = new Date().toISOString();
        session.status = "applied";
        session.applyRecord = {
          decision: "applied",
          commitMessageDraft: preview.commitMessageDraft,
          commitMessage: options.commitMessage?.trim() || preview.commitMessageDraft,
          mainHeadAtDecision: preview.mainHead,
          baselineCommitAtDecision: session.baselineCommit,
          externalChangeDetected: preview.externalChangeDetected,
          appliedAt: now,
          decidedAt: now,
          pushed: false
        };
        session.updatedAt = now;
        // Remove empty worktree when safe.
        await this.runtime.run(
          ["worktree", "remove", "--force", session.worktreePath],
          session.repositoryPath
        );
        await this.persist();
        return {
          status: "no_changes",
          runId,
          reason: preview.reason,
          commitMessage: session.applyRecord.commitMessage,
          pushed: false,
          sessionStatus: "applied",
          applyRecord: session.applyRecord,
          canCompleteDevRun: true
        };
      }
      if (!preview.ok || preview.status === "blocked") {
        const now = new Date().toISOString();
        session.applyRecord = {
          decision: "blocked",
          commitMessageDraft: preview.commitMessageDraft,
          blockedReason: preview.reason,
          dirtyFiles: preview.dirtyFiles,
          mainHeadAtDecision: preview.mainHead,
          baselineCommitAtDecision: session.baselineCommit,
          externalChangeDetected: preview.externalChangeDetected,
          decidedAt: now,
          pushed: false
        };
        session.updatedAt = now;
        await this.persist();
        return {
          status: "blocked",
          runId,
          reason: preview.reason,
          dirtyFiles: preview.dirtyFiles,
          externalChangeDetected: preview.externalChangeDetected,
          pushed: false,
          sessionStatus: "active",
          applyRecord: session.applyRecord,
          canCompleteDevRun: false
        };
      }

      const commitMessage = (options.commitMessage?.trim() || preview.commitMessageDraft).trim();
      if (!commitMessage) throw new Error("提交说明不能为空。");

      // Ensure worktree changes are committed so main can merge a concrete SHA.
      const sourceCommit = await this.ensureWorktreeCommit(session, commitMessage);
      const mainHeadBefore = await this.readHead(session.repositoryPath);
      const externalChangeDetected = Boolean(mainHeadBefore && mainHeadBefore !== session.baselineCommit);

      // Merge into the Project checkout (main workspace path). Local identity overrides only.
      const merge = await this.runtime.run(
        [
          "git",
          "-c",
          "user.email=workbench@local",
          "-c",
          "user.name=Personal AI Workbench",
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          commitMessage,
          sourceCommit
        ],
        session.mainWorkspacePath
      );

      if (merge.exitCode !== 0) {
        const unmerged = await this.runtime.run(["ls-files", "-u"], session.mainWorkspacePath);
        const conflictFiles = parseUnmergedConflictFiles(unmerged.stdout);
        // Abort so main is not left half-merged; safe retry later.
        await this.runtime.run(["merge", "--abort"], session.mainWorkspacePath);
        // If abort failed and index still dirty, attempt hard reset to pre-merge HEAD.
        const stillDirty = await this.readDirtyFiles(session.mainWorkspacePath);
        if (stillDirty.length > 0 && mainHeadBefore) {
          await this.runtime.run(["reset", "--hard", mainHeadBefore], session.mainWorkspacePath);
          await this.runtime.run(["clean", "-fd"], session.mainWorkspacePath);
        }
        const now = new Date().toISOString();
        session.applyRecord = {
          decision: "conflict",
          commitMessageDraft: commitMessage,
          conflictFiles: conflictFiles.length ? conflictFiles : preview.changedFiles,
          blockedReason: "合并冲突；已中止合并并保留主工作区与隔离 Worktree，可处理冲突后重试。",
          mainHeadAtDecision: mainHeadBefore,
          baselineCommitAtDecision: session.baselineCommit,
          externalChangeDetected,
          decidedAt: now,
          pushed: false
        };
        session.updatedAt = now;
        await this.persist();
        return {
          status: "conflict",
          runId,
          reason: session.applyRecord.blockedReason,
          conflictFiles: session.applyRecord.conflictFiles,
          externalChangeDetected,
          pushed: false,
          sessionStatus: "active",
          applyRecord: session.applyRecord,
          canCompleteDevRun: false
        };
      }

      const commitSha = (await this.readHead(session.repositoryPath)) || sourceCommit;
      const now = new Date().toISOString();
      // Remove isolated worktree after successful apply; history stays on Run artifacts.
      const removed = await this.runtime.run(
        ["worktree", "remove", "--force", session.worktreePath],
        session.repositoryPath
      );
      if (removed.exitCode !== 0) {
        // Apply already succeeded on main; still mark applied but surface reason for cleanup.
        session.status = "applied";
        session.applyRecord = {
          decision: "applied",
          commitMessageDraft: preview.commitMessageDraft,
          commitMessage,
          commitSha,
          mainHeadAtDecision: commitSha,
          baselineCommitAtDecision: session.baselineCommit,
          externalChangeDetected,
          appliedAt: now,
          decidedAt: now,
          pushed: false,
          blockedReason: "已写入主工作区本地提交，但清理隔离 Worktree 失败；可手动删除。"
        };
        session.updatedAt = now;
        await this.persist();
        return {
          status: "applied",
          runId,
          commitSha,
          commitMessage,
          externalChangeDetected,
          pushed: false,
          sessionStatus: "applied",
          applyRecord: session.applyRecord,
          canCompleteDevRun: true,
          reason: session.applyRecord.blockedReason
        };
      }

      session.status = "applied";
      session.applyRecord = {
        decision: "applied",
        commitMessageDraft: preview.commitMessageDraft,
        commitMessage,
        commitSha,
        mainHeadAtDecision: commitSha,
        baselineCommitAtDecision: session.baselineCommit,
        externalChangeDetected,
        appliedAt: now,
        decidedAt: now,
        pushed: false
      };
      session.updatedAt = now;
      await this.persist();
      return {
        status: "applied",
        runId,
        commitSha,
        commitMessage,
        externalChangeDetected,
        pushed: false,
        sessionStatus: "applied",
        applyRecord: session.applyRecord,
        canCompleteDevRun: true,
        reason: "已成功应用到主工作区并生成本地提交；未执行 push。"
      };
    } finally {
      this.applying.delete(runId);
    }
  }

  /**
   * Keep isolated changes pending — does not modify main, does not remove worktree.
   * Development Run completion remains blocked until a later successful apply.
   */
  async keepPending(runId: string): Promise<KeepPendingResult> {
    if (this.applying.has(runId)) throw new Error("正在应用此 Worktree，无法保留待处理。");
    if (this.verifying.has(runId)) throw new Error("验证运行中，无法保留待处理。");
    if (this.discarding.has(runId)) throw new Error("正在放弃此 Worktree，无法保留待处理。");
    const session = await this.active(runId);
    const preview = await this.previewApply(runId);
    const now = new Date().toISOString();
    const applyRecord: WorktreeApplyRecord = {
      decision: "keep_pending",
      commitMessageDraft: preview.commitMessageDraft,
      mainHeadAtDecision: preview.mainHead,
      baselineCommitAtDecision: session.baselineCommit,
      externalChangeDetected: preview.externalChangeDetected,
      conflictFiles: preview.conflictFiles,
      decidedAt: now,
      pushed: false
    };
    session.applyRecord = applyRecord;
    session.updatedAt = now;
    await this.persist();
    return {
      runId,
      status: "keep_pending",
      sessionStatus: "active",
      applyRecord,
      canCompleteDevRun: false,
      pushed: false
    };
  }

  private async ensureWorktreeCommit(session: GitWorktreeSession, message: string): Promise<string> {
    // Stage project-scoped changes inside the isolated worktree.
    const scope = session.projectRelativePath ? ["--", session.projectRelativePath] : [];
    const add = await this.runtime.run(["add", "-A", ...scope], session.worktreePath);
    if (add.exitCode !== 0) throw new Error("无法在隔离 Worktree 中暂存修改。");

    const status = await this.runtime.run(["status", "--porcelain=v1", ...scope], session.worktreePath);
    if (status.exitCode !== 0) throw new Error("无法检查隔离 Worktree 状态。");

    if (status.stdout.trim()) {
      // Local identity only for the isolation commit; does not touch user global config.
      // Prefix with `git` so `-c` config overrides resolve correctly under shell-free spawn.
      const commit = await this.runtime.run(
        [
          "git",
          "-c",
          "user.email=workbench@local",
          "-c",
          "user.name=Personal AI Workbench",
          "commit",
          "-m",
          message,
          ...(scope.length ? scope : [])
        ],
        session.worktreePath
      );
      if (commit.exitCode !== 0) {
        throw new Error(`无法在隔离 Worktree 中创建可追踪提交：${commit.stderr || commit.stdout || "unknown error"}`);
      }
    }

    const head = await this.readHead(session.worktreePath);
    if (!head) throw new Error("无法读取隔离 Worktree 提交。");
    return head;
  }

  private async readHead(cwd: string): Promise<string | undefined> {
    const head = await this.runtime.run(["rev-parse", "HEAD"], cwd);
    if (head.exitCode !== 0) return undefined;
    const value = head.stdout.trim();
    return value || undefined;
  }

  private async readDirtyFiles(cwd: string): Promise<string[]> {
    const status = await this.runtime.run(["status", "--porcelain=v1"], cwd);
    if (status.exitCode !== 0) throw new Error("无法检查主工作区状态。");
    return parsePorcelainPaths(status.stdout);
  }

  private async active(runId: string): Promise<GitWorktreeSession> {
    const session = await this.get(runId);
    if (session.status === "discarded") throw new Error("此 Run 的隔离 Worktree 已被放弃。");
    if (session.status === "applied") throw new Error("此 Run 的隔离修改已应用到主工作区。");
    if (session.status !== "active") throw new Error("此 Run 的隔离 Worktree 不可用。");
    return session;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }
}

function redactVerificationOutput(value: string): string {
  return value
    .replace(/-----BEGIN [\s\S]*?-----END [\s\S]*?-----/g, "[REDACTED PEM BLOCK]")
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+[a-z0-9]+)?|redis|amqps?):\/\/[^\s'"`]+/gi, "[REDACTED CONNECTION URI]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/g, "[REDACTED]")
    .replace(/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*.+$/gim, "$1: [REDACTED]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._-]+/gi, "$1 [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b([A-Za-z_][A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|credential|private[_-]?key|database[_-]?url|connection(?:[_-]?string)?|key))\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1: [REDACTED]");
}

function displayProjectRelativePath(path: string, projectRelativePath: string): string {
  if (!path) return path;
  if (!projectRelativePath) return path;
  const prefix = `${projectRelativePath.replaceAll("\\", "/")}/`;
  return path.replaceAll("\\", "/").startsWith(prefix) ? path.replaceAll("\\", "/").slice(prefix.length) : path;
}

/**
 * Resolves argv for shell-free spawn. On Windows, npm/npx are .cmd shims that
 * fail under shell:false; rewrite them to `node <npm-cli.js>` when available.
 */
export function resolveSpawnArgv(args: string[]): { command: string; argv: string[] } {
  const [command, ...commandArgs] = args;
  if (!command) throw new Error("A local command is required.");
  const gitSubcommand = [
    "rev-parse", "status", "worktree", "diff", "config", "add", "commit", "init",
    "merge", "reset", "clean", "checkout", "cherry-pick", "ls-files", "log", "show",
    "branch", "stash", "restore", "rm", "mv", "fetch", "rebase", "tag"
  ].includes(command);
  if (gitSubcommand) return { command: "git", argv: args };

  if (process.platform === "win32") {
    const lower = command.toLowerCase();
    if (lower === "npm" || lower === "npx") {
      const cliName = lower === "npm" ? "npm-cli.js" : "npx-cli.js";
      const cliPath = join(dirname(process.execPath), "node_modules", "npm", "bin", cliName);
      if (existsSync(cliPath)) {
        return { command: process.execPath, argv: [cliPath, ...commandArgs] };
      }
    }
  }
  return { command, argv: commandArgs };
}

export class NodeGitRuntime implements GitRuntime {
  async run(args: string[], cwd: string): Promise<GitCommandResult> {
    const resolved = resolveSpawnArgv(args);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(resolved.command, resolved.argv, {
          cwd,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch {
        resolve({ exitCode: null, stdout: "", stderr: "" });
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: GitCommandResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
      child.once("error", () => finish({ exitCode: null, stdout, stderr }));
      child.once("close", (exitCode) => finish({ exitCode, stdout, stderr }));
    });
  }
}
