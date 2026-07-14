import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

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
  status: "active" | "discarded";
  createdAt: string;
  updatedAt: string;
  verificationResults: VerificationResult[];
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
      session.updatedAt = new Date().toISOString();
      await this.persist();
      return session;
    } finally {
      this.discarding.delete(runId);
    }
  }

  private async active(runId: string): Promise<GitWorktreeSession> {
    const session = await this.get(runId);
    if (session.status !== "active") throw new Error("此 Run 的隔离 Worktree 已被放弃。");
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
  const gitSubcommand = ["rev-parse", "status", "worktree", "diff", "config", "add", "commit", "init"].includes(command);
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
