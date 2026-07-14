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
import { RunService } from "../runs/runService.js";
import { TodoService } from "../todos/todoService.js";
import { CodexCliService, NodeCodexCliRuntime, type CodexCliProcess, type CodexCliRuntime, type CodexCommandResult } from "./codexCliService.js";
import type { CodexWorktreeDependency } from "./codexArtifactIndex.js";

class MemoryCredentialVault implements CredentialVault {
  async read(): Promise<string | undefined> { return undefined; }
  async write(): Promise<void> {}
  async remove(): Promise<void> {}
}

class FakeCodexProcess extends EventEmitter implements CodexCliProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
  pid: number | undefined = 4200;
  signalCode: NodeJS.Signals | null = null;
}

/** Minimal worktree DI stubs so typecheck matches CodexWorktreeDependency (get + captureDiff for indexing). */
function stubWorktrees(overrides: Record<string, unknown> = {}): CodexWorktreeDependency {
  return {
    isGitWorkspace: vi.fn().mockResolvedValue(true),
    prepare: vi.fn(),
    discard: vi.fn().mockResolvedValue({ status: "discarded" }),
    get: vi.fn().mockRejectedValue(new Error("no worktree")),
    captureDiff: vi.fn().mockResolvedValue({ changedFiles: [], diff: "" }),
    runApprovedChecks: vi.fn().mockResolvedValue([]),
    ...overrides
  } as CodexWorktreeDependency;
}

class FakeCodexRuntime implements CodexCliRuntime {
  probes = new Map<string, CodexCommandResult>();
  probeFailure?: Error;
  terminateFailure?: Error;
  invocations: Array<{ args: string[]; cwd: string }> = [];
  readonly children: FakeCodexProcess[] = [];
  readonly terminated: FakeCodexProcess[] = [];

  async run(args: string[]): Promise<CodexCommandResult> {
    if (this.probeFailure) throw this.probeFailure;
    return this.probes.get(args.join(" ")) ?? { exitCode: 0, stdout: "ok", stderr: "" };
  }

  spawn(args: string[], cwd: string): CodexCliProcess {
    this.invocations.push({ args, cwd });
    const child = new FakeCodexProcess();
    this.children.push(child);
    return child;
  }

  async terminate(child: CodexCliProcess): Promise<void> {
    if (this.terminateFailure) throw this.terminateFailure;
    this.terminated.push(child as FakeCodexProcess);
    child.kill("SIGTERM");
  }
}

