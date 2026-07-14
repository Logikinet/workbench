import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { FakeModelProvider } from "../model/fakeProvider.js";
import { ModelRuntime } from "../model/modelRuntime.js";
import type { ModelProvider, ModelProviderRequest, ModelProviderResponse } from "../model/types.js";
import { RoleService } from "../roles/roleService.js";
import {
  AiPlanningService,
  isAiPlanningSuccess,
  toPlanningStateFields,
  type FirstmateModelAssessment,
  type SecondmateModelPlan
} from "./aiPlanningService.js";
import { selectPlanningContext } from "./planningContext.js";
import { firstmateAssessmentSchema, secondmatePlanSchema } from "./planningSchemas.js";
import { validateAgainstSchema } from "../model/jsonSchema.js";

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

/** Content-aware fake that returns distinct Firstmate / Secondmate JSON per call. */
class PlanningScriptProvider implements ModelProvider {
  readonly calls: ModelProviderRequest[] = [];
  constructor(
    private readonly handlers: {
      firstmate: (request: ModelProviderRequest) => FirstmateModelAssessment;
      secondmate: (request: ModelProviderRequest) => SecondmateModelPlan;
    }
  ) {}

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.calls.push(request);
    const blob = JSON.stringify(request.messages.map((message) => message.content)).toLocaleLowerCase();
    const isSecondmate = blob.includes("secondmate") || blob.includes("generate a task-specific");
    const payload = isSecondmate ? this.handlers.secondmate(request) : this.handlers.firstmate(request);
    return { content: JSON.stringify(payload) };
  }
}

const roleBase = {
  name: "planner",
  responsibility: "planning",
  systemInstruction: "Return structured JSON only.",
  harness: "api" as const,
  reasoningEffort: "medium" as const,
  skills: ["research"],
  tools: ["model-api"],
  permissions: { workspace: "project_only" as const, network: false, shell: false, externalSend: false },
  allowFirstmateAutoInvoke: false
};

function firstmateFor(taskType: FirstmateModelAssessment["taskType"], overrides: Partial<FirstmateModelAssessment> = {}): FirstmateModelAssessment {
  return {
    taskType,
    requiredCapabilities: taskType === "research" || taskType === "writing"
      ? ["workspace", "documents"]
      : ["workspace", "filesystem", "shell", "tests"],
    criticalInputs: [],
    assumptions: ["仅在获准的 Project 工作区范围内工作。"],
    complexity: taskType === "writing" ? "low" : "medium",
    rationale: `Classified as ${taskType} from todo and project context.`,
    usedProjectFacts: ["project.name=Demo"],
    usedFiles: ["src/login.ts"],
    insufficientEvidence: false,
    evidenceGaps: [],
    ...overrides
  };
}

function secondmateFor(taskType: FirstmateModelAssessment["taskType"], overrides: Partial<SecondmateModelPlan> = {}): SecondmateModelPlan {
  const byType: Record<string, SecondmateModelPlan> = {
    implementation: {
      summary: "实现登录会话刷新功能并补充单元测试",
      complexity: "medium",
      steps: [
        "阅读现有 auth 模块与会话刷新入口",
        "实现最小功能改动",
        "补充针对刷新路径的单元测试",
        "运行测试与 typecheck"
      ],
      dependencies: ["auth 模块可编译", "测试框架可用"],
      expectedArtifacts: ["src/auth/sessionRefresh.ts", "src/auth/sessionRefresh.test.ts"],
      allowedScope: ["src/auth/**", "相关测试文件"],
      prohibitions: ["不得在计划获批前修改正式文件"],
      verificationMethods: ["npm test -- sessionRefresh", "typecheck"],
      acceptanceCriteria: ["会话刷新在过期前成功", "单元测试通过"],
      risks: ["可能影响现有登录态"],
      verificationCommands: [["npm", "test"], ["npm", "run", "typecheck"]]
    },
    bug_fix: {
      summary: "复现并修复登录回归，添加防回归测试",
      complexity: "medium",
      steps: [
        "按失败日志复现登录回归",
        "定位根因到最小改动面",
        "修复并添加覆盖该路径的测试",
        "运行回归验证"
      ],
      dependencies: ["可复现的失败场景", "相关日志"],
      expectedArtifacts: ["src/auth/login.ts 修复 diff", "tests/login.regression.test.ts"],
      allowedScope: ["登录相关源码与测试"],
      prohibitions: ["不得大范围重构无关模块"],
      verificationMethods: ["复现原失败用例应通过", "npm test"],
      acceptanceCriteria: ["原回归场景不再失败", "相关测试绿色"],
      risks: ["修复可能掩盖其他错误处理路径"],
      verificationCommands: [["npm", "test"]]
    },
    research: {
      summary: "调研登录回归根因并输出可追溯证据报告",
      complexity: "medium",
      steps: [
        "界定调研问题与成功标准",
        "只读查阅相关模块与历史变更说明",
        "整理证据链与候选根因",
        "撰写结论与未决项"
      ],
      dependencies: ["问题陈述", "可访问的本地代码与文档"],
      expectedArtifacts: ["research/login-regression-findings.md", "evidence 引用列表"],
      allowedScope: ["只读工作区资料；不修改正式源码"],
      prohibitions: ["不得在调研阶段提交功能代码"],
      verificationMethods: ["每条结论可追溯到证据或明确假设"],
      acceptanceCriteria: ["报告列出证据、假设与推荐下一步"],
      risks: ["资料不足时结论必须标为假设"],
      verificationCommands: []
    },
    writing: {
      summary: "撰写登录模块运维说明文档",
      complexity: "low",
      steps: [
        "确认受众与章节范围",
        "根据项目事实起草运维说明",
        "核对术语与路径一致性"
      ],
      dependencies: ["文档主题", "已确认的运维步骤"],
      expectedArtifacts: ["docs/login-ops.md"],
      allowedScope: ["docs/** 与引用材料"],
      prohibitions: ["不得改动业务源码"],
      verificationMethods: ["章节覆盖检查", "与项目事实交叉核对"],
      acceptanceCriteria: ["文档覆盖安装、配置与常见故障"],
      risks: ["过时路径描述"],
      verificationCommands: []
    }
  };
  const base = byType[taskType] ?? byType.implementation;
  return { ...base, ...overrides };
}

