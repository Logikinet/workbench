import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { RoleService } from "../roles/roleService.js";
import {
  CODEX_WORKTREE_EVIDENCE_KIND,
  CODEX_WORKTREE_FILE_KIND,
  RunService
} from "../runs/runService.js";
import { TodoService } from "../todos/todoService.js";
import { assembleReviewContext, evaluateReview } from "../review/reviewService.js";
import { CodexCliService, type CodexCliProcess, type CodexCliRuntime, type CodexCommandResult } from "./codexCliService.js";
import { findCodexWorktreeEvidence } from "./codexArtifactIndex.js";

class MemoryCredentialVault implements CredentialVault {
  async read(): Promise<string | undefined> { return undefined; }
  async write(): Promise<void> {}
  async remove(): Promise<void> {}
}

class FakeCodexProcess extends EventEmitter implements CodexCliProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
  pid: number | undefined = 4201;
  signalCode: NodeJS.Signals | null = null;
}

class FakeCodexRuntime implements CodexCliRuntime {
  probes = new Map<string, CodexCommandResult>();
  invocations: Array<{ args: string[]; cwd: string }> = [];
  readonly children: FakeCodexProcess[] = [];

  async run(args: string[]): Promise<CodexCommandResult> {
    return this.probes.get(args.join(" ")) ?? { exitCode: 0, stdout: "ok", stderr: "" };
  }

  spawn(args: string[], cwd: string): CodexCliProcess {
    this.invocations.push({ args, cwd });
    const child = new FakeCodexProcess();
    this.children.push(child);
    return child;
  }

  async terminate(child: CodexCliProcess): Promise<void> {
    child.kill("SIGTERM");
  }
}

