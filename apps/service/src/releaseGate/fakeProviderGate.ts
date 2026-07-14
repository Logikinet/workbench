/**
 * Fake-provider AI plan + execute path for CI-safe release gate.
 * Never requires real OpenAI / Codex credentials.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { createFakeTools } from "../execution/controlledTools.js";
import {
  runToolLoop,
  toolMapOf,
  type ToolLoopEvent,
  type ToolLoopHost
} from "../execution/toolLoop.js";
import { FakeModelProvider } from "../model/fakeProvider.js";
import { ModelRuntime } from "../model/modelRuntime.js";
import type { ModelProvider, ModelProviderRequest, ModelProviderResponse } from "../model/types.js";
import {
  AiPlanningService,
  isAiPlanningSuccess,
  type FirstmateModelAssessment,
  type SecondmateModelPlan
} from "../planning/aiPlanningService.js";
import { RoleService } from "../roles/roleService.js";
import type { ReleaseGateCheck } from "./releaseGateTypes.js";

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

/** Content-aware fake returning Firstmate then Secondmate structured JSON. */
class DualPhasePlanningProvider implements ModelProvider {
  readonly calls: ModelProviderRequest[] = [];

  constructor(
    private readonly firstmate: FirstmateModelAssessment,
    private readonly secondmate: SecondmateModelPlan
  ) {}

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.calls.push(request);
    const blob = JSON.stringify(request.messages.map((message) => message.content)).toLocaleLowerCase();
    const isSecondmate = blob.includes("secondmate") || blob.includes("generate a task-specific");
    return {
      content: JSON.stringify(isSecondmate ? this.secondmate : this.firstmate),
      usage: { promptTokens: 8, completionTokens: 12, totalTokens: 20 }
    };
  }
}

const roleBase = {
  name: "gate-planner",
  responsibility: "planning",
  systemInstruction: "Return structured JSON only.",
  harness: "api" as const,
  reasoningEffort: "medium" as const,
  skills: ["research"],
  tools: ["model-api"],
  permissions: {
    workspace: "project_only" as const,
    network: false,
    shell: false,
    externalSend: false
  },
  allowFirstmateAutoInvoke: false
};

function toolCallJson(tool: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "tool_call", tool, arguments: args });
}

/**
 * Run AI Firstmate/Secondmate planning + multi-turn tool-loop execute via FakeModelProvider.
 * Confirms the formal plan+execute path works without any real API key or Codex session.
 */
