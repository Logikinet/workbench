import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { createApp } from "../http/app.js";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { RoleService } from "../roles/roleService.js";
import { captureWorkspaceFingerprint, RunService } from "../runs/runService.js";
import { TodoService } from "../todos/todoService.js";
import { ProfessionalAgentService } from "./professionalAgentService.js";

class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();
  async read(reference: string): Promise<string | undefined> { return this.values.get(reference); }
  async write(reference: string, secret: string): Promise<void> { this.values.set(reference, secret); }
  async remove(reference: string): Promise<void> { this.values.delete(reference); }
}

describe("API Professional Agent execution contract", () => {
  let root: string;
  let workspace: string;
  let projects: ProjectService;
  let todos: TodoService;
  let runs: RunService;
  let connections: ConnectionService;
  let roles: RoleService;
  let professionalAgents: ProfessionalAgentService;
  let todoId: string;
  let modelReplies: string[];
  let modelCallCount: number;
  let holdModelRequest: boolean;
  let modelRequestStarted: Promise<void>;
  let resolveModelRequestStarted: () => void;

  const resetModelRequestSignal = () => {
    modelRequestStarted = new Promise((resolve) => { resolveModelRequestStarted = resolve; });
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-professional-agent-"));
    workspace = join(root, "workspace");
    await mkdir(workspace);
    projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    const project = await projects.create({
      name: "执行项目",
      workspacePath: workspace,
      authorizationGrantId: (await projects.requestWorkspaceAuthorization(workspace)).id
    });
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({ title: "生成验证文件", projectId: project.id })).id;
    runs = await RunService.open(join(root, "runs.json"), todos);
    modelReplies = [];
    modelCallCount = 0;
    holdModelRequest = false;
    resetModelRequestSignal();
    connections = await ConnectionService.open(
      join(root, "connections.json"),
      new MemoryCredentialVault(),
      async (_input, init) => {
        modelCallCount += 1;
        if (holdModelRequest) {
          resolveModelRequestStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: modelReplies.shift() ?? "" } }] }), { status: 200 });
      }
    );
    roles = await RoleService.open(join(root, "roles.json"), connections);
    professionalAgents = new ProfessionalAgentService({ projects, todos, runs, roles, connections });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function approvedRun() {
    const run = await runs.create(todoId, "在项目工作区生成一个可验证的结果文件。");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准受限文件任务。" });
    return run;
  }

  async function apiRole() {
    const connection = await connections.create({ baseUrl: "https://api.example.test/v1", apiKey: "local-key", modelId: "gpt-5" });
    return roles.create({
      name: "文件执行专家",
      responsibility: "在批准的工作区内生成文件",
      systemInstruction: "仅返回受限的文件动作 JSON。",
      connectionId: connection.id,
      harness: "api",
      reasoningEffort: "medium",
      skills: ["implement"],
      tools: ["filesystem"],
      permissions: { workspace: "project_only", network: false, shell: false, externalSend: false },
      allowFirstmateAutoInvoke: true
    });
  }

  it("lets Firstmate select an existing API Role and produces a real Artifact with status, model summary and tool activity", async () => {
    const run = await approvedRun();
    const role = await apiRole();
    modelReplies.push(JSON.stringify({
      summary: "已生成验证结果文件。",
      actions: [{ type: "write_file", path: "result.md", content: "# 验证通过\n" }]
    }));
    const app = createApp({ version: "0.1.0", projects, todos, runs, connections, roles, professionalAgents });

    const started = await request(app)
      .post(`/api/runs/${run.id}/professional-agent/execute`)
      .send({ roleId: role.id })
      .expect(202);
    expect(started.body).toMatchObject({ status: "running", execution: { selectedAgent: { source: "role", roleId: role.id } } });

    await professionalAgents.waitForCompletion(run.id);
    const finished = await runs.get(run.id);
    expect(await readFile(join(workspace, "result.md"), "utf8")).toBe("# 验证通过\n");
    expect(finished).toMatchObject({ status: "awaiting_review", execution: { status: "succeeded", retryable: false } });
    expect(finished.artifacts).toEqual([expect.objectContaining({ path: "result.md", kind: "file" })]);
    expect(finished.timeline.map((event) => event.summary).join("\n")).toContain("模型输出摘要");
    expect(finished.timeline.map((event) => event.summary).join("\n")).toContain("工具活动：write_file result.md");
  });

  it("keeps completed steps and a retryable error state when a model action fails after partial progress", async () => {
    const run = await approvedRun();
    const role = await apiRole();
    modelReplies.push(JSON.stringify({
      summary: "先写入一个文件，再尝试越界。",
      actions: [
        { type: "write_file", path: "completed.md", content: "已完成第一步" },
        { type: "write_file", path: "../outside.md", content: "不应写入" }
      ]
    }));

    await professionalAgents.start(run.id, { roleId: role.id });
    await professionalAgents.waitForCompletion(run.id);

    expect(await readFile(join(workspace, "completed.md"), "utf8")).toBe("已完成第一步");
    expect(await runs.get(run.id)).toMatchObject({
      status: "paused",
      execution: {
        status: "failed",
        retryable: true,
        completedSteps: ["write_file:completed.md"],
        lastError: expect.stringContaining("Project 工作区外路径"),
        pendingApproval: { status: "awaiting_confirmation", kind: "outside_workspace" }
      }
    });

    await runs.decideExecutionApproval(run.id, { decision: "rejected", summary: "不得越出 Project 工作区。" });

    modelReplies.push(JSON.stringify({ summary: "重试完成。", actions: [{ type: "write_file", path: "retry.md", content: "重试成功" }] }));
    await professionalAgents.start(run.id, {});
    await professionalAgents.waitForCompletion(run.id);
    expect(await runs.get(run.id)).toMatchObject({
      status: "awaiting_review",
      execution: { status: "succeeded", completedSteps: ["write_file:completed.md", "write_file:retry.md"], retryable: false }
    });
  });

  it("gates failed-status retries through checkpoint fingerprint and dangerous re-approval", async () => {
    const run = await approvedRun();
    const role = await apiRole();
    modelReplies.push(JSON.stringify({
      summary: "一步成功后同批请求越界。",
      actions: [
        { type: "write_file", path: "guarded.md", content: "v1" },
        { type: "write_file", path: "../outside.md", content: "越界" }
      ]
    }));
    await professionalAgents.start(run.id, { roleId: role.id });
    await professionalAgents.waitForCompletion(run.id);
    await runs.decideExecutionApproval(run.id, { decision: "rejected", summary: "拒绝越界。" });

    const agent = (await runs.get(run.id)).execution.selectedAgent!;
    const fingerprint = await captureWorkspaceFingerprint(workspace, ["guarded.md"]);
    await runs.resumeFromCheckpoint(run.id, { currentFingerprint: fingerprint });
    await runs.beginProfessionalExecution(run.id, agent);
    await runs.beginExecutionStep(run.id, "write_file:next.md");
    await runs.failProfessionalExecution(run.id, "步骤失败可重试");
    expect(await runs.get(run.id)).toMatchObject({
      status: "failed",
      execution: { status: "failed", retryable: true, completedSteps: expect.arrayContaining(["write_file:guarded.md"]) }
    });

    await writeFile(join(workspace, "guarded.md"), "externally-changed", "utf8");
    const callsBefore = modelCallCount;
    modelReplies.push(JSON.stringify({ summary: "不应执行。", actions: [{ type: "write_file", path: "bad.md", content: "x" }] }));
    const blocked = await professionalAgents.start(run.id, {});
    expect(blocked).toMatchObject({
      status: "paused",
      checkpointRecovery: { status: "conflict" }
    });
    expect(modelCallCount).toBe(callsBefore);
  });

  it("aborts an in-flight model request when its Run is paused and allows the preserved Agent to retry", async () => {
    const run = await approvedRun();
    const role = await apiRole();
    holdModelRequest = true;

    await professionalAgents.start(run.id, { roleId: role.id });
    await modelRequestStarted;
    await runs.pauseForConnection((await roles.get(role.id)).connectionId!, "模型连接已暂停");
    await professionalAgents.waitForCompletion(run.id);
    expect(await runs.get(run.id)).toMatchObject({
      status: "paused",
      execution: { status: "failed", retryable: true, lastError: "模型连接已暂停" }
    });

    holdModelRequest = false;
    modelReplies.push(JSON.stringify({ summary: "恢复完成。", actions: [{ type: "write_file", path: "resumed.md", content: "恢复" }] }));
    await professionalAgents.start(run.id, {});
    await professionalAgents.waitForCompletion(run.id);
    expect(await readFile(join(workspace, "resumed.md"), "utf8")).toBe("恢复");
  });

  it("does not begin a model request when a pause lands between execution authorization and agent startup", async () => {
    const run = await approvedRun();
    const role = await apiRole();
    const originalBegin = runs.beginProfessionalExecution.bind(runs);
    vi.spyOn(runs, "beginProfessionalExecution").mockImplementation(async (runId, selection) => {
      const started = await originalBegin(runId, selection);
      await runs.pauseForConnection((await roles.get(role.id)).connectionId!, "用户在启动时暂停了 Run");
      return started;
    });

    await professionalAgents.start(run.id, { roleId: role.id });
    await professionalAgents.waitForCompletion(run.id);

    expect(modelCallCount).toBe(0);
    expect(await runs.get(run.id)).toMatchObject({
      status: "paused",
      execution: { status: "failed", retryable: true }
    });
  });

  it("keeps a temporary Professional Agent ephemeral unless the user explicitly confirms saving it", async () => {
    const connection = await connections.create({ baseUrl: "https://api.example.test/v1", apiKey: "local-key", modelId: "gpt-5" });
    const temporaryAgent = {
      name: "临时文档专家",
      responsibility: "创建验证文档",
      systemInstruction: "仅返回文件动作 JSON。",
      connectionId: connection.id,
      tools: ["filesystem"]
    };
    const app = createApp({ version: "0.1.0", projects, todos, runs, connections, roles, professionalAgents });

    const ephemeralRun = await approvedRun();
    modelReplies.push(JSON.stringify({ summary: "完成。", actions: [{ type: "write_file", path: "ephemeral.md", content: "临时" }] }));
    await request(app).post(`/api/runs/${ephemeralRun.id}/professional-agent/execute`).send({ temporaryAgent }).expect(202);
    await professionalAgents.waitForCompletion(ephemeralRun.id);
    expect(await roles.list()).toEqual([]);

    const unconfirmedRun = await approvedRun();
    await request(app)
      .post(`/api/runs/${unconfirmedRun.id}/professional-agent/execute`)
      .send({ temporaryAgent, saveTemporaryRole: true, confirmSaveTemporaryRole: false })
      .expect(400);
    expect(await roles.list()).toEqual([]);

    const unapprovedRun = await runs.create(todoId, "尚未批准的文件任务。");
    await request(app)
      .post(`/api/runs/${unapprovedRun.id}/professional-agent/execute`)
      .send({ temporaryAgent, saveTemporaryRole: true, confirmSaveTemporaryRole: true })
      .expect(400);
    expect(await roles.list()).toEqual([]);

    const savedRun = await approvedRun();
    modelReplies.push(JSON.stringify({ summary: "完成。", actions: [{ type: "write_file", path: "saved.md", content: "已保存" }] }));
    await request(app)
      .post(`/api/runs/${savedRun.id}/professional-agent/execute`)
      .send({ temporaryAgent, saveTemporaryRole: true, confirmSaveTemporaryRole: true })
      .expect(202);
    await professionalAgents.waitForCompletion(savedRun.id);
    expect((await roles.list()).map((role) => role.name)).toEqual(["临时文档专家"]);
  });

  it("does not persist a confirmed temporary Role when the Run is cancelled between authorization and startup", async () => {
    const run = await approvedRun();
    const connection = await connections.create({ baseUrl: "https://api.example.test/v1", apiKey: "local-key", modelId: "gpt-5" });
    const originalBegin = runs.beginProfessionalExecution.bind(runs);
    vi.spyOn(runs, "beginProfessionalExecution").mockImplementation(async (runId, selection) => {
      await runs.transition(runId, "cancelled", "用户在启动前取消了执行");
      return originalBegin(runId, selection);
    });

    await expect(professionalAgents.start(run.id, {
      temporaryAgent: {
        name: "不应残留的临时角色",
        responsibility: "执行受限文件任务",
        systemInstruction: "仅返回文件动作 JSON。",
        connectionId: connection.id,
        tools: ["filesystem"]
      },
      saveTemporaryRole: true,
      confirmSaveTemporaryRole: true
    })).rejects.toThrow("cancelled");

    expect(await roles.list()).toEqual([]);
  });

  it("does not orphan a running Run when execution startup reports an error after state was persisted", async () => {
    const run = await approvedRun();
    const role = await apiRole();
    const originalBegin = runs.beginProfessionalExecution.bind(runs);
    vi.spyOn(runs, "beginProfessionalExecution").mockImplementation(async (runId, selection) => {
      await originalBegin(runId, selection);
      throw new Error("Todo status persistence failed after startup.");
    });

    await expect(professionalAgents.start(run.id, { roleId: role.id })).rejects.toThrow("Todo status persistence failed");

    expect(await runs.get(run.id)).toMatchObject({
      status: "failed",
      execution: {
        status: "failed",
        retryable: true,
        lastError: "Todo status persistence failed after startup."
      }
    });
    expect(modelCallCount).toBe(0);
  });

  it("revalidates the current Role on retry instead of reusing permissions captured before revocation", async () => {
    const disabledRole = await apiRole();
    const disabledRun = await approvedRun();
    holdModelRequest = true;
    resetModelRequestSignal();
    await professionalAgents.start(disabledRun.id, { roleId: disabledRole.id });
    await modelRequestStarted;
    await runs.pauseForConnection((await roles.get(disabledRole.id)).connectionId!, "用户暂停后调整角色权限");
    await professionalAgents.waitForCompletion(disabledRun.id);
    await roles.update(disabledRole.id, { enabled: false });
    await expect(professionalAgents.start(disabledRun.id, {})).rejects.toThrow("disabled");
    holdModelRequest = false;

    const restrictedRole = await apiRole();
    const restrictedRun = await approvedRun();
    modelReplies.push("not valid JSON");
    await professionalAgents.start(restrictedRun.id, { roleId: restrictedRole.id });
    await professionalAgents.waitForCompletion(restrictedRun.id);
    await roles.update(restrictedRole.id, {
      permissions: { workspace: "read_only", network: false, shell: false, externalSend: false }
    });
    await expect(professionalAgents.start(restrictedRun.id, {})).rejects.toThrow("does not permit Project workspace writes");
  });

  it("programmatically pauses dangerous or unauthorized model actions for confirmation without touching files or external systems", async () => {
    const role = await apiRole();
    await writeFile(join(workspace, "legacy.md"), "必须保留");
    const cases: Array<{ action: Record<string, unknown>; expectedKind: string }> = [
      { action: { type: "write_file", path: "../outside.md", content: "不得越界" }, expectedKind: "outside_workspace" },
      { action: { type: "delete_file", path: "legacy.md" }, expectedKind: "delete_file" },
      { action: { type: "system_install", command: "npm install unsafe-package" }, expectedKind: "unapproved_tool" },
      { action: { type: "external_send", destination: "https://example.test", content: "不得外发" }, expectedKind: "unapproved_tool" },
      { action: { type: "write_file", path: "skill.md", content: "不得写入", skill: "research" }, expectedKind: "unapproved_skill" }
    ];
    let lastRunId = "";

    for (const testCase of cases) {
      const run = await approvedRun();
      lastRunId = run.id;
      modelReplies.push(JSON.stringify({ summary: "请求危险操作。", actions: [testCase.action] }));
      await professionalAgents.start(run.id, { roleId: role.id });
      await professionalAgents.waitForCompletion(run.id);
      expect(await runs.get(run.id)).toMatchObject({
        status: "paused",
        execution: {
          status: "failed",
          retryable: true,
          pendingApproval: { status: "awaiting_confirmation", kind: testCase.expectedKind }
        }
      });
      await expect(professionalAgents.start(run.id, {})).rejects.toThrow("approval awaiting confirmation");
    }

    const app = createApp({ version: "0.1.0", projects, todos, runs, connections, roles, professionalAgents });
    const decision = await request(app)
      .post(`/api/runs/${lastRunId}/execution-approvals`)
      .send({ decision: "rejected", summary: "不授权此操作。" })
      .expect(200);
    expect(decision.body.execution.pendingApproval).toMatchObject({ status: "rejected", decisionSummary: "不授权此操作。" });

    expect(await readFile(join(workspace, "legacy.md"), "utf8")).toBe("必须保留");
    await expect(readFile(join(root, "outside.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(workspace, "skill.md"), "utf8")).rejects.toThrow();
  });

  it("lets the local API stop one Run, continue a narrow correction, and route scope changes back to plan approval", async () => {
    const role = await apiRole();
    const app = createApp({ version: "0.1.0", projects, todos, runs, connections, roles, professionalAgents });
    const corrected = await approvedRun();
    holdModelRequest = true;
    await request(app).post(`/api/runs/${corrected.id}/professional-agent/execute`).send({ roleId: role.id }).expect(202);
    await modelRequestStarted;
    holdModelRequest = false;
    modelReplies.push(JSON.stringify({ summary: "已按纠偏完成。", actions: [{ type: "write_file", path: "corrected.md", content: "纠偏完成" }] }));

    const continued = await request(app)
      .post(`/api/runs/${corrected.id}/corrections`)
      .send({ instruction: "仅将输出文件名更正为 corrected.md。", changeKind: "minor" })
      .expect(202);
    expect(continued.body).toMatchObject({ status: "running" });
    await professionalAgents.waitForCompletion(corrected.id);
    expect(await readFile(join(workspace, "corrected.md"), "utf8")).toBe("纠偏完成");
    expect((await runs.get(corrected.id)).timeline.map((event) => event.kind)).toContain("correction");

    const replan = await approvedRun();
    holdModelRequest = true;
    resetModelRequestSignal();
    await request(app).post(`/api/runs/${replan.id}/professional-agent/execute`).send({ roleId: role.id }).expect(202);
    await modelRequestStarted;
    const replanned = await request(app)
      .post(`/api/runs/${replan.id}/corrections`)
      .send({ instruction: "将验收范围扩大到同时生成迁移说明。", changeKind: "scope" })
      .expect(200);
    expect(replanned.body).toMatchObject({ status: "awaiting_plan_approval", planning: { approvalStatus: "awaiting_approval" } });
    expect(await runs.get(replan.id)).toMatchObject({ status: "awaiting_plan_approval", planning: { approvalStatus: "awaiting_approval" } });

    const approvedReplan = await request(app)
      .post(`/api/runs/${replan.id}/plan-decisions`)
      .send({ decision: "approved", summary: "用户批准纠偏后的范围。" })
      .expect(200);
    expect(approvedReplan.body).toMatchObject({ status: "queued", planning: { approvalStatus: "approved" } });
    await professionalAgents.waitForCompletion(replan.id);
    expect(await runs.get(replan.id)).toMatchObject({ status: "queued", planning: { approvalStatus: "approved" } });

    const stopped = await approvedRun();
    holdModelRequest = true;
    await request(app).post(`/api/runs/${stopped.id}/professional-agent/execute`).send({ roleId: role.id }).expect(202);
    const stoppedResponse = await request(app)
      .post(`/api/runs/${stopped.id}/stop`)
      .send({ summary: "用户停止当前 Run" })
      .expect(200);
    expect(stoppedResponse.body).toMatchObject({ status: "cancelled", execution: { retryable: false } });
    await professionalAgents.waitForCompletion(stopped.id);
  });

  it("fail-closes code tasks on the API Professional Agent so main-workspace writes never happen", async () => {
    const role = await apiRole();
    const isolated = new ProfessionalAgentService({ projects, todos, runs, roles, connections });
    const run = await runs.create(todoId, "实现一个新功能并修复相关回归。");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准代码任务。" });

    const afterPlan = await runs.get(run.id);
    expect(["implementation", "bug_fix", "automation"]).toContain(afterPlan.planning?.assessment.taskType);

    await expect(isolated.start(run.id, { roleId: role.id })).rejects.toThrow(/隔离 Git Worktree|Codex CLI Harness/);
    expect(modelCallCount).toBe(0);
    await expect(readFile(join(workspace, "result.md"), "utf8")).rejects.toThrow();
  });

  it("pauses Professional Agent start when the wired queue reports resource shortage", async () => {
    const { ResourceGuardService } = await import("../queue/resourceGuardService.js");
    const { RunQueueService } = await import("../queue/runQueueService.js");
    const disk = { freeBytes: async () => 1024 };
    const memory = { freeBytes: () => 4 * 1024 * 1024 * 1024 };
    const resourceGuard = new ResourceGuardService(root, { minFreeDiskBytes: 1024 * 1024 * 1024 }, disk, memory);
    const queue = await RunQueueService.open({
      statePath: join(root, "queue-resource.json"),
      resourceGuard,
      runs
    });
    const gated = new ProfessionalAgentService({ projects, todos, runs, roles, connections, queue });
    const run = await approvedRun();
    const role = await apiRole();
    const paused = await gated.start(run.id, { roleId: role.id });
    expect(paused).toMatchObject({ status: "paused" });
    expect(paused.timeline.map((event) => event.summary).join("\n")).toMatch(/磁盘空间不足|暂停新任务/);
    expect(modelCallCount).toBe(0);
    expect(queue.hasLease(run.id)).toBe(false);
  });

  it("rejects a second concurrent write when the wired queue holds the default write lease", async () => {
    const { ResourceGuardService } = await import("../queue/resourceGuardService.js");
    const { RunQueueService } = await import("../queue/runQueueService.js");
    const resourceGuard = new ResourceGuardService(
      root,
      {},
      { freeBytes: async () => 8 * 1024 * 1024 * 1024 },
      { freeBytes: () => 4 * 1024 * 1024 * 1024 }
    );
    const queue = await RunQueueService.open({
      statePath: join(root, "queue-concurrency.json"),
      resourceGuard,
      runs
    });
    holdModelRequest = true;
    const gated = new ProfessionalAgentService({ projects, todos, runs, roles, connections, queue });
    const first = await approvedRun();
    const second = await approvedRun();
    const role = await apiRole();
    await gated.start(first.id, { roleId: role.id });
    expect(queue.hasLease(first.id)).toBe(true);
    await modelRequestStarted;
    await expect(gated.start(second.id, { roleId: role.id })).rejects.toThrow(
      /写入型代理已达并行上限|同一项目的写入任务只有在 Worktree 隔离条件满足时才允许并行/
    );
    expect(modelCallCount).toBeGreaterThanOrEqual(1);
    await runs.stop(first.id, "释放队列测试");
    await gated.waitForCompletion(first.id);
  });
});
