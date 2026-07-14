import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import type { CreateRoleInput } from "../roles/roleService.js";
import { RoleService } from "../roles/roleService.js";
import { DeterministicRoutingService } from "./deterministicRoutingService.js";
import { RoleRouterService } from "./roleRouterService.js";

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

describe("DeterministicRoutingService (Task 38)", () => {
  let root: string;
  let connections: ConnectionService;
  let roles: RoleService;
  let roleRouter: RoleRouterService;
  let router: DeterministicRoutingService;
  let connectionId: string;

  const baseRole = (overrides: Partial<CreateRoleInput> & { name: string }): CreateRoleInput => ({
    name: overrides.name,
    responsibility: overrides.responsibility ?? "duty",
    systemInstruction: overrides.systemInstruction ?? "base instruction",
    harness: overrides.harness ?? "api",
    reasoningEffort: overrides.reasoningEffort ?? "medium",
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
    root = await mkdtemp(join(tmpdir(), "paw-det-routing-"));
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 })
    );
    connections = await ConnectionService.open(
      join(root, "connections.json"),
      new MemoryCredentialVault(),
      fetchImpl
    );
    roles = await RoleService.open(join(root, "roles.json"), connections);
    roleRouter = new RoleRouterService({ roles, connections });
    router = new DeterministicRoutingService({ roles, roleRouter });

    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "gpt-5"
    });
    connectionId = connection.id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("honors rule order: first valid rule wins; later rules are recorded not selected", async () => {
    const research = await roles.create(
      baseRole({
        name: "调研专员",
        connectionId,
        modelId: "gpt-5",
        skills: ["research", "documents"],
        tools: ["filesystem", "web"],
        permissions: { workspace: "read_only", network: true, shell: false, externalSend: false }
      })
    );
    const impl = await roles.create(
      baseRole({
        name: "实现者",
        connectionId,
        modelId: "gpt-5",
        skills: ["implement", "tdd"],
        tools: ["filesystem", "shell"]
      })
    );

    router.upsertRule({
      name: "research-rule",
      order: 10,
      roleId: research.id,
      match: { taskTypes: ["research"], requiredCapabilities: ["research"] }
    });
    router.upsertRule({
      name: "impl-rule",
      order: 20,
      roleId: impl.id,
      match: { taskTypes: ["research"], requiredCapabilities: ["research"] }
    });

    const decision = await router.route({
      taskType: "research",
      requiredCapabilities: ["research", "documents"],
      projectId: "proj-docs",
      complexity: "low",
      planApproved: true,
      verifyAvailability: true,
      sessionScope: { kind: "project_firstmate", projectId: "proj-docs" }
    });

    expect(decision.selectionTrace.mode).toBe("rule");
    expect(decision.selectionTrace.matchedRuleName).toBe("research-rule");
    expect(decision.instances[0]?.selection?.roleId).toBe(research.id);
    expect(decision.selectionTrace.ruleEvaluations[0]?.selected).toBe(true);
    expect(decision.selectionTrace.ruleEvaluations[1]?.selected).toBe(false);
    expect(decision.selectionTrace.finalReason).toMatch(/research-rule|调研/);
    expect(decision.sessionKey).toBe("scope:project_firstmate:project:proj-docs");
  });

  it("falls back to auto-rank when no rule matches, with explainable fallback", async () => {
    const impl = await roles.create(
      baseRole({
        name: "实现者",
        connectionId,
        modelId: "gpt-5"
      })
    );
    router.upsertRule({
      name: "only-automation",
      order: 1,
      roleId: impl.id,
      match: { taskTypes: ["automation"], harness: "codex-cli" }
    });

    const decision = await router.route({
      taskType: "implementation",
      requiredCapabilities: ["filesystem", "tests"],
      preferredHarness: "api",
      complexity: "low",
      planApproved: true,
      verifyAvailability: true
    });

    expect(decision.selectionTrace.mode).toBe("auto_rank");
    expect(decision.selectionTrace.fallbackCode).toBe("none_matched");
    expect(decision.selectionTrace.fallbackReason).toMatch(/fallback|自动/i);
    expect(decision.instances[0]?.selection?.roleId).toBe(impl.id);
    expect(decision.selectionTrace.rejectReasons.length).toBeGreaterThan(0);
  });

  it("manual override outranks rules unless permission/unavailable — then pauses without fallback", async () => {
    const auto = await roles.create(
      baseRole({
        name: "自动强匹配",
        connectionId,
        modelId: "gpt-5",
        skills: ["implement", "tdd"],
        tools: ["filesystem", "shell"]
      })
    );
    const manual = await roles.create(
      baseRole({
        name: "用户指定",
        connectionId,
        modelId: "gpt-5",
        skills: ["research"],
        tools: ["filesystem"],
        permissions: { workspace: "read_only", network: false, shell: false, externalSend: false },
        allowFirstmateAutoInvoke: false
      })
    );

    router.upsertRule({
      name: "would-pick-auto",
      order: 1,
      roleId: auto.id,
      match: { requiredCapabilities: ["filesystem"] }
    });

    const honored = await router.route({
      explicitRoleId: manual.id,
      requiredCapabilities: ["filesystem"],
      complexity: "low",
      planApproved: true,
      verifyAvailability: true
    });
    expect(honored.selectionTrace.mode).toBe("manual");
    expect(honored.instances[0]?.selection?.roleId).toBe(manual.id);
    expect(honored.selectionTrace.ruleEvaluations.every((e) => !e.selected)).toBe(true);
    expect(honored.selectionTrace.finalReason).toMatch(/手动|明确|用户/);

    // Permission violation: need shell but manual role has no shell.
    const paused = await router.route({
      explicitRoleId: manual.id,
      requiredCapabilities: ["filesystem", "shell"],
      requiredTools: ["shell"],
      requiredPermissions: { shell: true, workspace: "project_only" },
      complexity: "low",
      planApproved: true,
      verifyAvailability: true,
      enforceManualPermissions: true
    });
    expect(paused.selectionTrace.mode).toBe("paused");
    expect(paused.instances[0]?.status).toBe("paused");
    expect(paused.instances[0]?.selection).toBeUndefined();
    expect(paused.selectionTrace.finalReason).toMatch(/权限|暂停/);
    // Must NOT fall through to the auto rule.
    expect(paused.instances[0]?.selection?.roleId).not.toBe(auto.id);
  });

  it("supports session tags, preferred model, temporary instructions without mutating Role", async () => {
    const role = await roles.create(
      baseRole({
        name: "角色库模型",
        connectionId,
        modelId: "gpt-5",
        systemInstruction: "GLOBAL ROLE INSTRUCTION"
      })
    );
    const before = await roles.get(role.id);

    const decision = await router.route({
      explicitRoleId: role.id,
      complexity: "low",
      planApproved: true,
      verifyAvailability: true,
      sessionLocal: {
        tags: ["hotfix", "customer-a"],
        preferredModelId: "gpt-session-only",
        temporaryInstructions: "本会话只用中文回复"
      },
      sessionScope: { kind: "run", runId: "run-42", projectId: "p1" }
    });

    expect(decision.sessionLocal.tags).toEqual(["hotfix", "customer-a"]);
    expect(decision.sessionLocal.preferredModelId).toBe("gpt-session-only");
    expect(decision.sessionLocal.temporaryInstructions).toBe("本会话只用中文回复");
    expect(decision.instances[0]?.status).toBe("user_specified");
    // Session preferred model overlays the selection view only — Role stays gpt-5.
    expect(decision.instances[0]?.selection?.modelId).toBe("gpt-session-only");
    expect(decision.instances[0]?.selection?.systemInstruction).toMatch(/会话临时指令/);
    expect(decision.instances[0]?.selection?.systemInstruction).toMatch(/中文/);
    expect(decision.sessionKey).toMatch(/^scope:run:run:run-42/);

    const after = await roles.get(role.id);
    expect(after.modelId).toBe("gpt-5");
    expect(after.modelId).toBe(before.modelId);
    expect(after.systemInstruction).toBe(before.systemInstruction);
    expect(after.systemInstruction).not.toMatch(/临时指令/);
  });

  it("enforces cross-session isolation: reviewer / projects / client profiles do not leak", async () => {
    const projectA = { kind: "project_firstmate" as const, projectId: "alpha" };
    const projectB = { kind: "project_firstmate" as const, projectId: "beta" };
    expect(router.canShareContext(projectA, projectB).allowed).toBe(false);
    expect(() => router.assertNoCrossLeak(projectA, projectB)).toThrow(/Project/);

    const run = { kind: "run" as const, runId: "r1", projectId: "alpha" };
    const reviewer = { kind: "reviewer" as const, runId: "r1", projectId: "alpha" };
    const share = router.canShareContext(run, reviewer);
    expect(share.allowed).toBe(true);
    expect(share.allowedLayers).not.toContain("role_experience");

    const filtered = router.filterContextForScope(reviewer, {
      project_facts: ["ok"],
      role_experience: ["private"],
      privateMemory: "nope",
      sharedEvidence: ["ev"]
    });
    expect(filtered.role_experience).toBeUndefined();
    expect(filtered.privateMemory).toBeUndefined();
    expect(filtered.project_facts).toEqual(["ok"]);

    const clientA = {
      kind: "run" as const,
      runId: "r9",
      projectId: "p",
      clientProfileId: "cust-1"
    };
    const clientB = {
      kind: "run" as const,
      runId: "r9",
      projectId: "p",
      clientProfileId: "cust-2"
    };
    expect(router.canShareContext(clientA, clientB).allowed).toBe(false);

    const subA = { kind: "subtask" as const, runId: "r1", subtaskId: "s1", projectId: "p" };
    const subB = { kind: "subtask" as const, runId: "r1", subtaskId: "s2", projectId: "p" };
    expect(router.canShareContext(subA, subB).allowed).toBe(false);
  });

  it("persists matched rule, candidates, reject reasons, and final reason on the decision", async () => {
    const impl = await roles.create(
      baseRole({ name: "实现", connectionId, modelId: "gpt-5" })
    );
    const other = await roles.create(
      baseRole({
        name: "不可自动",
        connectionId,
        modelId: "gpt-5",
        allowFirstmateAutoInvoke: false
      })
    );
    void other;

    const rule = router.upsertRule({
      name: "impl-by-project",
      order: 5,
      roleId: impl.id,
      match: { projectIds: ["ship"], requiredCapabilities: ["filesystem"] }
    });

    const decision = await router.route({
      projectId: "ship",
      requiredCapabilities: ["filesystem", "tests"],
      complexity: "low",
      planApproved: true,
      verifyAvailability: true,
      sessionScope: { kind: "run", runId: "run-ship", projectId: "ship" }
    });

    expect(decision.selectionTrace.matchedRuleId).toBe(rule.id);
    expect(decision.selectionTrace.candidateRoleIds.length).toBeGreaterThan(0);
    expect(decision.selectionTrace.finalReason.length).toBeGreaterThan(0);
    expect(decision.selectionTrace.ruleEvaluations.some((e) => e.selected)).toBe(true);

    const loaded = router.getDecision(decision.id);
    expect(loaded.selectionTrace.matchedRuleId).toBe(rule.id);
    expect(loaded.sessionScope?.kind).toBe("run");
  });
});