export async function checkFakeProviderPlanAndExecute(): Promise<ReleaseGateCheck> {
  const root = await mkdtemp(join(tmpdir(), "paw-release-gate-fake-"));
  try {
    const vault = new MemoryCredentialVault();
    const connections = await ConnectionService.open(join(root, "connections.json"), vault);
    const roles = await RoleService.open(join(root, "roles.json"), connections);

    // Placeholder connection — FakeModelProvider never reads the vault secret.
    const connection = await connections.create({
      name: "fake-ci-connection",
      baseUrl: "https://api.example.test/v1",
      apiKey: "ci-placeholder-not-used-by-fake-provider",
      modelId: "fake-model"
    });

    const firstmateRoleId = (
      await roles.create({
        ...roleBase,
        name: "Firstmate",
        connectionId: connection.id,
        modelId: "fake-model"
      })
    ).id;
    const secondmateRoleId = (
      await roles.create({
        ...roleBase,
        name: "Secondmate",
        connectionId: connection.id,
        modelId: "fake-model"
      })
    ).id;

    const firstmate: FirstmateModelAssessment = {
      taskType: "bug_fix",
      requiredCapabilities: ["workspace", "filesystem", "tests"],
      criticalInputs: [],
      assumptions: ["仅在获准工作区内修复"],
      complexity: "medium",
      rationale: "CI gate: login regression + test coverage",
      usedProjectFacts: ["project.name=GateDemo"],
      usedFiles: ["src/login.ts"],
      insufficientEvidence: false,
      evidenceGaps: []
    };
    const secondmate: SecondmateModelPlan = {
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
    };

    const planningProvider = new DualPhasePlanningProvider(firstmate, secondmate);
    const ai = new AiPlanningService({
      modelRuntime: new ModelRuntime({
        roles,
        connections,
        provider: planningProvider
      }),
      firstmateRoleId,
      secondmateRoleId
    });

    const planOutcome = await ai.plan({
      runId: "gate-run-1",
      todo: { title: "修复登录回归", description: "添加覆盖该问题的测试。" },
      messages: [{ content: "用户无法登录，需要回归测试。" }],
      project: {
        id: "proj-gate",
        name: "GateDemo",
        summary: "CI demo project",
        workspacePath: "C:\\work\\gate-demo"
      },
      workspaceSummary: "package.json present; auth module exists",
      relatedFiles: [{ path: "src/login.ts", excerpt: "export function login() {}", reason: "suspect" }]
    });

    if (!isAiPlanningSuccess(planOutcome)) {
      return failFake(
        "FAKE_PLAN_NOT_APPROVAL",
        `Expected awaiting_approval plan outcome, got ${planOutcome.status}: ${
          "reason" in planOutcome ? planOutcome.reason : ""
        }`,
        { planOutcome }
      );
    }
    if (planOutcome.formalMutations.length !== 0 || planOutcome.dangerousCommands.length !== 0) {
      return failFake(
        "FAKE_PLAN_SIDE_EFFECTS",
        "Planning must not mutate formal files or emit dangerous commands.",
        { planOutcome }
      );
    }
    if (planOutcome.assessment.taskType !== "bug_fix") {
      return failFake("FAKE_PLAN_TASK_TYPE", "Firstmate assessment taskType mismatch.", {
        assessment: planOutcome.assessment
      });
    }
    if (!planOutcome.plan.steps.length || !planOutcome.plan.acceptanceCriteria.length) {
      return failFake("FAKE_PLAN_INCOMPLETE", "Secondmate plan missing steps or acceptance criteria.", {
        plan: planOutcome.plan
      });
    }

    // Execute path: multi-turn tool loop with a separate FakeModelProvider (no network).
    const executeProvider = new FakeModelProvider({
      successContents: [
        toolCallJson("read_file", { path: "src/login.ts" }),
        toolCallJson("write_file", { path: "src/login.ts", content: "export function login() { return true; }" }),
        JSON.stringify({ type: "final", summary: "patched login after reading" })
      ]
    });

    const reads: string[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    const events: ToolLoopEvent[] = [];
    const tools = createFakeTools({
      read_file: (args) => {
        reads.push(String(args.path));
        return { ok: true, summary: `contents of ${args.path}: export function login() {}` };
      },
      write_file: (args) => {
        writes.push({ path: String(args.path), content: String(args.content) });
        return {
          ok: true,
          summary: `wrote ${args.path}`,
          artifacts: [{ path: String(args.path), kind: "file" }]
        };
      }
    });

    const host: ToolLoopHost = {
      runId: "gate-run-1",
      workspacePath: "C:\\work\\gate-demo",
      tools: toolMapOf(...tools),
      signal: new AbortController().signal,
      async invokeModel(messages, signal) {
        const response = await executeProvider.complete({
          connectionId: connection.id,
          modelId: "fake-model",
          messages,
          signal
        });
        return { content: response.content, usage: response.usage };
      },
      onEvent: (event) => {
        events.push(event);
      }
    };

    const executeResult = await runToolLoop(host, {
      systemInstruction: "You are a CI fake professional agent.",
      taskPayload: JSON.stringify({
        task: "fix login regression per approved plan",
        planSummary: planOutcome.plan.summary,
        steps: planOutcome.plan.steps
      })
    });

    if (executeResult.status !== "completed") {
      return failFake(
        "FAKE_EXECUTE_NOT_COMPLETED",
        `Tool-loop execute status was ${executeResult.status}, expected completed.`,
        { executeResult }
      );
    }
    if (reads[0] !== "src/login.ts" || writes.length !== 1) {
      return failFake("FAKE_EXECUTE_TRACE", "Expected read→write tool trace for login.ts.", {
        reads,
        writes,
        toolTrace: executeResult.toolTrace
      });
    }
    if (executeProvider.calls.length < 2) {
      return failFake("FAKE_EXECUTE_NO_MULTI_TURN", "Execute path did not multi-turn via FakeModelProvider.", {
        calls: executeProvider.calls.length
      });
    }

    // Ensure no real secret from the placeholder key leaked into planning provider messages.
    const planningBlob = JSON.stringify(planningProvider.calls);
    if (planningBlob.includes("ci-placeholder-not-used-by-fake-provider")) {
      return failFake(
        "FAKE_PLAN_LEAKED_KEY",
        "Planning provider messages unexpectedly contained the connection apiKey placeholder.",
        {}
      );
    }

    return {
      id: "fake-provider-plan-execute",
      name: "Fake-provider AI plan + execute",
      category: "ai-path",
      status: "pass",
      code: "FAKE_PROVIDER_PLAN_EXECUTE_OK",
      detail:
        "Firstmate/Secondmate planning and multi-turn tool-loop execute completed via FakeModelProvider without real API keys or Codex. Real Codex login remains an environment risk for full Windows E2E.",
      meta: {
        planStatus: planOutcome.status,
        planSteps: planOutcome.plan.steps.length,
        executeStatus: executeResult.status,
        executeTurns: executeResult.turns,
        toolTrace: executeResult.toolTrace.map((entry) => entry.toolName),
        realCredentialsRequired: false,
        realCodexRequired: false
      }
    };
  } catch (error) {
    return failFake(
      "FAKE_PROVIDER_GATE_ERROR",
      error instanceof Error ? error.message : String(error),
      {}
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function failFake(code: string, detail: string, meta: Record<string, unknown>): ReleaseGateCheck {
  return {
    id: "fake-provider-plan-execute",
    name: "Fake-provider AI plan + execute",
    category: "ai-path",
    status: "fail",
    code,
    detail,
    remediation:
      "Fix FakeModelProvider / AiPlanningService / runToolLoop so CI can plan+execute without network credentials.",
    meta
  };
}
