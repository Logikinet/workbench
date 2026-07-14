/**
 * Firstmate self-management service tests (Task 36).
 * Scoped under firstmate/ — no full suite.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { RoleService } from "../roles/roleService.js";
import { SkillService } from "../skills/skillService.js";
import { ToolRegistry } from "../tools/toolRegistry.js";
import { RuntimeAdapterRegistry } from "../runtime/registry.js";
import { StubRuntimeAdapter } from "../runtime/stubAdapter.js";
import {
  FirstmateSelfManagementService,
  isBuiltinFirstmate
} from "./firstmateSelfManagementService.js";
import { FIRSTMATE_BUILTIN_ROLE_ID } from "./firstmateTypes.js";
import { invokeFirstmateTool, listFirstmateToolSpecs } from "./firstmateTools.js";

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

const ordinaryRoleInput = {
  name: "实现者",
  responsibility: "在批准范围内实现与验证",
  systemInstruction: "先读上下文，再做最小修改。",
  harness: "api" as const,
  reasoningEffort: "high" as const,
  skills: ["implement", "tdd"],
  tools: ["filesystem", "shell"],
  permissions: {
    workspace: "project_only" as const,
    network: false,
    shell: true,
    externalSend: false
  },
  allowFirstmateAutoInvoke: true
};

describe("FirstmateSelfManagementService (Task 36)", () => {
  let root: string;
  let connections: ConnectionService;
  let roles: RoleService;
  let skills: SkillService;
  let tools: ToolRegistry;
  let runtimes: RuntimeAdapterRegistry;
  let service: FirstmateSelfManagementService;
  let vault: MemoryCredentialVault;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-firstmate-"));
    vault = new MemoryCredentialVault();
    connections = await ConnectionService.open(
      join(root, "connections.json"),
      vault,
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 })
    );
    roles = await RoleService.open(join(root, "roles.json"), connections);
    skills = await SkillService.createMemory();
    tools = await ToolRegistry.createMemory();
    runtimes = new RuntimeAdapterRegistry();
    runtimes.register(new StubRuntimeAdapter({ harness: "api", probeReady: true }));
    runtimes.register(new StubRuntimeAdapter({ harness: "codex-cli", probeReady: false, probeReason: "not logged in" }));

    service = new FirstmateSelfManagementService({
      roles,
      connections,
      skills,
      tools,
      runtimes
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exposes a machine-readable tool catalog with schemas", () => {
    const specs = listFirstmateToolSpecs();
    const names = specs.map((s) => s.name);
    expect(names).toContain("roles.list");
    expect(names).toContain("roles.create");
    expect(names).toContain("roles.update");
    expect(names).toContain("roles.remove");
    expect(names).toContain("agents.temporary.create");
    expect(names).toContain("runtimes.list");
    expect(names).toContain("connections.list");
    expect(names).toContain("skills.list");
    expect(names).toContain("tools.list");
    expect(names).toContain("projects.list");
    expect(names).toContain("runs.list");
    expect(names).toContain("queue.status");
    expect(names).toContain("audit.list");

    const create = specs.find((s) => s.name === "roles.create")!;
    expect(create.requiresUserRequest).toBe(true);
    expect(create.inputSchema).toMatchObject({ type: "object" });
    expect(JSON.stringify(create.inputSchema)).toContain("userRequested");
  });

  it("lists and gets roles with isBuiltinFirstmate flag", async () => {
    await roles.create(ordinaryRoleInput);
    // Simulate built-in by name
    const fm = await roles.create({
      ...ordinaryRoleInput,
      name: "Firstmate",
      responsibility: "编排",
      systemInstruction: "只编排不直接改正式文件",
      tools: [],
      skills: [],
      allowFirstmateAutoInvoke: false
    });

    const listed = await service.listRoles();
    expect(listed.some((r) => r.name === "实现者" && !r.isBuiltinFirstmate)).toBe(true);
    expect(listed.some((r) => r.id === fm.id && r.isBuiltinFirstmate)).toBe(true);
    expect(isBuiltinFirstmate({ id: FIRSTMATE_BUILTIN_ROLE_ID, name: "x" })).toBe(true);

    const got = await service.getRole(fm.id);
    expect(got.isBuiltinFirstmate).toBe(true);
  });

  it("rejects silent long-term Role create without userRequested", async () => {
    const result = await service.createRole({
      ...ordinaryRoleInput,
      userRequested: false
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("user_request_required");
    expect(result.needsUserRequest).toBe(true);
    expect(await roles.list()).toEqual([]);
    expect(service.listAudit()[0].result).toBe("rejected");
  });

  it("creates long-term Role when userRequested and audits the change", async () => {
    const result = await service.createRole({
      ...ordinaryRoleInput,
      userRequested: true,
      reason: "用户要求新增实现者角色",
      actor: "firstmate"
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ name: "实现者", harness: "api" });
    expect(result.auditId).toBeTruthy();

    const audit = service.getAudit(result.auditId!);
    expect(audit).toMatchObject({
      actor: "firstmate",
      tool: "roles.create",
      result: "ok",
      reason: "用户要求新增实现者角色"
    });
    expect(audit.after).toMatchObject({ name: "实现者" });
  });

  it("follows read → schema → patch → verify for role update", async () => {
    const role = await roles.create(ordinaryRoleInput);
    const schema = service.roleSchema();
    expect(schema.enums.harness).toEqual(["api", "codex-cli"]);
    expect(schema.notes.some((n) => n.includes("userRequested"))).toBe(true);

    const blocked = await service.updateRole({
      roleId: role.id,
      patch: { reasoningEffort: "low" },
      userRequested: false
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("user_request_required");

    const updated = await service.updateRole({
      roleId: role.id,
      patch: { reasoningEffort: "low", enabled: false },
      userRequested: true,
      reason: "用户降低推理并停用"
    });
    expect(updated.ok).toBe(true);
    const data = updated.data as {
      workflow: string[];
      before: { reasoningEffort: string; enabled: boolean };
      after: { reasoningEffort: string; enabled: boolean };
      diff: Record<string, { from: unknown; to: unknown }>;
      appliedPatch: Record<string, unknown>;
    };
    expect(data.workflow).toEqual(["read", "schema", "patch", "verify"]);
    expect(data.before.reasoningEffort).toBe("high");
    expect(data.after.reasoningEffort).toBe("low");
    expect(data.after.enabled).toBe(false);
    expect(data.diff.reasoningEffort).toEqual({ from: "high", to: "low" });
    expect(data.appliedPatch).toMatchObject({ reasoningEffort: "low", enabled: false });
  });

  it("refuses to delete built-in Firstmate and allows ordinary Role delete with user request", async () => {
    const ordinary = await roles.create(ordinaryRoleInput);
    const firstmate = await roles.create({
      ...ordinaryRoleInput,
      name: "Firstmate Chief",
      responsibility: "编排",
      systemInstruction: "只编排"
    });

    const blockedSilent = await service.removeRole({
      roleId: ordinary.id,
      userRequested: false
    });
    expect(blockedSilent.code).toBe("user_request_required");

    const protect = await service.removeRole({
      roleId: firstmate.id,
      userRequested: true,
      reason: "误删"
    });
    expect(protect.ok).toBe(false);
    expect(protect.code).toBe("builtin_protected");
    await expect(roles.get(firstmate.id)).resolves.toBeTruthy();

    const removed = await service.removeRole({
      roleId: ordinary.id,
      userRequested: true,
      reason: "用户删除实现者"
    });
    expect(removed.ok).toBe(true);
    await expect(roles.get(ordinary.id)).rejects.toThrow(/not found/i);
  });

  it("creates temporary agents with name, responsibility, avatar, runtime, skills, tools, permissions", () => {
    const result = service.createTemporaryAgent({
      name: "临时研究员",
      responsibility: "只读调研",
      avatar: { kind: "emoji", value: "🔬" },
      harness: "api",
      reasoningEffort: "medium",
      skills: ["research"],
      tools: ["filesystem", "web"],
      permissions: { workspace: "read_only", network: true, shell: false, externalSend: false },
      reason: "复杂计划需要调研实例"
    });
    expect(result.ok).toBe(true);
    const agent = result.data as {
      temporary: true;
      confirmedForLongTerm: false;
      avatar: { kind: string; value: string };
      harness: string;
      skills: string[];
      tools: string[];
      permissions: { workspace: string };
    };
    expect(agent.temporary).toBe(true);
    expect(agent.confirmedForLongTerm).toBe(false);
    expect(agent.avatar).toEqual({ kind: "emoji", value: "🔬" });
    expect(agent.harness).toBe("api");
    expect(agent.skills).toContain("research");
    expect(agent.tools).toEqual(expect.arrayContaining(["filesystem", "web"]));
    expect(agent.permissions.workspace).toBe("read_only");

    const listed = service.listTemporaryAgents();
    expect(listed).toHaveLength(1);
    expect(service.getTemporaryAgent(listed[0].id).name).toBe("临时研究员");

    const gone = service.removeTemporaryAgent(listed[0].id, { reason: "done" });
    expect(gone.ok).toBe(true);
    expect(service.listTemporaryAgents()).toEqual([]);
  });

  it("discovers runtimes, skills, tools without secrets on connections", async () => {
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "super-secret-key-xyz",
      modelId: "gpt-5",
      name: "Primary"
    });

    const runtimeList = await service.listRuntimes();
    expect(runtimeList.map((r) => r.harness).sort()).toEqual(["api", "codex-cli"]);
    expect(runtimeList.find((r) => r.harness === "api")?.ready).toBe(true);
    expect(runtimeList.find((r) => r.harness === "codex-cli")?.ready).toBe(false);

    const connList = await service.listConnections();
    expect(connList).toHaveLength(1);
    expect(connList[0]).toMatchObject({
      id: connection.id,
      credentialPresent: true,
      modelId: "gpt-5"
    });
    const serialized = JSON.stringify(connList);
    expect(serialized).not.toContain("super-secret-key-xyz");
    expect(serialized).not.toContain("credentialRef");
    expect(serialized).not.toContain("apiKey");

    const skillList = service.listSkills();
    expect(skillList.some((s) => s.id === "implement")).toBe(true);

    const toolList = service.listTools();
    expect(toolList.some((t) => t.id === "filesystem")).toBe(true);
  });

  it("returns unavailable for missing optional discovery clients", async () => {
    const bare = new FirstmateSelfManagementService({ roles });
    expect(bare.listSkills()).toEqual([]);
    expect(bare.listTools()).toEqual([]);
    expect(await bare.listConnections()).toEqual([]);
    expect(await bare.listProjects()).toEqual([]);
    expect(await bare.listRuns()).toEqual([]);
    await expect(bare.queueStatus()).rejects.toThrow(/not configured/i);
  });

  it("invokeFirstmateTool routes catalog tools and rejects unknown names", async () => {
    await roles.create(ordinaryRoleInput);

    const listed = await invokeFirstmateTool(service, "roles.list", {});
    expect(listed.ok).toBe(true);
    expect((listed.data as { roles: unknown[] }).roles.length).toBe(1);

    const schema = await invokeFirstmateTool(service, "roles.schema", {});
    expect(schema.ok).toBe(true);
    expect((schema.data as { enums: { harness: string[] } }).enums.harness).toContain("api");

    const unknown = await invokeFirstmateTool(service, "roles.explode", {});
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe("not_found");
  });

  it("never returns secrets in audit payloads after connection-related flows", async () => {
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-secret-should-not-leak",
      modelId: "gpt-5"
    });
    const roleResult = await service.createRole({
      ...ordinaryRoleInput,
      connectionId: connection.id,
      modelId: "gpt-5",
      userRequested: true,
      reason: "bind connection with apiKey: sk-secret-should-not-leak"
    });
    expect(roleResult.ok).toBe(true);
    const audit = service.listAudit();
    const blob = JSON.stringify(audit);
    expect(blob).not.toContain("sk-secret-should-not-leak");
    // reason is redacted for secret-looking tokens
    expect(audit[0].reason).not.toContain("sk-secret-should-not-leak");
  });
});
