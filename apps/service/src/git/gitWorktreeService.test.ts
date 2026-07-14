import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorktreeService, NodeGitRuntime, resolveSpawnArgv, type GitCommandResult, type GitRuntime } from "./gitWorktreeService.js";

class FakeGitRuntime implements GitRuntime {
  readonly commands: Array<{ args: string[]; cwd: string }> = [];
  readonly responses = new Map<string, GitCommandResult>();
  slowHandlers = new Map<string, () => Promise<GitCommandResult>>();

  async run(args: string[], cwd: string): Promise<GitCommandResult> {
    this.commands.push({ args, cwd });
    const key = args.join(" ");
    const slow = this.slowHandlers.get(key);
    if (slow) return slow();
    return this.responses.get(key) ?? { exitCode: 0, stdout: "", stderr: "" };
  }
}

const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

describe("Git worktree development loop contract", () => {
  let root: string;
  let runtime: FakeGitRuntime;
  let worktrees: GitWorktreeService;
  const mainWorkspace = "C:\\projects\\demo";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-worktrees-"));
    runtime = new FakeGitRuntime();
    worktrees = await GitWorktreeService.open(join(root, "worktrees.json"), runtime);
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function seedCleanGitResponses(workspace = mainWorkspace, commit = "abc123"): void {
    runtime.responses.set("rev-parse --is-inside-work-tree", { exitCode: 0, stdout: "true\n", stderr: "" });
    runtime.responses.set("rev-parse --show-toplevel", { exitCode: 0, stdout: `${workspace}\n`, stderr: "" });
    runtime.responses.set("rev-parse HEAD", { exitCode: 0, stdout: `${commit}\n`, stderr: "" });
    runtime.responses.set("status --porcelain=v1", { exitCode: 0, stdout: "", stderr: "" });
  }

  it("blocks an unsafe main workspace before creating an isolated worktree", async () => {
    runtime.responses.set("rev-parse --is-inside-work-tree", { exitCode: 0, stdout: "true\n", stderr: "" });
    runtime.responses.set("rev-parse --show-toplevel", { exitCode: 0, stdout: mainWorkspace + "\n", stderr: "" });
    runtime.responses.set("rev-parse HEAD", { exitCode: 0, stdout: "abc123\n", stderr: "" });
    runtime.responses.set("status --porcelain=v1", { exitCode: 0, stdout: " M src/app.ts\n", stderr: "" });

    await expect(worktrees.prepare("run-1", mainWorkspace)).rejects.toThrow("未提交修改");
    expect(runtime.commands.map((command) => command.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "HEAD"],
      ["status", "--porcelain=v1"]
    ]);
  });

  it("creates a detached worktree, keeps the main workspace untouched, captures full diff, runs approved checks, and discards the worktree", async () => {
    seedCleanGitResponses();
    runtime.responses.set("diff abc123 --name-only -z", { exitCode: 0, stdout: "src/app.ts\0test/app.test.ts\0", stderr: "" });
    runtime.responses.set("diff abc123 --no-ext-diff --binary", { exitCode: 0, stdout: "diff --git a/src/app.ts b/src/app.ts\n", stderr: "" });
    runtime.responses.set("status --porcelain=v1 -z --untracked-files=all", { exitCode: 0, stdout: "?? src/new.ts\0", stderr: "" });
    runtime.responses.set(`diff --no-index --no-ext-diff --binary -- ${nullDevice} src/new.ts`, {
      exitCode: 1,
      stdout: "diff --git a/src/new.ts b/src/new.ts\n",
      stderr: ""
    });
    runtime.responses.set("npm test", { exitCode: 0, stdout: "passed", stderr: "" });

    const prepared = await worktrees.prepare("run-2", mainWorkspace);
    expect(prepared).toMatchObject({
      runId: "run-2",
      mainWorkspacePath: mainWorkspace,
      baselineCommit: "abc123",
      status: "active",
      created: true
    });
    expect(prepared.workspacePath).not.toBe(mainWorkspace);
    expect(runtime.commands.find((command) => command.args[0] === "worktree")).toMatchObject({
      cwd: mainWorkspace,
      args: ["worktree", "add", "--detach", prepared.worktreePath, "abc123"]
    });

    await expect(worktrees.captureDiff("run-2")).resolves.toEqual({
      changedFiles: ["src/app.ts", "test/app.test.ts", "src/new.ts"],
      diff: "diff --git a/src/app.ts b/src/app.ts\ndiff --git a/src/new.ts b/src/new.ts\n"
    });
    await expect(worktrees.runApprovedChecks("run-2", [["npm", "test"]])).resolves.toEqual([
      { command: ["npm", "test"], exitCode: 0, stdout: "passed", stderr: "" }
    ]);
    await expect(worktrees.get("run-2")).resolves.toMatchObject({
      verificationResults: [{ command: ["npm", "test"], exitCode: 0, stdout: "passed" }]
    });
    await worktrees.discard("run-2");
    expect(runtime.commands.at(-1)).toMatchObject({ args: ["worktree", "remove", "--force", prepared.worktreePath], cwd: mainWorkspace });
    await expect(worktrees.get("run-2")).resolves.toMatchObject({ status: "discarded" });
  });

  it("reuses an existing active session without creating another Worktree", async () => {
    seedCleanGitResponses();
    const first = await worktrees.prepare("run-reuse", mainWorkspace);
    expect(first.created).toBe(true);
    runtime.commands.length = 0;

    const second = await worktrees.prepare("run-reuse", mainWorkspace);
    expect(second.created).toBe(false);
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(runtime.commands.some((command) => command.args[0] === "worktree")).toBe(false);
  });

  it("keeps a nested Project inside the matching relative path of its isolated Worktree", async () => {
    const nestedProject = join(mainWorkspace, "packages", "feature");
    runtime.responses.set("rev-parse --is-inside-work-tree", { exitCode: 0, stdout: "true\n", stderr: "" });
    runtime.responses.set("rev-parse --show-toplevel", { exitCode: 0, stdout: mainWorkspace + "\n", stderr: "" });
    runtime.responses.set("rev-parse HEAD", { exitCode: 0, stdout: "abc123\n", stderr: "" });
    runtime.responses.set("status --porcelain=v1", { exitCode: 0, stdout: "", stderr: "" });

    const prepared = await worktrees.prepare("run-nested", nestedProject);

    expect(prepared.workspacePath).toBe(join(prepared.worktreePath, "packages", "feature"));
    expect(runtime.commands.find((command) => command.args[0] === "worktree")).toMatchObject({ cwd: mainWorkspace });
  });

  it("redacts credentials before persisting verification output", async () => {
    seedCleanGitResponses();
    runtime.responses.set("npm test", { exitCode: 1, stdout: "GITHUB_TOKEN=ghp_topSecretToken123", stderr: "Authorization: Bearer a-secret" });
    await worktrees.prepare("run-secret", mainWorkspace);

    const results = await worktrees.runApprovedChecks("run-secret", [["npm", "test"]]);

    expect(JSON.stringify(results)).not.toContain("topSecretToken");
    expect(JSON.stringify(results)).not.toContain("a-secret");
    expect(JSON.stringify(await worktrees.get("run-secret"))).toContain("[REDACTED]");
  });

  it("rejects discard while verification is running and rejects verification after discard", async () => {
    seedCleanGitResponses();
    let releaseCheck: (() => void) | undefined;
    const checkStarted = new Promise<void>((resolve) => {
      runtime.slowHandlers.set("npm test", () => new Promise((settle) => {
        resolve();
        releaseCheck = () => settle({ exitCode: 0, stdout: "ok", stderr: "" });
      }));
    });
    await worktrees.prepare("run-lock", mainWorkspace);

    const verification = worktrees.runApprovedChecks("run-lock", [["npm", "test"]]);
    await checkStarted;
    await expect(worktrees.discard("run-lock")).rejects.toThrow(/验证/);
    releaseCheck?.();
    await verification;

    await worktrees.discard("run-lock");
    await expect(worktrees.runApprovedChecks("run-lock", [["npm", "test"]])).rejects.toThrow(/放弃/);
  });

  it("acquires verify/discard locks before any await so concurrent callers cannot interleave", async () => {
    seedCleanGitResponses();
    let releaseCheck: (() => void) | undefined;
    runtime.slowHandlers.set("npm test", () => new Promise((settle) => {
      releaseCheck = () => settle({ exitCode: 0, stdout: "ok", stderr: "" });
    }));
    await worktrees.prepare("run-race", mainWorkspace);

    // Start both in the same turn; lock is taken synchronously before active()/runtime awaits.
    const verification = worktrees.runApprovedChecks("run-race", [["npm", "test"]]);
    const discardAttempt = worktrees.discard("run-race");
    await expect(discardAttempt).rejects.toThrow(/验证/);
    const secondVerify = worktrees.runApprovedChecks("run-race", [["npm", "test"]]);
    await expect(secondVerify).rejects.toThrow(/正在运行/);
    releaseCheck?.();
    await verification;
  });

  it("resolves Windows npm/npx shims to node npm-cli without enabling a shell", () => {
    if (process.platform !== "win32") return;
    const npm = resolveSpawnArgv(["npm", "test"]);
    expect(npm.command).toBe(process.execPath);
    expect(npm.argv[0]).toMatch(/npm-cli\.js$/i);
    expect(npm.argv.slice(1)).toEqual(["test"]);
    const npx = resolveSpawnArgv(["npx", "tsc", "--version"]);
    expect(npx.command).toBe(process.execPath);
    expect(npx.argv[0]).toMatch(/npx-cli\.js$/i);
    expect(npx.argv.slice(1)).toEqual(["tsc", "--version"]);
  });

  it("rejects opening persisted schema v1 state until a safe migration is applied", async () => {
    const statePath = join(root, "legacy-worktrees.json");
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      sessions: [{ runId: "old", workspacePath: "C:\\old", status: "active" }]
    }, null, 2)}\n`, "utf8");

    await expect(GitWorktreeService.open(statePath, runtime)).rejects.toThrow(/safe migration|迁移/);
  });

  it("executes Git subcommands through the git executable in a real temporary repository", async () => {
    const repository = await mkdtemp(join(tmpdir(), "paw-real-git-"));
    const nodeRuntime = new NodeGitRuntime();
    try {
      await expect(nodeRuntime.run(["git", "init"], repository)).resolves.toMatchObject({ exitCode: 0 });
      await expect(nodeRuntime.run(["rev-parse", "--is-inside-work-tree"], repository)).resolves.toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining("true")
      });
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

describe("Git worktree real repository integration", () => {
  let root: string;
  let repository: string;
  let worktrees: GitWorktreeService;
  const runtime = new NodeGitRuntime();

  async function git(args: string[], cwd: string): Promise<void> {
    const result = await runtime.run(["git", ...args], cwd);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-worktree-it-"));
    repository = join(root, "repo");
    await mkdir(repository);
    await git(["init"], repository);
    await git(["config", "user.email", "worktree@example.test"], repository);
    await git(["config", "user.name", "Worktree Test"], repository);
    await writeFile(join(repository, "README.md"), "# demo\n", "utf8");
    await git(["add", "README.md"], repository);
    await git(["commit", "-m", "init"], repository);
    worktrees = await GitWorktreeService.open(join(root, "worktrees.json"), runtime);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates and discards a real Worktree without polluting the main workspace", async () => {
    const prepared = await worktrees.prepare("run-real", repository);
    expect(prepared.created).toBe(true);
    expect(prepared.baselineCommit).toMatch(/^[0-9a-f]{7,40}$/i);
    expect(prepared.workspacePath).toBe(prepared.worktreePath);

    await writeFile(join(prepared.workspacePath, "feature.ts"), "export const ok = 1;\n", "utf8");
    const mainStatus = await runtime.run(["status", "--porcelain=v1"], repository);
    expect(mainStatus.stdout.trim()).toBe("");

    await worktrees.discard("run-real");
    await expect(worktrees.get("run-real")).resolves.toMatchObject({ status: "discarded" });
    const after = await runtime.run(["status", "--porcelain=v1"], repository);
    expect(after.stdout.trim()).toBe("");
  });

  it("captures post-baseline diffs for modified, staged, committed, untracked, nested, and unicode paths", async () => {
    const prepared = await worktrees.prepare("run-diff", repository);
    const nestedDir = join(prepared.workspacePath, "nested", "dir");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(prepared.workspacePath, "README.md"), "# changed\n", "utf8");
    await writeFile(join(nestedDir, "中文 空格.ts"), "export const value = 'unicode';\n", "utf8");
    await writeFile(join(prepared.workspacePath, "staged.ts"), "export const staged = true;\n", "utf8");
    await git(["add", "staged.ts"], prepared.workspacePath);
    await writeFile(join(prepared.workspacePath, "committed.ts"), "export const committed = true;\n", "utf8");
    await git(["add", "committed.ts"], prepared.workspacePath);
    await git(["-c", "user.email=worktree@example.test", "-c", "user.name=Worktree Test", "commit", "-m", "in-worktree"], prepared.workspacePath);

    const diff = await worktrees.captureDiff("run-diff");
    expect(diff.changedFiles).toEqual(expect.arrayContaining([
      "README.md",
      "staged.ts",
      "committed.ts",
      "nested/dir/中文 空格.ts"
    ]));
    expect(diff.diff).toContain("README.md");
    expect(diff.diff).toContain("staged.ts");
    expect(diff.diff).toContain("committed.ts");
    // Git may quote non-ASCII paths with octal escapes in the patch header.
    expect(diff.diff.includes("中文 空格.ts") || diff.diff.includes("nested/dir/")).toBe(true);
    expect(diff.diff).toMatch(/unicode|value/);

    await worktrees.discard("run-diff");
  });

  it("runs verification commands in the Worktree workspace cwd and redacts secrets", async () => {
    const prepared = await worktrees.prepare("run-verify", repository);
    await writeFile(
      join(prepared.workspacePath, "print-secret.mjs"),
      "console.log('cwd=' + process.cwd()); console.log('GITHUB_TOKEN=ghp_topSecretToken123');\n",
      "utf8"
    );

    const results = await worktrees.runApprovedChecks("run-verify", [["node", "print-secret.mjs"]]);
    expect(results).toHaveLength(1);
    expect(results[0]?.exitCode).toBe(0);
    expect(results[0]?.stdout).toContain(`cwd=${prepared.workspacePath}`);
    expect(results[0]?.stdout).not.toContain("topSecretToken");
    expect(results[0]?.stdout).toContain("[REDACTED]");

    const persisted = await worktrees.get("run-verify");
    expect(JSON.stringify(persisted.verificationResults)).not.toContain("topSecretToken");
    await worktrees.discard("run-verify");
  });

  it("spawns plan-style npm verification without a shell on Windows", async () => {
    const prepared = await worktrees.prepare("run-npm", repository);
    await writeFile(
      join(prepared.workspacePath, "package.json"),
      JSON.stringify({ name: "paw-worktree-npm", private: true, scripts: { test: "node -e \"console.log('npm-ok')\"" } }),
      "utf8"
    );

    const results = await worktrees.runApprovedChecks("run-npm", [["npm", "test"]]);
    expect(results).toHaveLength(1);
    expect(results[0]?.exitCode).toBe(0);
    expect(results[0]?.stdout).toContain("npm-ok");
    await worktrees.discard("run-npm");
  });

  it("scopes nested Project Worktrees to the Project relative path", async () => {
    const nestedProject = join(repository, "packages", "feature");
    await mkdir(nestedProject, { recursive: true });
    await writeFile(join(nestedProject, "index.ts"), "export {};\n", "utf8");
    await git(["add", "packages/feature/index.ts"], repository);
    await git(["commit", "-m", "nested project"], repository);

    const prepared = await worktrees.prepare("run-nested-real", nestedProject);
    expect(prepared.workspacePath).toBe(join(prepared.worktreePath, "packages", "feature"));
    await writeFile(join(prepared.workspacePath, "local.ts"), "export const local = 1;\n", "utf8");

    const diff = await worktrees.captureDiff("run-nested-real");
    expect(diff.changedFiles).toContain("local.ts");
    expect(diff.changedFiles.every((file) => !file.startsWith("packages/"))).toBe(true);

    await worktrees.discard("run-nested-real");
  });
});