describe("planning context selection", () => {
  it("loads only necessary facts and records which files/project facts were used", () => {
    const selected = selectPlanningContext({
      todo: { title: "修复登录回归", description: "添加回归测试" },
      instructions: "优先检查 auth 模块",
      project: { id: "p1", name: "Demo", summary: "本地工作台", workspacePath: "C:/work/demo" },
      workspaceSummary: "git clean; package.json scripts present",
      relatedFiles: [
        { path: "src/auth/login.ts", excerpt: "export function login() {}", reason: "auth" },
        { path: "README.md", excerpt: "unrelated", reason: "docs" },
        { path: "src/auth/session.ts", excerpt: "session", reason: "auth" },
        { path: "noise1.ts", excerpt: "x" },
        { path: "noise2.ts", excerpt: "y" },
        { path: "noise3.ts", excerpt: "z" },
        { path: "noise4.ts", excerpt: "a" },
        { path: "noise5.ts", excerpt: "b" },
        { path: "noise6.ts", excerpt: "c" },
        { path: "noise7.ts", excerpt: "d" }
      ],
      maxRelatedFiles: 3
    });

    expect(selected.usage.projectFacts.some((fact) => fact.includes("Demo"))).toBe(true);
    expect(selected.usage.workspaceSummary).toContain("git clean");
    expect(selected.usage.files.length).toBeLessThanOrEqual(3);
    expect(selected.usage.files.join(" ")).toMatch(/auth|login|session/i);
    expect(selected.usage.omittedBecauseUnnecessary.length).toBeGreaterThan(0);
    expect(selected.promptText).toContain("修复登录回归");
    expect(selected.missingOutcomeDescription).toBe(false);
  });

  it("flags missing outcome description without fabricating project files", () => {
    const selected = selectPlanningContext({ todo: { title: "未命名任务" } });
    expect(selected.missingOutcomeDescription).toBe(true);
    expect(selected.usage.files).toEqual([]);
  });
});

