import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorktreeService, NodeGitRuntime } from "./gitWorktreeService.js";
import {
  buildChineseCommitMessageDraft,
  canCompleteDevRunAfterWorktree,
  parsePorcelainPaths,
  parseUnmergedConflictFiles
} from "./worktreeApply.js";

describe("worktree apply helpers", () => {
  it("builds a Chinese commit message draft listing changed files", () => {
    const draft = buildChineseCommitMessageDraft({
      runId: "run-42",
      changedFiles: ["src/a.ts", "src/b.ts"]
    });
    expect(draft).toContain("run-42");
    expect(draft).toContain("src/a.ts");
    expect(draft).toMatch(/应用|修改/);
  });

  it("gates Dev Run completion only after successful apply when files changed", () => {
    expect(canCompleteDevRunAfterWorktree({
      session: { status: "active" },
      hasChangedFiles: true
    })).toBe(false);
    expect(canCompleteDevRunAfterWorktree({
      session: { status: "active", applyRecord: { decision: "keep_pending", pushed: false } },
      hasChangedFiles: true
    })).toBe(false);
    expect(canCompleteDevRunAfterWorktree({
      session: { status: "discarded" },
      hasChangedFiles: true
    })).toBe(false);
    expect(canCompleteDevRunAfterWorktree({
      session: { status: "applied", applyRecord: { decision: "applied", pushed: false, commitSha: "abc" } },
      hasChangedFiles: true
    })).toBe(true);
    expect(canCompleteDevRunAfterWorktree({
      session: { status: "active" },
      changeStatus: "no_modification"
    })).toBe(true);
    expect(canCompleteDevRunAfterWorktree({ session: null })).toBe(true);
  });

  it("parses porcelain and unmerged conflict paths", () => {
    expect(parsePorcelainPaths(" M src/a.ts\n?? new.ts\n")).toEqual(["src/a.ts", "new.ts"]);
    expect(parseUnmergedConflictFiles("100644 abc 1\tREADME.md\n100644 def 2\tREADME.md\n")).toEqual(["README.md"]);
  });
});