describe("Codex CLI Harness contract", () => {
  let root: string;
  let workspace: string;
  let projects: ProjectService;
  let todos: TodoService;
  let runs: RunService;
  let roles: RoleService;
  let codex: CodexCliService;
  let runtime: FakeCodexRuntime;
  let todoId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-codex-cli-"));
    workspace = join(root, "workspace");
    await mkdir(workspace);
    projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    const project = await projects.create({
      name: "Codex 项目",
      workspacePath: workspace,
      authorizationGrantId: (await projects.requestWorkspaceAuthorization(workspace)).id
    });
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({ title: "由 Codex 执行", projectId: project.id })).id;
    runs = await RunService.open(join(root, "runs.json"), todos);
    const connections = await ConnectionService.open(join(root, "connections.json"), new MemoryCredentialVault());
    roles = await RoleService.open(join(root, "roles.json"), connections);
    runtime = new FakeCodexRuntime();
    runtime.probes.set("--version", { exitCode: 0, stdout: "codex 0.1.0", stderr: "" });
    runtime.probes.set("login status", { exitCode: 0, stdout: "ChatGPT", stderr: "" });
    // Default stub: Git Project isolation path reuses the Project workspace path so harness tests stay focused.
    codex = new CodexCliService({
      projects,
      todos,
      runs,
      roles,
      runtime,
      worktrees: stubWorktrees({
        prepare: vi.fn().mockImplementation(async (runId: string, mainWorkspacePath: string) => ({
          runId,
          mainWorkspacePath,
          repositoryPath: mainWorkspacePath,
          worktreePath: mainWorkspacePath,
          workspacePath: mainWorkspacePath,
          projectRelativePath: "",
          baselineCommit: "baseline",
          status: "active" as const,
          created: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          verificationResults: []
        }))
      })
    });
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

  async function approvedRun() {
    const run = await runs.create(todoId, "实现一个可验证的本地改动。");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准 Codex 执行。" });
    return run;
  }

  async function startApprovedWriteSession(runId: string, roleId: string) {
    const awaitingApproval = await codex.start(runId, { roleId });
    expect(awaitingApproval).toMatchObject({
      status: "paused",
      execution: {
        status: "failed",
        retryable: true,
        pendingApproval: { kind: "delete_file", status: "awaiting_confirmation" }
      }
    });
    expect(runtime.children).toHaveLength(0);

    await runs.decideExecutionApproval(runId, {
      decision: "approved",
      summary: "确认本次受限 Codex Project 写入会话。"
    });
    return codex.start(runId);
  }

  it("detects installation and login state without exposing credentials", async () => {
    await expect(codex.status()).resolves.toMatchObject({ installed: true, authenticated: true, version: "codex 0.1.0" });

    runtime.probes.set("login status", { exitCode: 1, stdout: "", stderr: "not logged in" });
    await expect(codex.status()).resolves.toMatchObject({
      installed: true,
      authenticated: false,
      reason: expect.stringContaining("登录")
    });
  });

  it("turns a failed local probe into actionable unavailable state instead of leaking its process error", async () => {
    runtime.probeFailure = new Error("C:\\Users\\me\\secret-token");

    await expect(codex.status()).resolves.toEqual({
      installed: false,
      authenticated: false,
      reason: expect.stringContaining("无法检测")
    });
  });

  it("requires a confirmed write-session approval before running an approved Codex Role in the Project working directory", async () => {
    const run = await approvedRun();
    const role = await codexRole();

    const started = await startApprovedWriteSession(run.id, role.id);
    const child = runtime.children[0]!;
    expect(started).toMatchObject({ status: "running", execution: { selectedAgent: { roleId: role.id, harness: "codex-cli" } } });
    expect(runtime.invocations[0]).toMatchObject({
      cwd: workspace,
      args: expect.arrayContaining([
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "--skip-git-repo-check",
        "--cd",
        workspace,
        "sandbox_workspace_write.network_access=false",
        "sandbox_workspace_write.exclude_slash_tmp=true",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "sandbox_workspace_write.writable_roots=[]"
      ])
    });

    child.stderr.write("checking tests\n");
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message"}}\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    child.emit("close", 0, null);
    await codex.waitForCompletion(run.id);

    expect(await runs.get(run.id)).toMatchObject({ status: "awaiting_review", execution: { status: "succeeded" } });
    const logText = (await runs.get(run.id)).logs.map((entry) => entry.message).join("\n");
    expect(logText).toContain("Codex CLI stderr: checking tests");
    expect(logText).toContain("Codex CLI stdout:");
    // Terminal outcome is also emitted as a unified Runtime event (Task 35 production wire).
    expect(logText).toContain("runtime:complete");
    expect(codex.getRuntimeAdapter().harness).toBe("codex-cli");
  });

  it("runs a Git Project in its prepared isolated Worktree without changing the main workspace target", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    const isolatedWorkspace = join(root, "isolated-worktree");
    const isGitWorkspace = vi.fn().mockResolvedValue(true);
    const prepare = vi.fn().mockResolvedValue({
      runId: run.id,
      mainWorkspacePath: workspace,
      workspacePath: isolatedWorkspace,
      status: "active" as const,
      created: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      verificationResults: []
    });
    const discard = vi.fn().mockResolvedValue(undefined);
    codex = new CodexCliService({
      projects,
      todos,
      runs,
      roles,
      runtime,
      worktrees: stubWorktrees({ isGitWorkspace, prepare, discard })
    });

    await startApprovedWriteSession(run.id, role.id);

    expect(isGitWorkspace).toHaveBeenCalledTimes(2);
    expect(isGitWorkspace).toHaveBeenCalledWith(workspace);
    expect(prepare).toHaveBeenCalledWith(run.id, workspace);
    expect(runtime.invocations[0]).toMatchObject({ cwd: isolatedWorkspace, args: expect.arrayContaining(["--cd", isolatedWorkspace]) });
  });

  it("fail-closes when Worktree DI is missing so Codex never spawns against the main workspace", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    codex = new CodexCliService({ projects, todos, runs, roles, runtime });

    const paused = await codex.start(run.id, { roleId: role.id });

    expect(paused).toMatchObject({ status: "paused", execution: { status: "idle" } });
    expect(paused.timeline.map((event) => event.summary).join("\n")).toMatch(/隔离 Git Worktree|主工作区未被修改/);
    expect(runtime.children).toHaveLength(0);
  });

  it("pauses non-Git Projects instead of writing the main workspace when Worktree isolation is required", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    codex = new CodexCliService({
      projects,
      todos,
      runs,
      roles,
      runtime,
      worktrees: stubWorktrees({
        isGitWorkspace: vi.fn().mockResolvedValue(false),
        prepare: vi.fn(),
        discard: vi.fn()
      })
    });

    const paused = await codex.start(run.id, { roleId: role.id });

    expect(paused).toMatchObject({ status: "paused", execution: { status: "idle" } });
    expect(paused.timeline.map((event) => event.summary).join("\n")).toContain("Git Project");
    expect(runtime.children).toHaveLength(0);
  });

  it("does not spawn Codex when the Run stops while its isolated Worktree is being prepared", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    let releasePreparation: (() => void) | undefined;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let markPreparationStarted: (() => void) | undefined;
    const preparationStarted = new Promise<void>((resolve) => { markPreparationStarted = resolve; });
    const preparedSession = {
      runId: run.id,
      mainWorkspacePath: workspace,
      repositoryPath: workspace,
      worktreePath: join(root, "worktree-root"),
      workspacePath: join(root, "worktree-root"),
      projectRelativePath: "",
      baselineCommit: "abc123",
      status: "active" as const,
      created: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      verificationResults: []
    };
    const discard = vi.fn().mockResolvedValue({ ...preparedSession, status: "discarded" as const });
    codex = new CodexCliService({
      projects,
      todos,
      runs,
      roles,
      runtime,
      worktrees: stubWorktrees({
        isGitWorkspace: vi.fn().mockResolvedValue(true),
        prepare: vi.fn().mockImplementation(async () => { markPreparationStarted?.(); await preparation; return preparedSession; }),
        discard
      })
    });

    await codex.start(run.id, { roleId: role.id });
    await runs.decideExecutionApproval(run.id, { decision: "approved", summary: "确认受限写入会话。" });
    const launching = codex.start(run.id);
    await preparationStarted;
    await runs.stop(run.id, "用户在 Worktree 创建期间停止 Run");
    releasePreparation?.();

    await expect(launching).resolves.toMatchObject({ status: "cancelled" });
    expect(runtime.children).toHaveLength(0);
    expect(discard).toHaveBeenCalledWith(run.id);
  });

  it("does not discard an existing undiscarded Worktree when stop lands on a reused prepare", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    let releasePreparation: (() => void) | undefined;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let markPreparationStarted: (() => void) | undefined;
    const preparationStarted = new Promise<void>((resolve) => { markPreparationStarted = resolve; });
    const existingSession = {
      runId: run.id,
      mainWorkspacePath: workspace,
      repositoryPath: workspace,
      worktreePath: join(root, "existing-worktree"),
      workspacePath: join(root, "existing-worktree"),
      projectRelativePath: "",
      baselineCommit: "abc123",
      status: "active" as const,
      created: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      verificationResults: []
    };
    const discard = vi.fn();
    codex = new CodexCliService({
      projects,
      todos,
      runs,
      roles,
      runtime,
      worktrees: stubWorktrees({
        isGitWorkspace: vi.fn().mockResolvedValue(true),
        prepare: vi.fn().mockImplementation(async () => { markPreparationStarted?.(); await preparation; return existingSession; }),
        discard
      })
    });

    await codex.start(run.id, { roleId: role.id });
    await runs.decideExecutionApproval(run.id, { decision: "approved", summary: "确认受限写入会话。" });
    const launching = codex.start(run.id);
    await preparationStarted;
    await runs.stop(run.id, "用户在复用 Worktree 等待期间停止 Run");
    releasePreparation?.();

    await expect(launching).resolves.toMatchObject({ status: "cancelled" });
    expect(runtime.children).toHaveLength(0);
    expect(discard).not.toHaveBeenCalled();
  });

  it("does not spawn an orphaned Codex process when the Run is stopped while startup is awaiting its state transition", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    const begin = runs.beginProfessionalExecution.bind(runs);
    vi.spyOn(runs, "beginProfessionalExecution").mockImplementation(async (runId, selection) => {
      const started = await begin(runId, selection);
      await runs.stop(runId, "用户在 Codex 启动期间停止 Run");
      return started;
    });

    const result = await codex.start(run.id, { roleId: role.id });

    expect(result.status).toBe("cancelled");
    expect(runtime.children).toHaveLength(0);
  });

  it("rejects a Codex coding Role that has not authorized the implement Skill", async () => {
    const run = await approvedRun();
    const role = await roles.create({
      name: "只研究的 Codex Role",
      responsibility: "仅研究",
      systemInstruction: "不要写文件。",
      harness: "codex-cli",
      reasoningEffort: "medium",
      skills: ["research"],
      tools: ["codex-cli", "filesystem", "shell"],
      permissions: { workspace: "project_only", network: false, shell: true, externalSend: false },
      allowFirstmateAutoInvoke: true
    });

    await expect(codex.start(run.id, { roleId: role.id })).rejects.toThrow("implement");
    expect(runtime.children).toHaveLength(0);
  });

  it("fails closed for Codex Roles that request network or external-send capability without an interactive approval bridge", async () => {
    const run = await approvedRun();
    const role = await roles.create({
      name: "联网 Codex Role",
      responsibility: "联网实现",
      systemInstruction: "实现任务。",
      harness: "codex-cli",
      reasoningEffort: "medium",
      skills: ["implement"],
      tools: ["codex-cli", "filesystem", "shell", "web"],
      permissions: { workspace: "project_only", network: true, shell: true, externalSend: false },
      allowFirstmateAutoInvoke: true
    });

    await expect(codex.start(run.id, { roleId: role.id })).rejects.toThrow("network");
    expect(runtime.children).toHaveLength(0);
  });

  it("redacts common credentials and PEM material before Codex output is persisted to the Run", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    await startApprovedWriteSession(run.id, role.id);
    const child = runtime.children[0]!;

    child.stderr.write("DATABASE_URL=postgres://alice:very-secret@db.example/test\n");
    child.stdout.write("GITHUB_TOKEN=ghp_verySecretTokenValue1234567890\n");
    child.stdout.write("Authorization: Basic YWxpY2U6dmVyeS1zZWNyZXQ=\n");
    child.stdout.write("AWS_SECRET_ACCESS_KEY=aws-very-secret-value\n");
    child.stdout.write("Cookie: session=very-secret-cookie\n");
    child.stderr.write("-----BEGIN PRIVATE KEY-----\n");
    child.stderr.write("very-private-pem-body\n");
    child.stderr.write("-----END PRIVATE KEY-----\n");
    child.emit("close", 0, null);
    await codex.waitForCompletion(run.id);

    const output = (await runs.get(run.id)).logs.map((entry) => entry.message).join("\n");
    expect(output).not.toContain("very-secret");
    expect(output).not.toContain("ghp_verySecretTokenValue1234567890");
    expect(output).not.toContain("YWxpY2U6dmVyeS1zZWNyZXQ=");
    expect(output).not.toContain("aws-very-secret-value");
    expect(output).not.toContain("very-secret-cookie");
    expect(output).not.toContain("very-private-pem-body");
    expect(output).toContain("[REDACTED]");
  });

  it("terminates the corresponding Codex process when a user stops its Run", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    await startApprovedWriteSession(run.id, role.id);
    const child = runtime.children[0]!;

    await runs.stop(run.id, "用户停止 Codex Run");
    expect(runtime.terminated).toEqual([child]);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await codex.waitForCompletion(run.id);
    expect(await runs.get(run.id)).toMatchObject({ status: "cancelled", execution: { retryable: false } });
  });

  it("does not mark a Run cancelled when Codex process termination cannot be confirmed", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    await startApprovedWriteSession(run.id, role.id);
    runtime.terminateFailure = new Error("taskkill failed");

    await expect(runs.stop(run.id, "用户停止 Codex Run")).rejects.toThrow("终止");
    expect(await runs.get(run.id)).toMatchObject({ status: "paused", execution: { retryable: false } });
    await expect(runs.stop(run.id, "再次停止 Codex Run")).rejects.toThrow("未确认");
    expect((await runs.get(run.id)).status).toBe("paused");
  });

  it("requires a fresh write-session confirmation after a material correction produces a new approved plan", async () => {
    const run = await approvedRun();
    const role = await codexRole();

    await codex.start(run.id, { roleId: role.id });
    await runs.decideExecutionApproval(run.id, {
      decision: "approved",
      summary: "确认原计划的 Codex 写入会话。"
    });
    await runs.submitCorrection(run.id, { instruction: "将实现范围扩大到新的模块。", changeKind: "scope" });
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准纠偏后的新计划。" });

    const awaitingFreshApproval = await codex.start(run.id);

    expect(awaitingFreshApproval).toMatchObject({
      status: "paused",
      execution: { pendingApproval: { kind: "delete_file", status: "awaiting_confirmation" } }
    });
    expect(runtime.children).toHaveLength(0);
  });

  it("requires a fresh write-session confirmation when the selected Codex Role changes before spawn", async () => {
    const run = await approvedRun();
    const originalRole = await codexRole();
    const replacementRole = await roles.create({
      name: "替换的 Codex 实现者",
      responsibility: "在批准 Project 工作目录中实现并验证另一种方案",
      systemInstruction: "只在当前 Project 工作目录中执行新的受限方案。",
      harness: "codex-cli",
      reasoningEffort: "medium",
      skills: ["implement", "tdd"],
      tools: ["codex-cli", "filesystem", "shell"],
      permissions: { workspace: "project_only", network: false, shell: true, externalSend: false },
      allowFirstmateAutoInvoke: true
    });

    await codex.start(run.id, { roleId: originalRole.id });
    await runs.decideExecutionApproval(run.id, {
      decision: "approved",
      summary: "确认原 Role 的 Codex 写入会话。"
    });

    const awaitingFreshApproval = await codex.start(run.id, { roleId: replacementRole.id });

    expect(awaitingFreshApproval).toMatchObject({
      status: "paused",
      execution: {
        selectedAgent: { roleId: replacementRole.id },
        pendingApproval: { kind: "delete_file", status: "awaiting_confirmation" }
      }
    });
    expect(runtime.children).toHaveLength(0);
  });

  it("pauses an approved Run with actionable guidance when Codex is unavailable or logged out", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    runtime.probes.set("--version", { exitCode: null, stdout: "", stderr: "", errorCode: "ENOENT" });

    const paused = await codex.start(run.id, { roleId: role.id });

    expect(paused).toMatchObject({ status: "paused", execution: { status: "idle" } });
    expect(paused.timeline.map((event) => event.summary).join("\n")).toContain("未安装");
  });

  it("pauses an approved Run with login guidance when the local Codex session has expired", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    runtime.probes.set("login status", { exitCode: 1, stdout: "", stderr: "logged out" });

    const paused = await codex.start(run.id, { roleId: role.id });

    expect(paused).toMatchObject({ status: "paused", execution: { status: "idle" } });
    expect(paused.timeline.map((event) => event.summary).join("\n")).toContain("codex login");
  });

  it("reports actionable login guidance when authentication expires after the preflight check", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    await startApprovedWriteSession(run.id, role.id);
    const child = runtime.children[0]!;
    child.stderr.write("authentication failed: please log in\n");
    child.emit("close", 1, null);
    await codex.waitForCompletion(run.id);

    const paused = await runs.get(run.id);
    expect(paused.status).toBe("paused");
    expect(paused.timeline.map((event) => event.summary).join("\n")).toContain("codex login");
    // Fail is also emitted as a unified Runtime event with normalized taxonomy.
    expect(paused.logs.map((entry) => entry.message).join("\n")).toMatch(/runtime:fail \[not_logged_in\]/);
  });

  it("rechecks local login status after an otherwise opaque non-zero Codex exit", async () => {
    const run = await approvedRun();
    const role = await codexRole();
    await startApprovedWriteSession(run.id, role.id);
    runtime.probes.set("login status", { exitCode: 1, stdout: "", stderr: "expired" });
    runtime.children[0]!.emit("close", 1, null);
    await codex.waitForCompletion(run.id);

    const paused = await runs.get(run.id);
    expect(paused.timeline.map((event) => event.summary).join("\n")).toContain("codex login");
  });

  it("treats a process with a signal close code as already terminated", async () => {
    const runtime = new NodeCodexCliRuntime();
    const exited = new FakeCodexProcess();
    exited.pid = undefined;
    exited.signalCode = "SIGTERM";

    await expect(runtime.terminate(exited)).resolves.toBeUndefined();
  });
});