describe("Codex → Diff → Artifact integration", () => {
  let root: string;
  let workspace: string;
  let projects: ProjectService;
  let todos: TodoService;
  let runs: RunService;
  let roles: RoleService;
  let runtime: FakeCodexRuntime;
  let todoId: string;
  let isolatedWorkspace: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-codex-artifact-"));
    workspace = join(root, "workspace");
    isolatedWorkspace = join(root, "isolated-worktree");
    await mkdir(workspace);
    await mkdir(isolatedWorkspace);
    projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    const project = await projects.create({
      name: "Codex Artifact 项目",
      workspacePath: workspace,
      authorizationGrantId: (await projects.requestWorkspaceAuthorization(workspace)).id
    });
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({ title: "实现并登记 Artifact", projectId: project.id })).id;
    runs = await RunService.open(join(root, "runs.json"), todos);
    const connections = await ConnectionService.open(join(root, "connections.json"), new MemoryCredentialVault());
    roles = await RoleService.open(join(root, "roles.json"), connections);
    runtime = new FakeCodexRuntime();
    runtime.probes.set("--version", { exitCode: 0, stdout: "codex 0.1.0", stderr: "" });
    runtime.probes.set("login status", { exitCode: 0, stdout: "ChatGPT", stderr: "" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function codexRole() {
    return roles.create({
      name: "Codex 实现者",
      responsibility: "在批准 Project 工作目录中实现并验证代码",
      systemInstruction: "遵守已批准计划，只在项目工作区内工作。",
      harness: "codex-cli",
      reasoningEffort: "medium",
      skills: ["implement", "tdd"],
      tools: ["codex-cli", "filesystem", "shell"],
      permissions: { workspace: "project_only", network: false, shell: true, externalSend: false },
      allowFirstmateAutoInvoke: true
    });
  }

  async function approvedRun(verificationCommands: string[][] = [["npm", "test"]]) {
    const run = await runs.create(todoId, "实现一个可验证的本地改动。");
    await runs.updatePlanning(run.id, { verificationCommands });
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准 Codex 执行。" });
    return runs.get(run.id);
  }

  function worktreeHarness(options: {
    changedFiles?: string[];
    diff?: string;
    verification?: Array<{ command: string[]; exitCode: number | null; stdout: string; stderr: string }>;
    status?: "active" | "discarded";
  } = {}) {
    const session = {
      runId: "",
      mainWorkspacePath: workspace,
      repositoryPath: workspace,
      worktreePath: isolatedWorkspace,
      workspacePath: isolatedWorkspace,
      projectRelativePath: "",
      baselineCommit: "baseline123",
      status: options.status ?? ("active" as const),
      created: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      verificationResults: options.verification ?? []
    };
    return {
      isGitWorkspace: vi.fn().mockResolvedValue(true),
      prepare: vi.fn().mockImplementation(async (runId: string) => ({ ...session, runId })),
      discard: vi.fn().mockImplementation(async (runId: string) => {
        session.status = "discarded";
        return { ...session, runId, status: "discarded" as const };
      }),
      get: vi.fn().mockImplementation(async (runId: string) => ({ ...session, runId, status: session.status })),
      captureDiff: vi.fn().mockResolvedValue({
        changedFiles: options.changedFiles ?? ["src/feature.ts"],
        diff: options.diff ?? "diff --git a/src/feature.ts b/src/feature.ts\n+export const ok = true;\n"
      }),
      runApprovedChecks: vi.fn().mockImplementation(async (_runId: string, commands: string[][]) => {
        const results = commands.map((command) => ({
          command,
          exitCode: 0,
          stdout: "ok",
          stderr: ""
        }));
        session.verificationResults = results;
        return results;
      })
    };
  }

  async function startAndComplete(codex: CodexCliService, runId: string, roleId: string, exitCode = 0) {
    const awaiting = await codex.start(runId, { roleId });
    expect(awaiting.execution.pendingApproval?.status).toBe("awaiting_confirmation");
    await runs.decideExecutionApproval(runId, { decision: "approved", summary: "确认写入会话。" });
    await codex.start(runId);
    const child = runtime.children.at(-1)!;
    child.stdout.write('{"type":"item.completed"}\n');
    child.emit("close", exitCode, null);
    await codex.waitForCompletion(runId);
    return runs.get(runId);
  }

  it("indexes changed files, full Diff, verification, and worktree id after Codex success", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    const worktrees = worktreeHarness({
      changedFiles: ["src/feature.ts", "src/feature.test.ts"],
      diff: "diff --git a/src/feature.ts b/src/feature.ts\n+export const ok = true;\n"
    });
    const codex = new CodexCliService({ projects, todos, runs, roles, runtime, worktrees });

    const finished = await startAndComplete(codex, run.id, role.id, 0);
    expect(finished).toMatchObject({ status: "awaiting_review", execution: { status: "succeeded" } });

    const evidence = findCodexWorktreeEvidence(finished);
    expect(evidence).toMatchObject({
      source: "codex-worktree",
      worktreeRunId: run.id,
      worktreePath: isolatedWorkspace,
      baselineCommit: "baseline123",
      changeStatus: "modified",
      discarded: false,
      sessionStatus: "active",
      changedFiles: ["src/feature.ts", "src/feature.test.ts"]
    });
    expect(evidence?.diff).toContain("src/feature.ts");
    expect(evidence?.verificationResults).toEqual([
      expect.objectContaining({ command: ["npm", "test"], exitCode: 0, passed: true })
    ]);
    expect(worktrees.captureDiff).toHaveBeenCalledWith(run.id);
    expect(worktrees.runApprovedChecks).toHaveBeenCalledWith(run.id, [["npm", "test"]]);

    expect(finished.artifacts.some((a) => a.kind === CODEX_WORKTREE_EVIDENCE_KIND)).toBe(true);
    expect(finished.artifacts.filter((a) => a.kind === CODEX_WORKTREE_FILE_KIND).map((a) => a.path).sort()).toEqual([
      "src/feature.test.ts",
      "src/feature.ts"
    ]);

    // Reviewer uses the same normalized structured result (passed flag), not log "passed".
    const context = assembleReviewContext(finished, await todos.get(todoId));
    expect(context.evidence.some((line) => line.includes("worktree-evidence-json:"))).toBe(true);
    expect(context.evidence.some((line) => line.includes("passed=true"))).toBe(true);
    expect(context.outcomes.artifacts.some((a) => a.path === "src/feature.ts")).toBe(true);
    const review = evaluateReview(context);
    expect(review.findings.some((f) => /验证|verify|test/i.test(f.criterion) ? f.met : true)).toBe(true);
  });

  it("marks no-modification without fake file artifacts", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    const worktrees = worktreeHarness({ changedFiles: [], diff: "" });
    const codex = new CodexCliService({ projects, todos, runs, roles, runtime, worktrees });

    const finished = await startAndComplete(codex, run.id, role.id, 0);
    const evidence = findCodexWorktreeEvidence(finished);
    expect(evidence?.changeStatus).toBe("no_modification");
    expect(finished.artifacts.filter((a) => a.kind === CODEX_WORKTREE_FILE_KIND)).toHaveLength(0);
    expect(finished.artifacts.some((a) => a.kind === CODEX_WORKTREE_EVIDENCE_KIND)).toBe(true);
    expect(finished.timeline.map((e) => e.summary).join("\n")).toMatch(/无实际修改|虚假/);
  });

  it("indexes after failure/pause and marks discarded history without deleting evidence", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    const worktrees = worktreeHarness({
      changedFiles: ["broken.ts"],
      diff: "diff --git a/broken.ts b/broken.ts\n"
    });
    const codex = new CodexCliService({ projects, todos, runs, roles, runtime, worktrees });

    const paused = await startAndComplete(codex, run.id, role.id, 2);
    expect(paused.status).toBe("paused");
    const evidence = findCodexWorktreeEvidence(paused);
    expect(evidence).toMatchObject({
      changeStatus: "modified",
      changedFiles: ["broken.ts"],
      sessionStatus: "active",
      discarded: false
    });

    await worktrees.discard(run.id);
    const marked = await runs.markWorktreeArtifactsDiscarded(run.id);
    const discardedEvidence = findCodexWorktreeEvidence(marked);
    expect(discardedEvidence).toMatchObject({
      discarded: true,
      sessionStatus: "discarded",
      changedFiles: ["broken.ts"]
    });
    expect(discardedEvidence?.diff).toContain("broken.ts");
    expect(marked.artifacts.length).toBeGreaterThan(0);
  });

  it("flags missing worktree after restart while keeping historical Diff on artifacts", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    const worktrees = worktreeHarness({
      changedFiles: ["keep.ts"],
      diff: "diff --git a/keep.ts b/keep.ts\n+keep\n"
    });
    const codex = new CodexCliService({ projects, todos, runs, roles, runtime, worktrees });
    const finished = await startAndComplete(codex, run.id, role.id, 0);
    expect(findCodexWorktreeEvidence(finished)?.diff).toContain("keep.ts");

    // Simulate restart: open RunService again; worktree session gone.
    const reopened = await RunService.open(join(root, "runs.json"), todos);
    const reloaded = await reopened.get(run.id);
    expect(findCodexWorktreeEvidence(reloaded)?.changedFiles).toEqual(["keep.ts"]);

    const reconciled = await reopened.reconcileWorktreeArtifactConsistency(run.id, {
      sessionStatus: "missing",
      consistency: "missing_worktree",
      consistencyNote: "隔离 Worktree 已缺失；Artifact 索引仍保留历史 Diff，请恢复 Worktree 或重新执行 Codex。"
    });
    const evidence = findCodexWorktreeEvidence(reconciled);
    expect(evidence).toMatchObject({
      sessionStatus: "missing",
      consistency: "missing_worktree",
      changedFiles: ["keep.ts"]
    });
    expect(evidence?.diff).toContain("keep.ts");
    expect(reconciled.timeline.map((e) => e.summary).join("\n")).toMatch(/缺失|恢复/);
  });
});
