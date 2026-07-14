import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { FakeModelProvider } from "../model/fakeProvider.js";
import { ModelRuntime } from "../model/modelRuntime.js";
import type { ModelProvider, ModelProviderRequest, ModelProviderResponse } from "../model/types.js";
import { AiPlanningService } from "../planning/aiPlanningService.js";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { RoleService } from "../roles/roleService.js";
import { TodoService } from "../todos/todoService.js";
import { RunService } from "./runService.js";

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

const roleBase = {
  responsibility: "planning",
  systemInstruction: "Return structured JSON only.",
  harness: "api" as const,
  reasoningEffort: "medium" as const,
  skills: [] as string[],
  tools: ["model-api"],
  permissions: { workspace: "project_only" as const, network: false, shell: false, externalSend: false },
  allowFirstmateAutoInvoke: false
};

describe("RunService AI planning wiring (task 18 complete)", () => {
  let root: string;
  let runs: RunService;
  let todos: TodoService;
  let todoId: string;
  let provider: DualPhasePlanningProvider;
  let connections: ConnectionService;
  let roles: RoleService;
  let firstmateRoleId: string;
  let secondmateRoleId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-ai-wire-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({ title: "修复登录回归", description: "添加测试" })).id;
    runs = await RunService.open(join(root, "runs.json"), todos);

    connections = await ConnectionService.open(
      join(root, "connections.json"),
      new MemoryCredentialVault(),
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }))
    );
    roles = await RoleService.open(join(root, "roles.json"), connections);
    const connection = await connections.create({
      name: "fake",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-test",
      modelId: "gpt-test"
    });
    firstmateRoleId = (await roles.create({
      ...roleBase,
      name: "Firstmate",
      connectionId: connection.id,
      modelId: "gpt-test"
    })).id;
    secondmateRoleId = (await roles.create({
      ...roleBase,
      name: "Secondmate",
      connectionId: connection.id,
      modelId: "gpt-test"
    })).id;

    provider = new DualPhasePlanningProvider(
      {
        taskType: "bug_fix",
        requiredCapabilities: ["workspace", "tests"],
        criticalInputs: [],
        assumptions: ["仅工作区"],
        complexity: "medium",
        rationale: "登录回归",
        usedProjectFacts: [],
        usedFiles: [],
        insufficientEvidence: false,
        evidenceGaps: []
      },
      {
        summary: "AI 修复登录回归计划",
        complexity: "medium",
        steps: ["复现", "定位", "修复", "加测试"],
        dependencies: ["可复现"],
        expectedArtifacts: ["login fix", "test"],
        allowedScope: ["auth"],
        prohibitions: ["不得在计划获批前修改正式文件", "Firstmate 不得生成正式 Artifact"],
        verificationMethods: ["npm test"],
        acceptanceCriteria: ["登录成功", "测试绿"],
        risks: ["会话"],
        verificationCommands: [["npm", "test"]]
      }
    );

    const ai = new AiPlanningService({
      modelRuntime: new ModelRuntime({ roles, connections, provider }),
      firstmateRoleId,
      secondmateRoleId
    });
    runs.configurePlanning({ aiPlanning: ai });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses AiPlanningService on create instead of fixed template summary", async () => {
    const run = await runs.create(todoId, "修复登录回归并添加覆盖该问题的测试。");
    expect(run.status).toBe("awaiting_plan_approval");
    expect(run.planVersions[0]?.summary).toBe("AI 修复登录回归计划");
    expect(run.planVersions[0]?.expectedArtifacts).toContain("login fix");
    expect(run.planning?.assessment.rationale).toMatch(/登录/);
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    await expect(runs.recordArtifact(run.id, { path: "x.md", kind: "document" })).rejects.toThrow("approved plan");
  });

  it("pauses without inventing a plan when AI fails", async () => {
    const ai = new AiPlanningService({
      modelRuntime: new ModelRuntime({
        roles,
        connections,
        provider: new FakeModelProvider({ scenario: "network_failed" })
      }),
      firstmateRoleId,
      secondmateRoleId
    });
    runs.configurePlanning({ aiPlanning: ai });

    const run = await runs.create(todoId, "任意有成果的任务描述");
    expect(run.status).toBe("paused");
    expect(run.planVersions).toHaveLength(0);
    expect(run.timeline.some((event) => event.summary.includes("暂停"))).toBe(true);
  });
});
