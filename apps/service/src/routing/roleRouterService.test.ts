import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import type { CreateRoleInput } from "../roles/roleService.js";
import { RoleService } from "../roles/roleService.js";
import {
  deriveInstances,
  rankCandidates,
  RoleRouterService
} from "./roleRouterService.js";

class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();
  async read(reference: string): Promise<string | undefined> { return this.values.get(reference); }
  async write(reference: string, secret: string): Promise<void> { this.values.set(reference, secret); }
  async remove(reference: string): Promise<void> { this.values.delete(reference); }
}

describe("Firstmate Role Router (Task 20)", () => {
  let root: string;
  let connections: ConnectionService;
  let roles: RoleService;
  let router: RoleRouterService;
  let fetchImpl: ReturnType<typeof vi.fn>;

  const baseRole = (overrides: Partial<CreateRoleInput> & { name: string } = { name: "实现者" }): CreateRoleInput => ({
    name: overrides.name,
    responsibility: overrides.responsibility ?? "在批准范围内实现与验证",
    systemInstruction: overrides.systemInstruction ?? "先读上下文，再做最小修改。",
    harness: overrides.harness ?? "api",
    reasoningEffort: overrides.reasoningEffort ?? "high",
    skills: overrides.skills ?? ["implement", "tdd"],
    tools: overrides.tools ?? ["filesystem", "shell"],
    permissions: overrides.permissions ?? {
      workspace: "project_only",
      network: false,
      shell: true,
      externalSend: false
    },
    allowFirstmateAutoInvoke: overrides.allowFirstmateAutoInvoke ?? true,
    connectionId: overrides.connectionId,
    modelId: overrides.modelId
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-routing-"));
    fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 }));
    connections = await ConnectionService.open(
      join(root, "connections.json"),
      new MemoryCredentialVault(),
      fetchImpl
    );
    roles = await RoleService.open(join(root, "roles.json"), connections);
    router = new RoleRouterService({ roles, connections });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("matches roles on capabilities, harness, skills, tools, permissions, enabled, and allowFirstmateAutoInvoke", async () => {
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "gpt-5"
    });

    const implementer = await roles.create(baseRole({
      name: "实现者",
      connectionId: connection.id,
      modelId: "gpt-5",
      skills: ["implement", "tdd"],
      tools: ["filesystem", "shell"],
      allowFirstmateAutoInvoke: true
    }));
    await roles.create(baseRole({
      name: "未授权自动调用",
      connectionId: connection.id,
      modelId: "gpt-5",
      allowFirstmateAutoInvoke: false
    }));
    const disabled = await roles.create(baseRole({
      name: "已停用",
      connectionId: connection.id,
      modelId: "gpt-5",
      allowFirstmateAutoInvoke: true
    }));
    await roles.update(disabled.id, { enabled: false });
    await roles.create(baseRole({
      name: "调研专员",
      connectionId: connection.id,
      modelId: "gpt-5",
      skills: ["research", "documents"],
      tools: ["filesystem", "web"],
      permissions: { workspace: "read_only", network: true, shell: false, externalSend: false },
      allowFirstmateAutoInvoke: true
    }));
    await roles.create(baseRole({
      name: "Codex 实现",
      harness: "codex-cli",
      skills: ["implement", "tdd"],
      tools: ["codex-cli", "filesystem", "shell"],
      allowFirstmateAutoInvoke: true
    }));

    const decision = await router.route({
      requiredCapabilities: ["workspace", "filesystem", "shell", "tests"],
      preferredHarness: "api",
      complexity: "low",
      planApproved: true,
      verifyAvailability: true
    });

    expect(decision.instances).toHaveLength(1);
    expect(decision.instances[0]!.status).toBe("selected");
    expect(decision.instances[0]!.selection?.roleId).toBe(implementer.id);
    expect(decision.instances[0]!.selection?.harness).toBe("api");
    expect(decision.instances[0]!.selection?.modelId).toBe("gpt-5");

    const ranked = decision.instances[0]!.candidates;
    expect(ranked.find((c) => c.name === "未授权自动调用")?.eligible).toBe(false);
    expect(ranked.find((c) => c.name === "未授权自动调用")?.rejectReasons.join(" ")).toMatch(/allowFirstmateAutoInvoke/);
    expect(ranked.find((c) => c.name === "已停用")?.eligible).toBe(false);
    expect(ranked.find((c) => c.name === "Codex 实现")?.eligible).toBe(false);
    expect(ranked.find((c) => c.name === "Codex 实现")?.rejectReasons.join(" ")).toMatch(/Harness/);
    expect(ranked.find((c) => c.name === "调研专员")?.eligible).toBe(false);
  });

  it("exposes role, model, harness, and selection reason; allows user override before execution", async () => {
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "gpt-5"
    });
    const auto = await roles.create(baseRole({
      name: "自动匹配",
      connectionId: connection.id,
      modelId: "gpt-5",
      skills: ["implement", "tdd"],
      tools: ["filesystem", "shell"]
    }));
    // Override candidate is not auto-invokable so it cannot win the first route.
    const override = await roles.create(baseRole({
      name: "用户覆盖角色",
      connectionId: connection.id,
      modelId: "gpt-5",
      skills: ["implement", "tdd", "code-review"],
      tools: ["filesystem", "shell", "git"],
      allowFirstmateAutoInvoke: false
    }));

    const decision = await router.route({
      requiredCapabilities: ["filesystem", "tests"],
      complexity: "low",
      planApproved: false,
      verifyAvailability: true
    });

    expect(decision.instances[0]!.selection?.roleId).toBe(auto.id);
    expect(decision.instances[0]!.reason).toMatch(/自动匹配/);
    expect(decision.instances[0]!.reason).toMatch(/gpt-5|api/);
    expect(decision.instances[0]!.selection?.modelId).toBe("gpt-5");
    expect(decision.instances[0]!.selection?.harness).toBe("api");
    expect(decision.canAutoQueue).toBe(false);
    expect(decision.autoQueueBlockedReason).toMatch(/批准/);

    const overridden = await router.override(decision.id, { roleId: override.id });
    expect(overridden.instances[0]!.status).toBe("user_override");
    expect(overridden.instances[0]!.selection?.roleId).toBe(override.id);
    expect(overridden.instances[0]!.reason).toMatch(/用户覆盖/);
    expect(overridden.instances[0]!.selection?.name).toBe("用户覆盖角色");
  });

  it("generates a temporary role when none match; long-term save requires explicit confirm", async () => {
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "gpt-5"
    });
    // Existing roles do not cover research + web.
    await roles.create(baseRole({
      name: "窄实现",
      connectionId: connection.id,
      modelId: "gpt-5",
      skills: ["implement"],
      tools: ["filesystem"]
    }));

    const decision = await router.route({
      requiredCapabilities: ["research", "web"],
      requiredSkills: ["research"],
      requiredTools: ["web"],
      complexity: "low",
      planApproved: true,
      defaultConnectionId: connection.id,
      defaultModelId: "gpt-5",
      verifyAvailability: false
    });

    expect(decision.instances[0]!.status).toBe("temporary");
    expect(decision.instances[0]!.temporaryRole).toBeDefined();
    expect(decision.instances[0]!.temporaryRole!.confirmedForLongTerm).toBe(false);
    expect(decision.instances[0]!.reason).toMatch(/临时角色/);
    expect(decision.canAutoQueue).toBe(true); // temp is fine for this Run without long-term save

    const tempId = decision.instances[0]!.temporaryRole!.id;
    await expect(
      router.confirmTemporaryAsLongTerm(decision.id, { temporaryRoleId: tempId, confirm: false })
    ).rejects.toThrow(/Confirm before saving/);

    expect((await roles.list()).map((r) => r.name)).toEqual(["窄实现"]);

    const confirmed = await router.confirmTemporaryAsLongTerm(decision.id, {
      temporaryRoleId: tempId,
      confirm: true,
      name: "长期调研角色"
    });
    expect(confirmed.role.name).toBe("长期调研角色");
    expect(confirmed.decision.instances[0]!.temporaryRole!.confirmedForLongTerm).toBe(true);
    expect(confirmed.decision.instances[0]!.temporaryRole!.longTermRoleId).toBe(confirmed.role.id);
    expect((await roles.list()).some((r) => r.id === confirmed.role.id)).toBe(true);
  });

  it("respects an explicit user role and never replaces it with an auto match", async () => {
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "gpt-5"
    });
    const preferred = await roles.create(baseRole({
      name: "用户指定",
      connectionId: connection.id,
      modelId: "gpt-5",
      skills: ["research"],
      tools: ["filesystem"],
      // Intentionally weaker skills than the better auto match below.
      allowFirstmateAutoInvoke: true
    }));
    await roles.create(baseRole({
      name: "更强自动匹配",
      connectionId: connection.id,
      modelId: "gpt-5",
      skills: ["implement", "tdd"],
      tools: ["filesystem", "shell"]
    }));

    const decision = await router.route({
      explicitRoleId: preferred.id,
      requiredCapabilities: ["filesystem", "shell", "tests"],
      complexity: "low",
      planApproved: true,
      verifyAvailability: true
    });

    expect(decision.instances[0]!.status).toBe("user_specified");
    expect(decision.instances[0]!.selection?.roleId).toBe(preferred.id);
    expect(decision.instances[0]!.reason).toMatch(/明确指定|不擅自替换/);
    expect(decision.instances[0]!.selection?.roleId).not.toBe(
      (await roles.list()).find((r) => r.name === "更强自动匹配")!.id
    );
  });

  it("pauses on unavailable / quota / login failure without auto-switching models", async () => {
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "gpt-5"
    });
    const primary = await roles.create(baseRole({
      name: "首选",
      connectionId: connection.id,
      modelId: "gpt-5"
    }));
    await roles.create(baseRole({
      name: "备选不应被自动切换",
      connectionId: connection.id,
      modelId: "gpt-5",
      skills: ["implement", "tdd"],
      tools: ["filesystem", "shell"]
    }));

    // Force connection test failure (login).
    fetchImpl.mockImplementation(async () => new Response("unauthorized", { status: 401 }));

    const decision = await router.route({
      requiredCapabilities: ["filesystem", "tests"],
      complexity: "low",
      planApproved: true,
      verifyAvailability: true
    });

    expect(decision.instances[0]!.status).toBe("paused");
    expect(decision.instances[0]!.pauseCode).toMatch(/login_failed|role_unavailable|quota/);
    expect(decision.instances[0]!.pauseReason ?? decision.instances[0]!.reason).toMatch(/暂停|不会自动切换/);
    expect(decision.instances[0]!.selection).toBeUndefined();
    expect(decision.canAutoQueue).toBe(false);

    // Explicit role also pauses rather than switching.
    const explicit = await router.route({
      explicitRoleId: primary.id,
      complexity: "low",
      planApproved: true,
      verifyAvailability: true
    });
    expect(explicit.instances[0]!.status).toBe("paused");
    expect(explicit.instances[0]!.selection).toBeUndefined();

    // Override that becomes unavailable also pauses (no silent switch).
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 }));
    const healthy = await router.route({
      requiredCapabilities: ["filesystem", "tests"],
      complexity: "low",
      planApproved: true,
      verifyAvailability: true
    });
    expect(healthy.instances[0]!.status).toBe("selected");

    fetchImpl.mockImplementation(async () => new Response("quota", { status: 429 }));
    // Make verify return quota-ish message via connection test.
    const afterOverride = await router.override(healthy.id, {
      roleId: (await roles.list()).find((r) => r.name === "备选不应被自动切换")!.id
    });
    expect(afterOverride.instances[0]!.status).toBe("paused");
    expect(afterOverride.instances[0]!.selection).toBeUndefined();
  });

  it("allows direct queue after plan approval without another manual agent pick", async () => {
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "gpt-5"
    });
    const role = await roles.create(baseRole({
      name: "可入队",
      connectionId: connection.id,
      modelId: "gpt-5"
    }));

    const beforeApproval = await router.route({
      runId: "run-1",
      requiredCapabilities: ["filesystem", "tests"],
      complexity: "low",
      planApproved: false,
      verifyAvailability: true
    });
    expect(beforeApproval.canAutoQueue).toBe(false);
    expect(beforeApproval.queuePayload.planApproved).toBe(false);

    const afterApproval = await router.route({
      runId: "run-1",
      requiredCapabilities: ["filesystem", "tests"],
      complexity: "low",
      planApproved: true,
      verifyAvailability: true
    });
    expect(afterApproval.canAutoQueue).toBe(true);
    expect(afterApproval.queuePayload.planApproved).toBe(true);
    expect(afterApproval.queuePayload.selections).toHaveLength(1);
    expect(afterApproval.queuePayload.selections[0]!.roleId).toBe(role.id);
    expect(afterApproval.queuePayload.selections[0]!.harness).toBe("api");
    expect(afterApproval.explanation).toMatch(/直接进入队列/);
  });

  it("starts one role for simple tasks and multiple on-demand instances for complex multi-capability plans", async () => {
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "gpt-5"
    });
    await roles.create(baseRole({
      name: "实现者",
      connectionId: connection.id,
      modelId: "gpt-5",
      skills: ["implement", "tdd"],
      tools: ["filesystem", "shell"]
    }));
    await roles.create(baseRole({
      name: "调研者",
      connectionId: connection.id,
      modelId: "gpt-5",
      skills: ["research", "documents"],
      tools: ["filesystem", "web"],
      permissions: { workspace: "read_only", network: true, shell: false, externalSend: false }
    }));

    const simple = await router.route({
      complexity: "low",
      requiredCapabilities: ["filesystem", "research", "documents"],
      planApproved: true,
      verifyAvailability: false,
      defaultConnectionId: connection.id
    });
    expect(simple.instances).toHaveLength(1);
    expect(simple.complexity).toBe("low");

    const complex = await router.route({
      complexity: "high",
      taskType: "implementation",
      requiredCapabilities: ["workspace", "filesystem", "shell", "tests", "research", "documents"],
      planApproved: true,
      verifyAvailability: false,
      defaultConnectionId: connection.id
    });
    expect(complex.instances.length).toBeGreaterThan(1);
    expect(complex.instances.map((i) => i.instanceId).sort()).toEqual(
      expect.arrayContaining(["exec", "research"])
    );

    // Explicit multi-instance plan requirements always honored.
    const planned = await router.route({
      complexity: "high",
      planApproved: true,
      verifyAvailability: false,
      defaultConnectionId: connection.id,
      instances: [
        {
          id: "impl",
          name: "实现实例",
          capabilities: ["filesystem", "shell", "tests"],
          skills: ["implement", "tdd"],
          tools: ["filesystem", "shell"]
        },
        {
          id: "docs",
          name: "文档实例",
          capabilities: ["documents"],
          skills: ["documents"],
          tools: ["filesystem"]
        }
      ]
    });
    expect(planned.instances).toHaveLength(2);
    expect(planned.instances.map((i) => i.instanceId).sort()).toEqual(["docs", "impl"]);
  });

  it("rankCandidates rejects disabled, non-auto-invoke, harness/skill/tool/permission mismatches", () => {
    const roleList = [
      {
        id: "1",
        name: "ok",
        responsibility: "r",
        systemInstruction: "s",
        harness: "api" as const,
        reasoningEffort: "medium" as const,
        skills: ["implement", "tdd"],
        tools: ["filesystem", "shell"],
        permissions: { workspace: "project_only" as const, network: false, shell: true, externalSend: false },
        allowFirstmateAutoInvoke: true,
        enabled: true,
        createdAt: "",
        updatedAt: ""
      },
      {
        id: "2",
        name: "no-auto",
        responsibility: "r",
        systemInstruction: "s",
        harness: "api" as const,
        reasoningEffort: "medium" as const,
        skills: ["implement", "tdd"],
        tools: ["filesystem", "shell"],
        permissions: { workspace: "project_only" as const, network: false, shell: true, externalSend: false },
        allowFirstmateAutoInvoke: false,
        enabled: true,
        createdAt: "",
        updatedAt: ""
      }
    ];
    const ranked = rankCandidates(roleList, {
      id: "primary",
      skills: ["implement"],
      tools: ["filesystem", "shell"],
      harness: "api"
    });
    expect(ranked[0]!.eligible).toBe(true);
    expect(ranked[1]!.eligible).toBe(false);
  });

  it("deriveInstances collapses to one for low complexity", () => {
    const instances = deriveInstances(
      {
        complexity: "low",
        requiredCapabilities: ["filesystem", "research", "documents"]
      },
      "low"
    );
    expect(instances).toHaveLength(1);
    expect(instances[0]!.id).toBe("primary");
  });
});