describe("AI Firstmate and Secondmate planning", () => {
  let root: string;
  let connections: ConnectionService;
  let roles: RoleService;
  let firstmateRoleId: string;
  let secondmateRoleId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-ai-planning-"));
    const vault = new MemoryCredentialVault();
    connections = await ConnectionService.open(
      join(root, "connections.json"),
      vault,
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }))
    );
    roles = await RoleService.open(join(root, "roles.json"), connections);
    const connection = await connections.create({
      name: "local-proxy",
      baseUrl: "https://api.example.test/v1",
      apiKey: "secret-should-never-appear",
      modelId: "gpt-5"
    });
    firstmateRoleId = (await roles.create({
      ...roleBase,
      name: "Firstmate",
      connectionId: connection.id,
      modelId: "gpt-5"
    })).id;
    secondmateRoleId = (await roles.create({
      ...roleBase,
      name: "Secondmate",
      connectionId: connection.id,
      modelId: "gpt-5"
    })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function serviceWith(provider: ModelProvider): AiPlanningService {
    return new AiPlanningService({
      modelRuntime: new ModelRuntime({ roles, connections, provider }),
      firstmateRoleId,
      secondmateRoleId
    });
  }

  const baseInput = {
    runId: "run-1",
    todo: { title: "任务", description: "有明确成果" },
    messages: [{ content: "完成可验证结果" }],
    project: { id: "p1", name: "Demo", summary: "示例项目", workspacePath: "C:/work/demo" },
    workspaceSummary: "package.json; src/; tests/",
    relatedFiles: [{ path: "src/login.ts", excerpt: "login()", reason: "entry" }]
  };

  it("Firstmate assesses Todo + project facts + workspace + files into task type and capabilities", async () => {
    const provider = new PlanningScriptProvider({
      firstmate: () => firstmateFor("bug_fix", {
        usedProjectFacts: ["project.name=Demo", "project.workspacePath=C:/work/demo"],
        usedFiles: ["src/login.ts"]
      }),
      secondmate: () => secondmateFor("bug_fix")
    });
    const outcome = await serviceWith(provider).plan({
      ...baseInput,
      todo: { title: "修复登录回归", description: "添加覆盖该问题的测试" },
      messages: [{ content: "用户无法登录，需要回归测试。" }]
    });

    expect(isAiPlanningSuccess(outcome)).toBe(true);
    if (!isAiPlanningSuccess(outcome)) return;
    expect(outcome.assessment.taskType).toBe("bug_fix");
    expect(outcome.assessment.requiredCapabilities).toEqual(expect.arrayContaining(["workspace", "tests"]));
    expect(outcome.assessment.contextUsage?.projectFacts.join(" ")).toMatch(/Demo/);
    expect(outcome.assessment.contextUsage?.files).toContain("src/login.ts");
    expect(outcome.assessment.rationale).toBeTruthy();
    expect(outcome.formalMutations).toEqual([]);
    expect(outcome.dangerousCommands).toEqual([]);
  });

  it("Secondmate emits task-specific steps, deps, artifacts, scopes, verification, and acceptance", async () => {
    const provider = new PlanningScriptProvider({
      firstmate: () => firstmateFor("implementation"),
      secondmate: () => secondmateFor("implementation")
    });
    const outcome = await serviceWith(provider).plan({
      ...baseInput,
      todo: { title: "开发会话刷新", description: "实现 refresh token 路径" }
    });
    expect(isAiPlanningSuccess(outcome)).toBe(true);
    if (!isAiPlanningSuccess(outcome)) return;
    expect(outcome.plan.generatedBy).toBe("secondmate");
    expect(outcome.plan.steps.length).toBeGreaterThan(2);
    expect(outcome.plan.dependencies.length).toBeGreaterThan(0);
    expect(outcome.plan.expectedArtifacts.some((item) => item.includes("sessionRefresh"))).toBe(true);
    expect(outcome.plan.allowedScope.length).toBeGreaterThan(0);
    expect(outcome.plan.verificationMethods.length).toBeGreaterThan(0);
    expect(outcome.plan.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(outcome.plan.prohibitions.join(" ")).toMatch(/Firstmate|正式/);
  });

  it("produces substantially different plans for development, fix, research, and docs samples", async () => {
    const samples: Array<{ title: string; description: string; type: FirstmateModelAssessment["taskType"] }> = [
      { title: "开发会话刷新功能", description: "实现 refresh 并加测试", type: "implementation" },
      { title: "修复登录回归", description: "定位根因并加回归测试", type: "bug_fix" },
      { title: "调研登录问题根因", description: "输出可追溯证据报告", type: "research" },
      { title: "撰写登录运维文档", description: "docs 中的运维说明", type: "writing" }
    ];

    const plans = [];
    for (const sample of samples) {
      const provider = new PlanningScriptProvider({
        firstmate: () => firstmateFor(sample.type),
        secondmate: () => secondmateFor(sample.type)
      });
      const outcome = await serviceWith(provider).plan({
        ...baseInput,
        todo: { title: sample.title, description: sample.description },
        messages: [{ content: sample.description }]
      });
      expect(isAiPlanningSuccess(outcome)).toBe(true);
      if (isAiPlanningSuccess(outcome)) plans.push(outcome.plan);
    }

    expect(plans).toHaveLength(4);
    const summaries = plans.map((plan) => plan.summary);
    expect(new Set(summaries).size).toBe(4);
    const artifacts = plans.map((plan) => plan.expectedArtifacts.join("|"));
    expect(new Set(artifacts).size).toBe(4);
    const stepHeads = plans.map((plan) => plan.steps[0]);
    expect(new Set(stepHeads).size).toBeGreaterThan(1);

    const research = plans[2];
    const impl = plans[0];
    expect(research.allowedScope.join(" ")).toMatch(/只读|不修改/);
    expect(impl.verificationCommands.length).toBeGreaterThan(0);
    expect(research.verificationCommands.length).toBe(0);
    expect(plans[3].complexity).toBe("low");
    expect(plans[3].steps.length).toBeLessThan(impl.steps.length);
  });

  it("pauses on model failure and does not fabricate a plan", async () => {
    const provider = new FakeModelProvider({ scenario: "auth_fail" });
    const outcome = await serviceWith(provider).plan(baseInput);
    expect(outcome.status).toBe("paused");
    if (outcome.status !== "paused") return;
    expect(outcome.reason).toMatch(/Firstmate|认证|失败/);
    expect(outcome.errorKind).toBe("authentication_failed");
    expect("plan" in outcome && outcome.plan).toBeFalsy();
    expect(outcome.formalMutations).toEqual([]);
  });

  it("pauses when evidence is insufficient instead of inventing a plan", async () => {
    const provider = new PlanningScriptProvider({
      firstmate: () => firstmateFor("research", {
        insufficientEvidence: true,
        evidenceGaps: ["缺少原始失败日志", "未提供受影响版本"]
      }),
      secondmate: () => secondmateFor("research")
    });
    const outcome = await serviceWith(provider).plan({
      ...baseInput,
      todo: { title: "调研未知故障", description: "信息很少" }
    });
    expect(outcome.status).toBe("paused");
    if (outcome.status !== "paused") return;
    expect(outcome.evidenceGaps).toEqual(expect.arrayContaining(["缺少原始失败日志"]));
    expect(provider.calls.length).toBe(1);
  });

  it("enters awaiting_input for critical gaps and never mutates formal files", async () => {
    const provider = new PlanningScriptProvider({
      firstmate: () => firstmateFor("other", {
        criticalInputs: ["请说明验收标准"]
      }),
      secondmate: () => secondmateFor("implementation")
    });
    const outcome = await serviceWith(provider).plan({
      runId: "run-missing",
      todo: { title: "模糊任务" },
      messages: []
    });
    expect(outcome.status).toBe("awaiting_input");
    if (outcome.status !== "awaiting_input") return;
    expect(outcome.assessment.criticalInputs.length).toBeGreaterThan(0);
    expect(outcome.formalMutations).toEqual([]);
    expect(outcome.dangerousCommands).toEqual([]);
    expect(provider.calls.length).toBe(1);
  });

  it("honors user classification overrides without rewriting formal artifacts", async () => {
    const provider = new PlanningScriptProvider({
      firstmate: () => firstmateFor("bug_fix"),
      secondmate: () => secondmateFor("research")
    });
    const outcome = await serviceWith(provider).plan({
      ...baseInput,
      todo: { title: "调查登录回归的根因，并给出一份报告。" },
      overrides: { taskType: "research", requiredCapabilities: ["workspace", "documents"] }
    });
    expect(isAiPlanningSuccess(outcome)).toBe(true);
    if (!isAiPlanningSuccess(outcome)) return;
    expect(outcome.assessment.taskType).toBe("research");
    expect(outcome.assessment.requiredCapabilities).toEqual(["workspace", "documents"]);
  });

  it("maps outcomes to planning state fields without file mutations", async () => {
    const provider = new PlanningScriptProvider({
      firstmate: () => firstmateFor("implementation"),
      secondmate: () => secondmateFor("implementation")
    });
    const outcome = await serviceWith(provider).plan(baseInput);
    const fields = toPlanningStateFields(outcome);
    expect(fields.approvalStatus).toBe("awaiting_approval");
    expect(fields.plan?.generatedBy).toBe("secondmate");
    expect(fields.formalMutations).toEqual([]);
    expect(fields.dangerousCommands).toEqual([]);
  });

  it("schemas accept sample Firstmate and Secondmate payloads", () => {
    const assessment = firstmateFor("bug_fix");
    const plan = secondmateFor("bug_fix");
    expect(validateAgainstSchema(assessment, firstmateAssessmentSchema).valid).toBe(true);
    expect(validateAgainstSchema(plan, secondmatePlanSchema).valid).toBe(true);
    expect(validateAgainstSchema({ ...plan, extra: true }, secondmatePlanSchema).valid).toBe(false);
  });
});
