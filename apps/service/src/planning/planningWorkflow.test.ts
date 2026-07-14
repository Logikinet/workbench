import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { createApp } from "../http/app.js";
import { FakeModelProvider } from "../model/fakeProvider.js";
import { ModelRuntime } from "../model/modelRuntime.js";
import type { ModelProvider, ModelProviderRequest, ModelProviderResponse } from "../model/types.js";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { RoleService } from "../roles/roleService.js";
import { RunService } from "../runs/runService.js";
import { TodoService } from "../todos/todoService.js";
import { AiPlanningService, isAiPlanningSuccess } from "./aiPlanningService.js";
import { createPlanningRouter } from "./planningRoutes.js";

describe("Firstmate and Secondmate planning approval contract", () => {
  let root: string;
  let todos: TodoService;
  let runs: RunService;
  let todoId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-planning-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({ title: "修复登录回归" })).id;
    runs = await RunService.open(join(root, "runs.json"), todos);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("has Firstmate classify the Run, displays assumptions, and records a complexity-matched Secondmate plan", async () => {
    const run = await runs.create(todoId, "修复登录回归并添加覆盖该问题的测试。");

    expect(run).toMatchObject({
      status: "awaiting_plan_approval",
      planning: {
        approvalStatus: "awaiting_approval",
        assessment: {
          taskType: "bug_fix",
          requiredCapabilities: expect.arrayContaining(["workspace", "tests"]),
          criticalInputs: [],
          assumptions: expect.any(Array)
        }
      }
    });
    expect(run.planVersions).toHaveLength(1);
    expect(run.planVersions[0]).toMatchObject({
      generatedBy: "secondmate",
      steps: expect.any(Array),
      acceptanceCriteria: expect.any(Array),
      risks: expect.any(Array),
      prohibitions: expect.arrayContaining([expect.stringContaining("Firstmate")])
    });
    expect(run.artifacts).toEqual([]);
  });

  it("only pauses for a missing critical result and turns user context into a new plan", async () => {
    const run = await runs.create(todoId);
    expect(run).toMatchObject({ status: "waiting_for_user", planning: { approvalStatus: "awaiting_input" } });
    expect(run.planning?.assessment.criticalInputs).toHaveLength(1);
    expect(run.askUserRequests.some((entry) => entry.status === "pending" && entry.kind === "ask_user")).toBe(true);

    const planned = await runs.updatePlanning(run.id, {
      additionalContext: "成功标准是用户能够使用已有账号登录，且回归测试通过。"
    });
    expect(planned).toMatchObject({ status: "awaiting_plan_approval", planning: { approvalStatus: "awaiting_approval" } });
    expect(planned.planVersions).toHaveLength(1);
  });

  it("lets users correct classification, return a plan for a new version, approve it, or cancel it", async () => {
    const run = await runs.create(todoId, "调查登录回归的根因，并给出一份报告。");
    const corrected = await runs.updatePlanning(run.id, {
      taskType: "research",
      requiredCapabilities: ["workspace", "documents"]
    });
    expect(corrected.planning?.assessment).toMatchObject({ taskType: "research", requiredCapabilities: ["workspace", "documents"] });
    expect(corrected.planVersions).toHaveLength(2);

    const returned = await runs.decidePlan(run.id, { decision: "returned", summary: "补充回归范围和已知风险。" });
    expect(returned).toMatchObject({ status: "awaiting_plan_approval", planning: { approvalStatus: "awaiting_approval" } });
    expect(returned.approvals.at(-1)).toMatchObject({ decision: "returned" });
    expect(returned.planVersions).toHaveLength(3);

    const approved = await runs.decidePlan(run.id, { decision: "approved", summary: "计划边界明确，批准。" });
    expect(approved).toMatchObject({ status: "queued", planning: { approvalStatus: "approved", approvedPlanVersion: 3 } });

    const cancelled = await runs.create(todoId, "修复一个小问题");
    expect(await runs.decidePlan(cancelled.id, { decision: "cancelled", summary: "暂不执行。" })).toMatchObject({
      status: "cancelled",
      planning: { approvalStatus: "cancelled" }
    });
  });

  it("blocks execution and formal Artifacts until the current plan is approved", async () => {
    const run = await runs.create(todoId, "修复登录回归并添加测试。");

    await expect(runs.transition(run.id, "running", "开始执行")).rejects.toThrow("approved plan");
    await expect(runs.transition(run.id, "awaiting_review", "伪造执行结束")).rejects.toThrow(/controlled finish|independent review|approved plan/);
    await expect(runs.transition(run.id, "completed", "伪造完成")).rejects.toThrow(/controlled finish|independent review|formal user acceptance|approved plan/);
    await expect(runs.recordArtifact(run.id, { path: "fix.md", kind: "document" })).rejects.toThrow("approved plan");

    await runs.decidePlan(run.id, { decision: "approved", summary: "批准。" });
    await expect(runs.transition(run.id, "running", "开始执行")).resolves.toMatchObject({ status: "running" });
    await expect(runs.recordArtifact(run.id, { path: "fix.md", kind: "document" })).resolves.toMatchObject({ artifacts: [expect.objectContaining({ path: "fix.md" })] });
  });

  it("does not let legacy plan calls bypass missing key input or revive a cancelled plan", async () => {
    const missingInput = await runs.create(todoId);
    // Blocks either via critical-input gate or pending AskUser (task 19) while key input is missing.
    await expect(runs.recordPlanVersion(missingInput.id, { revisionNote: "尝试绕过计划" })).rejects.toThrow(/critical input|waiting_for_user|AskUser/);

    const cancelled = await runs.create(todoId, "修复登录回归并添加测试。");
    await runs.decidePlan(cancelled.id, { decision: "cancelled", summary: "不再执行。" });
    await expect(runs.updatePlanning(cancelled.id, { additionalContext: "重新开始" })).rejects.toThrow("cancelled");
    await expect(runs.decidePlan(cancelled.id, { decision: "approved", summary: "绕过取消。" })).rejects.toThrow("cancelled");
  });

  it("exposes correction and plan decisions through the local Run API", async () => {
    const app = createApp({ version: "0.1.0", todos, runs });
    const created = await request(app).post(`/api/todos/${todoId}/runs`).send({ message: "调查登录问题并形成报告。" }).expect(201);

    const corrected = await request(app)
      .patch(`/api/runs/${created.body.id}/planning`)
      .send({ taskType: "research", requiredCapabilities: ["workspace", "documents"] })
      .expect(200);
    expect(corrected.body.planning.assessment).toMatchObject({ taskType: "research" });

    await request(app)
      .post(`/api/runs/${created.body.id}/plan-versions`)
      .send({ version: 999, summary: "用户伪造的计划摘要" })
      .expect(400);

    const regenerated = await request(app)
      .post(`/api/runs/${created.body.id}/plan-versions`)
      .send({ revisionNote: "请重新生成并保留结构化验收与风险。" })
      .expect(201);
    expect(regenerated.body.planVersions.at(-1)).toMatchObject({ generatedBy: "secondmate", steps: expect.any(Array), acceptanceCriteria: expect.any(Array) });

    const approved = await request(app)
      .post(`/api/runs/${created.body.id}/plan-decisions`)
      .send({ decision: "approved", summary: "批准此计划。" })
      .expect(200);
    expect(approved.body).toMatchObject({ status: "queued", planning: { approvalStatus: "approved" } });
  });
});