describe("Worktree accept / apply / discard loop (real git)", () => {
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
    root = await mkdtemp(join(tmpdir(), "paw-apply-it-"));
    repository = join(root, "repo");
    await mkdir(repository);
    await git(["init"], repository);
    await git(["config", "user.email", "apply@example.test"], repository);
    await git(["config", "user.name", "Apply Test"], repository);
    await writeFile(join(repository, "README.md"), "# demo\n", "utf8");
    await git(["add", "README.md"], repository);
    await git(["commit", "-m", "init"], repository);
    // Normalize branch name after the first commit (portable across git defaults).
    await git(["checkout", "-B", "main"], repository);
    worktrees = await GitWorktreeService.open(join(root, "worktrees.json"), runtime);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("applies successfully with a trackable local commit and never pushes", async () => {
    const prepared = await worktrees.prepare("run-ok", repository);
    await writeFile(join(prepared.workspacePath, "feature.ts"), "export const ok = 1;\n", "utf8");

    const preview = await worktrees.previewApply("run-ok");
    expect(preview.ok).toBe(true);
    expect(preview.status).toBe("ready");
    expect(preview.changedFiles).toContain("feature.ts");
    expect(preview.commitMessageDraft).toMatch(/应用|修改/);
    expect(preview.pushed).toBe(false);
    expect(preview.canCompleteDevRun).toBe(false);

    const applied = await worktrees.applyToMain("run-ok", {
      commitMessage: "应用 Run run-ok 的隔离修改：新增 feature.ts。"
    });
    expect(applied.status).toBe("applied");
    expect(applied.pushed).toBe(false);
    expect(applied.canCompleteDevRun).toBe(true);
    expect(applied.commitSha).toMatch(/^[0-9a-f]{7,40}$/i);
    expect(await readFile(join(repository, "feature.ts"), "utf8")).toContain("export const ok");

    const log = await runtime.run(["log", "-1", "--pretty=%s"], repository);
    expect(log.stdout).toContain("feature.ts");

    // Idempotent double-accept: no second commit / no push.
    const headAfter = (await runtime.run(["rev-parse", "HEAD"], repository)).stdout.trim();
    const again = await worktrees.applyToMain("run-ok");
    expect(again.status).toBe("already_applied");
    expect(again.commitSha).toBe(headAfter);
    expect(again.pushed).toBe(false);
    const headStill = (await runtime.run(["rev-parse", "HEAD"], repository)).stdout.trim();
    expect(headStill).toBe(headAfter);

    await expect(worktrees.get("run-ok")).resolves.toMatchObject({ status: "applied" });
  }, 30_000);

  it("blocks apply when main workspace is dirty and allows safe retry after cleanup", async () => {
    const prepared = await worktrees.prepare("run-dirty", repository);
    await writeFile(join(prepared.workspacePath, "feature.ts"), "export const feature = 1;\n", "utf8");
    await writeFile(join(repository, "local-wip.ts"), "export const wip = true;\n", "utf8");

    const preview = await worktrees.previewApply("run-dirty");
    expect(preview.ok).toBe(false);
    expect(preview.status).toBe("blocked");
    expect(preview.dirtyFiles.some((file) => file.includes("local-wip"))).toBe(true);

    const blocked = await worktrees.applyToMain("run-dirty");
    expect(blocked.status).toBe("blocked");
    expect(blocked.canCompleteDevRun).toBe(false);
    expect(blocked.pushed).toBe(false);
    // Main must not receive feature.ts while blocked.
    await expect(readFile(join(repository, "feature.ts"), "utf8")).rejects.toThrow();

    // Recover: clean main dirty state, retry apply.
    await rm(join(repository, "local-wip.ts"));
    const recovered = await worktrees.applyToMain("run-dirty", {
      commitMessage: "应用 Run run-dirty 的隔离修改。"
    });
    expect(recovered.status).toBe("applied");
    expect(recovered.canCompleteDevRun).toBe(true);
    expect(await readFile(join(repository, "feature.ts"), "utf8")).toContain("feature");
  }, 30_000);

  it("pauses on merge conflict with file list and leaves main recoverable for retry", async () => {
    const prepared = await worktrees.prepare("run-conflict", repository);
    await writeFile(join(prepared.workspacePath, "README.md"), "# worktree change\n", "utf8");

    // External change on main (same file).
    await writeFile(join(repository, "README.md"), "# main change\n", "utf8");
    await git(["add", "README.md"], repository);
    await git(["commit", "-m", "main advances"], repository);

    const preview = await worktrees.previewApply("run-conflict");
    expect(preview.externalChangeDetected).toBe(true);

    const result = await worktrees.applyToMain("run-conflict", {
      commitMessage: "应用冲突修改。"
    });
    expect(result.status).toBe("conflict");
    expect(result.conflictFiles?.length).toBeGreaterThan(0);
    expect(result.conflictFiles?.some((file) => file.includes("README"))).toBe(true);
    expect(result.canCompleteDevRun).toBe(false);
    expect(result.pushed).toBe(false);

    // Merge aborted: main should not be left in conflicted state.
    const mainStatus = await runtime.run(["status", "--porcelain=v1"], repository);
    expect(mainStatus.stdout).not.toMatch(/^(UU|AA)/m);
    expect(await readFile(join(repository, "README.md"), "utf8")).toContain("main change");

    // Session remains active for retry / discard.
    await expect(worktrees.get("run-conflict")).resolves.toMatchObject({
      status: "active",
      applyRecord: { decision: "conflict" }
    });
  }, 30_000);

  it("keep-pending leaves worktree and blocks Dev Run completion", async () => {
    const prepared = await worktrees.prepare("run-pending", repository);
    await writeFile(join(prepared.workspacePath, "later.ts"), "export const later = 1;\n", "utf8");

    const pending = await worktrees.keepPending("run-pending");
    expect(pending.status).toBe("keep_pending");
    expect(pending.canCompleteDevRun).toBe(false);
    expect(pending.pushed).toBe(false);
    await expect(worktrees.get("run-pending")).resolves.toMatchObject({
      status: "active",
      applyRecord: { decision: "keep_pending" }
    });
    // File still only in worktree.
    await expect(readFile(join(repository, "later.ts"), "utf8")).rejects.toThrow();
    expect(await readFile(join(prepared.workspacePath, "later.ts"), "utf8")).toContain("later");

    // Can still apply later.
    const applied = await worktrees.applyToMain("run-pending", {
      commitMessage: "稍后接受：later.ts"
    });
    expect(applied.status).toBe("applied");
    expect(applied.canCompleteDevRun).toBe(true);
  }, 30_000);

  it("discard removes worktree but keeps history markers and never touches main content", async () => {
    const prepared = await worktrees.prepare("run-discard", repository);
    await writeFile(join(prepared.workspacePath, "gone.ts"), "export const gone = 1;\n", "utf8");
    const headBefore = (await runtime.run(["rev-parse", "HEAD"], repository)).stdout.trim();

    await worktrees.discard("run-discard");
    await expect(worktrees.get("run-discard")).resolves.toMatchObject({ status: "discarded" });
    const headAfter = (await runtime.run(["rev-parse", "HEAD"], repository)).stdout.trim();
    expect(headAfter).toBe(headBefore);
    await expect(readFile(join(repository, "gone.ts"), "utf8")).rejects.toThrow();
    expect(canCompleteDevRunAfterWorktree({
      session: { status: "discarded" },
      hasChangedFiles: true
    })).toBe(false);
  });

  it("rejects concurrent apply while another apply is in flight (double-click safety)", async () => {
    let signalMergeEntered!: () => void;
    const mergeEntered = new Promise<void>((resolve) => {
      signalMergeEntered = resolve;
    });
    let releaseMerge!: () => void;
    const mergeBlocked = new Promise<void>((resolve) => {
      releaseMerge = resolve;
    });
    const slowRuntime = {
      async run(args: string[], cwd: string) {
        if (args.includes("merge") && args.includes("--no-ff")) {
          signalMergeEntered();
          await mergeBlocked;
        }
        return runtime.run(args, cwd);
      }
    };
    const slowWorktrees = await GitWorktreeService.open(join(root, "race-worktrees.json"), slowRuntime);
    await slowWorktrees.prepare("run-race2", repository);
    const session = await slowWorktrees.get("run-race2");
    await writeFile(join(session.workspacePath, "race2.ts"), "export const race2 = 1;\n", "utf8");

    const first = slowWorktrees.applyToMain("run-race2", { commitMessage: "并发应用测试" });
    await mergeEntered;
    await expect(slowWorktrees.applyToMain("run-race2")).rejects.toThrow(/正在应用/);
    releaseMerge();
    const result = await first;
    expect(result.status).toBe("applied");
    expect(result.pushed).toBe(false);
  }, 30_000);
});
