/**
 * Firstmate self-management HTTP routes (Task 36).
 * Uses createFirstmateRouteApp — does not edit app.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { RoleService } from "../roles/roleService.js";
import { SkillService } from "../skills/skillService.js";
import { ToolRegistry } from "../tools/toolRegistry.js";
import { RuntimeAdapterRegistry } from "../runtime/registry.js";
import { StubRuntimeAdapter } from "../runtime/stubAdapter.js";
import { createFirstmateRouteApp } from "./firstmateRoutes.js";
import { FirstmateSelfManagementService } from "./firstmateSelfManagementService.js";

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

const roleBody = {
  name: "实现者",
  responsibility: "实现",
  systemInstruction: "最小改动",
  harness: "api" as const,
  reasoningEffort: "medium" as const,
  skills: ["implement"],
  tools: ["filesystem"],
  permissions: {
    workspace: "project_only" as const,
    network: false,
    shell: false,
    externalSend: false
  },
  allowFirstmateAutoInvoke: true
};

describe("firstmate routes (Task 36)", () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createFirstmateRouteApp>>;
  let roles: RoleService;
  let firstmate: FirstmateSelfManagementService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-firstmate-http-"));
    const vault = new MemoryCredentialVault();
    const connections = await ConnectionService.open(
      join(root, "connections.json"),
      vault,
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 })
    );
    roles = await RoleService.open(join(root, "roles.json"), connections);
    const skills = await SkillService.createMemory();
    const tools = await ToolRegistry.createMemory();
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register(new StubRuntimeAdapter({ harness: "api", probeReady: true }));

    // Seed a built-in-named Firstmate role for delete protection tests.
    await roles.create({
      ...roleBody,
      name: "Firstmate",
      responsibility: "编排",
      systemInstruction: "只编排",
      skills: [],
      tools: [],
      allowFirstmateAutoInvoke: false
    });

    await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "route-secret-key",
      modelId: "gpt-5",
      name: "RouteConn"
    });

    firstmate = new FirstmateSelfManagementService({
      roles,
      connections,
      skills,
      tools,
      runtimes,
      // queue/projects/runs omitted → empty or 503 where required
    });
    app = await createFirstmateRouteApp({ firstmate });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("GET /api/firstmate/tools returns catalog with mutation workflow notes", async () => {
    const res = await request(app).get("/api/firstmate/tools").expect(200);
    expect(res.body.tools.length).toBeGreaterThan(10);
    expect(res.body.mutationWorkflow).toEqual(["read", "schema", "patch", "verify"]);
    expect(res.body.notes.some((n: string) => /Firstmate/i.test(n))).toBe(true);
  });

  it("POST invoke creates role only with userRequested and lists via REST", async () => {
    const denied = await request(app)
      .post("/api/firstmate/tools/roles.create/invoke")
      .send({ ...roleBody, name: "拒绝创建", userRequested: false })
      .expect(403);
    expect(denied.body.ok).toBe(false);
    expect(denied.body.code).toBe("user_request_required");

    const created = await request(app)
      .post("/api/firstmate/tools/roles.create/invoke")
      .send({ ...roleBody, name: "工具创建", userRequested: true, reason: "用户请求" })
      .expect(200);
    expect(created.body.ok).toBe(true);

    const listed = await request(app).get("/api/firstmate/roles").expect(200);
    expect(listed.body.roles.some((r: { name: string }) => r.name === "工具创建")).toBe(true);

    const schema = await request(app).get("/api/firstmate/roles/schema").expect(200);
    expect(schema.body.enums.harness).toContain("api");
  });

  it("PATCH role uses patch cycle and DELETE protects Firstmate", async () => {
    const created = await request(app)
      .post("/api/firstmate/roles")
      .send({ ...roleBody, name: "可删", userRequested: true, reason: "创建" })
      .expect(201);
    const roleId = created.body.data.id as string;

    const patched = await request(app)
      .patch(`/api/firstmate/roles/${roleId}`)
      .send({ patch: { reasoningEffort: "low" }, userRequested: true, reason: "降级" })
      .expect(200);
    expect(patched.body.data.workflow).toEqual(["read", "schema", "patch", "verify"]);
    expect(patched.body.data.after.reasoningEffort).toBe("low");

    const firstmateRole = (await roles.list()).find((r) => /firstmate/i.test(r.name))!;
    const protect = await request(app)
      .delete(`/api/firstmate/roles/${firstmateRole.id}`)
      .send({ userRequested: true, reason: "误删" })
      .expect(403);
    expect(protect.body.code).toBe("builtin_protected");

    await request(app)
      .delete(`/api/firstmate/roles/${roleId}`)
      .send({ userRequested: true, reason: "清理" })
      .expect(200);
  });

  it("temporary agent CRUD via HTTP supports avatar and runtime", async () => {
    const created = await request(app)
      .post("/api/firstmate/temporary-agents")
      .send({
        name: "临时代码手",
        responsibility: "写测试",
        avatar: { kind: "color", value: "#3366ff" },
        harness: "codex-cli",
        skills: ["tdd"],
        tools: ["filesystem", "shell"],
        permissions: { workspace: "project_only", network: false, shell: true, externalSend: false }
      })
      .expect(201);
    expect(created.body.ok).toBe(true);
    expect(created.body.data.avatar).toEqual({ kind: "color", value: "#3366ff" });
    expect(created.body.data.harness).toBe("codex-cli");
    expect(created.body.data.temporary).toBe(true);

    const id = created.body.data.id as string;
    const got = await request(app).get(`/api/firstmate/temporary-agents/${id}`).expect(200);
    expect(got.body.name).toBe("临时代码手");

    const list = await request(app).get("/api/firstmate/temporary-agents").expect(200);
    expect(list.body.temporaryAgents).toHaveLength(1);

    await request(app).delete(`/api/firstmate/temporary-agents/${id}`).expect(200);
    await request(app).get(`/api/firstmate/temporary-agents/${id}`).expect(404);
  });

  it("discovery endpoints return runtimes, connections without secrets, skills, tools", async () => {
    const runtimes = await request(app).get("/api/firstmate/runtimes").expect(200);
    expect(runtimes.body.runtimes.some((r: { harness: string }) => r.harness === "api")).toBe(true);

    const conns = await request(app).get("/api/firstmate/connections").expect(200);
    expect(conns.body.connections[0].credentialPresent).toBe(true);
    expect(JSON.stringify(conns.body)).not.toContain("route-secret-key");
    expect(JSON.stringify(conns.body)).not.toContain("credentialRef");

    const skills = await request(app).get("/api/firstmate/skills").expect(200);
    expect(skills.body.skills.length).toBeGreaterThan(0);

    const tools = await request(app).get("/api/firstmate/tools-catalog").expect(200);
    expect(tools.body.tools.some((t: { id: string }) => t.id === "filesystem")).toBe(true);

    await request(app).get("/api/firstmate/queue").expect(503);
  });

  it("audit timeline is readable after management ops", async () => {
    await request(app)
      .post("/api/firstmate/roles")
      .send({ ...roleBody, name: "审计角色", userRequested: true, reason: "for audit" })
      .expect(201);

    const audit = await request(app).get("/api/firstmate/audit").expect(200);
    expect(audit.body.audit.length).toBeGreaterThan(0);
    expect(audit.body.audit[0]).toMatchObject({
      tool: "roles.create",
      result: "ok",
      reason: "for audit"
    });

    const id = audit.body.audit[0].id as string;
    const one = await request(app).get(`/api/firstmate/audit/${id}`).expect(200);
    expect(one.body.id).toBe(id);
  });
});