class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();
  async read(reference: string): Promise<string | undefined> {
    return this.values.get(reference);
  }
  async write(reference: string, secret: string): Promise<void> {
    this.values.set(reference, secret);
  }
  async remove(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

class DualPhasePlanningProvider implements ModelProvider {
  readonly calls: ModelProviderRequest[] = [];
  constructor(
    private readonly firstmate: Record<string, unknown>,
    private readonly secondmate: Record<string, unknown>
  ) {}
  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.calls.push(request);
    const blob = JSON.stringify(request.messages.map((message) => message.content)).toLocaleLowerCase();
    const second = blob.includes("secondmate") || blob.includes("generate a task-specific");
    return { content: JSON.stringify(second ? this.secondmate : this.firstmate) };
  }
}

describe("AI planning entrypoints on Run-like inputs (task 18)", () => {
  let root: string;
  let connections: ConnectionService;
  let roles: RoleService;
  let firstmateRoleId: string;
  let secondmateRoleId: string;
  let todos: TodoService;
  let runs: RunService;
  let projects: ProjectService;
  let todoId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-ai-plan-wf-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    const project = await projects.create({
      name: "Demo",
      workspacePath: workspace,
      summary: "demo project",
      authorizationGrantId: (await projects.requestWorkspaceAuthorization(workspace)).id
    });
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({
      title: "修复登录回归",
      description: "添加覆盖该问题的测试。",
      projectId: project.id
    })).id;
    runs = await RunService.open(join(root, "runs.json"), todos);

    const vault = new MemoryCredentialVault();
    connections = await ConnectionService.open(
      join(root, "connections.json"),
      vault,
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }))
    );
    roles = await RoleService.open(join(root, "roles.json"), connections);
    const connection = await connections.create({
      name: "proxy",
      baseUrl: "https://api.example.test/v1",
      apiKey: "never-log-me",
      modelId: "gpt-5"
    });
    const roleInput = {
      responsibility: "plan",
      systemInstruction: "JSON only",
      harness: "api" as const,
      reasoningEffort: "medium" as const,
      skills: ["research"] as string[],
      tools: ["model-api"] as string[],
      permissions: { workspace: "project_only" as const, network: false, shell: false, externalSend: false },
      allowFirstmateAutoInvoke: false,
      connectionId: connection.id,
      modelId: "gpt-5"
    };
    firstmateRoleId = (await roles.create({ ...roleInput, name: "Firstmate" })).id;
    secondmateRoleId = (await roles.create({ ...roleInput, name: "Secondmate" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("plans from Run-like Todo/project context via FakeModelProvider without formal file mutations", async () => {
    const provider = new DualPhasePlanningProvider(
      {
        taskType: "bug_fix",
        requiredCapabilities: ["workspace", "filesystem", "shell", "tests"],
        criticalInputs: [],
        assumptions: ["仅在获准工作区内修复"],
        complexity: "medium",
        rationale: "登录回归 + 测试覆盖",
        usedProjectFacts: ["project.name=Demo"],
        usedFiles: ["src/login.ts"],
        insufficientEvidence: false,
        evidenceGaps: []
      },
      {
        summary: "修复登录回归并补充防回归测试",
        complexity: "medium",
        steps: ["复现", "定位", "最小修复", "加测试", "验证"],
        dependencies: ["可复现步骤"],
        expectedArtifacts: ["login fix", "regression test"],
        allowedScope: ["auth 模块"],
        prohibitions: ["不得在计划获批前修改正式文件", "Firstmate 不得生成正式 Artifact"],
        verificationMethods: ["复现原失败", "npm test"],
        acceptanceCriteria: ["回归场景通过", "测试绿色"],
        risks: ["可能影响会话"],
        verificationCommands: [["npm", "test"]]
      }
    );

    const ai = new AiPlanningService({
      modelRuntime: new ModelRuntime({ roles, connections, provider }),
      firstmateRoleId,
      secondmateRoleId
    });

    const run = await runs.create(todoId, "修复登录回归并添加覆盖该问题的测试。");
    const project = (await projects.list())[0];
    const outcome = await ai.plan({
      runId: run.id,
      todo: { title: "修复登录回归", description: "添加覆盖该问题的测试。" },
      messages: run.messages,
      project: {
        id: project.id,
        name: project.name,
        summary: project.summary,
        workspacePath: project.workspacePath
      },
      workspaceSummary: "package.json present; auth module exists",
      relatedFiles: [{ path: "src/login.ts", excerpt: "export function login() {}", reason: "suspect" }]
    });

    expect(isAiPlanningSuccess(outcome)).toBe(true);
    if (!isAiPlanningSuccess(outcome)) return;
    expect(outcome.assessment.taskType).toBe("bug_fix");
    expect(outcome.plan.expectedArtifacts).toContain("regression test");
    expect(outcome.formalMutations).toEqual([]);
    expect(outcome.dangerousCommands).toEqual([]);
    // Existing Run approval gates still block formal artifacts until plan approval.
    await expect(runs.recordArtifact(run.id, { path: "fix.md", kind: "document" })).rejects.toThrow("approved plan");
  });

  it("exposes optional AI planning route that does not write formal artifacts", async () => {
    const provider = new DualPhasePlanningProvider(
      {
        taskType: "research",
        requiredCapabilities: ["workspace", "documents"],
        criticalInputs: [],
        assumptions: ["只读调研"],
        complexity: "medium",
        rationale: "调研任务",
        usedProjectFacts: ["project.name=Demo"],
        usedFiles: [],
        insufficientEvidence: false,
        evidenceGaps: []
      },
      {
        summary: "调研报告计划",
        complexity: "medium",
        steps: ["界定问题", "收集证据", "写结论"],
        dependencies: ["问题陈述"],
        expectedArtifacts: ["research-report.md"],
        allowedScope: ["只读"],
        prohibitions: ["不得修改正式源码", "Firstmate 不得生成正式 Artifact"],
        verificationMethods: ["证据可追溯"],
        acceptanceCriteria: ["报告含证据与假设"],
        risks: ["资料不足"],
        verificationCommands: []
      }
    );
    const ai = new AiPlanningService({
      modelRuntime: new ModelRuntime({ roles, connections, provider }),
      firstmateRoleId,
      secondmateRoleId
    });
    const app = createApp({ version: "0.1.0", todos, runs, projects });
    app.use(createPlanningRouter({ aiPlanning: ai, runs, todos, projects }));

    const created = await request(app)
      .post(`/api/todos/${todoId}/runs`)
      .send({ message: "调查登录问题并形成报告。" })
      .expect(201);

    const planned = await request(app)
      .post(`/api/runs/${created.body.id}/ai-planning`)
      .send({ workspaceSummary: "auth sources present" })
      .expect(200);

    expect(planned.body.outcome.status).toBe("awaiting_approval");
    expect(planned.body.formalMutations).toEqual([]);
    expect(planned.body.outcome.plan.expectedArtifacts).toContain("research-report.md");

    const stillBlocked = await request(app)
      .post(`/api/runs/${created.body.id}/artifacts`)
      .send({ path: "sneaky.md", kind: "document" })
      .expect(400);
    expect(String(stillBlocked.body.error ?? stillBlocked.text)).toMatch(/approved plan/i);
  });

  it("pauses AI planning on provider failure without inventing a plan version", async () => {
    const ai = new AiPlanningService({
      modelRuntime: new ModelRuntime({
        roles,
        connections,
        provider: new FakeModelProvider({ scenario: "network_failed" })
      }),
      firstmateRoleId,
      secondmateRoleId
    });
    const outcome = await ai.plan({
      todo: { title: "任意任务", description: "有成果" },
      messages: [{ content: "做一下" }]
    });
    expect(outcome.status).toBe("paused");
    if (outcome.status !== "paused") return;
    expect(outcome.reason).toMatch(/失败|网络/);
    expect("plan" in outcome ? outcome.plan : undefined).toBeUndefined();
  });
});
