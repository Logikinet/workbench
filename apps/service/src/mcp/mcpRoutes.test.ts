import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeMcpClientFactory, FakeMcpRegistry, FakeMcpServer } from "./fakeMcpServer.js";
import { mountMcpRoutes } from "./mcpRoutes.js";
import { McpService, type CredentialVault } from "./mcpService.js";

class MemoryCredentialVault implements CredentialVault {
  readonly values = new Map<string, string>();
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

describe("MCP HTTP routes", () => {
  let root: string;
  let registry: FakeMcpRegistry;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-mcp-routes-"));
    registry = new FakeMcpRegistry();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function buildApp() {
    const server = new FakeMcpServer({
      tools: [
        { name: "hello", description: "say hello", risk: "read" },
        { name: "net", description: "network", risk: "network" }
      ],
      handlers: {
        hello: async (args) => ({ content: { message: `hi ${args.who ?? "world"}` } }),
        net: async () => ({ content: { ok: true } })
      }
    });
    registry.register("route-fake", server);

    const mcp = await McpService.open({
      statePath: join(root, "mcp.json"),
      vault: new MemoryCredentialVault(),
      clientFactory: createFakeMcpClientFactory(registry)
    });

    const app = express();
    app.use(express.json());
    mountMcpRoutes(app, mcp);
    return { app, mcp };
  }

  it("supports CRUD, test, tool list, role bindings and secret-free export via HTTP", async () => {
    const { app } = await buildApp();

    const created = await request(app)
      .post("/api/mcp/connections")
      .send({
        name: "Route MCP",
        transport: "fake",
        fakeServerId: "route-fake",
        env: { SECRET: "should-not-leak" }
      })
      .expect(201);

    expect(created.body).toMatchObject({
      name: "Route MCP",
      transport: "fake",
      enabled: true,
      credentialPresent: true,
      envKeys: ["SECRET"]
    });
    expect(created.body).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(created.body)).not.toContain("should-not-leak");

    const listed = await request(app).get("/api/mcp/connections").expect(200);
    expect(listed.body).toHaveLength(1);

    const tested = await request(app)
      .post(`/api/mcp/connections/${created.body.id}/test`)
      .expect(200);
    expect(tested.body).toMatchObject({ kind: "success", toolCount: 2 });

    const tools = await request(app)
      .get(`/api/mcp/connections/${created.body.id}/tools`)
      .expect(200);
    expect(tools.body.map((t: { name: string }) => t.name).sort()).toEqual(["hello", "net"]);

    await request(app)
      .put("/api/mcp/role-bindings/role-a")
      .send({
        tools: [{ connectionId: created.body.id, toolName: "hello" }]
      })
      .expect(200);

    const roleTools = await request(app).get("/api/mcp/roles/role-a/tools").expect(200);
    expect(roleTools.body).toHaveLength(1);
    expect(roleTools.body[0].toolName).toBe("hello");

    const callOk = await request(app)
      .post(`/api/mcp/connections/${created.body.id}/tools/hello/call`)
      .send({
        args: { who: "PAW" },
        roleId: "role-a",
        permissions: { workspace: "project_only", network: false, shell: false, externalSend: false }
      })
      .expect(200);
    expect(callOk.body).toMatchObject({ ok: true, content: { message: "hi PAW" } });

    const callDenied = await request(app)
      .post(`/api/mcp/connections/${created.body.id}/tools/net/call`)
      .send({
        roleId: "role-a",
        permissions: { workspace: "project_only", network: true, shell: false, externalSend: false }
      })
      .expect(422);
    expect(callDenied.body).toMatchObject({ ok: false, kind: "not_bound" });

    const snapshot = await request(app).get("/api/mcp/export-snapshot").expect(200);
    expect(snapshot.body.secretsExcluded).toBe(true);
    expect(JSON.stringify(snapshot.body)).not.toContain("should-not-leak");

    await request(app)
      .patch(`/api/mcp/connections/${created.body.id}`)
      .send({ enabled: false })
      .expect(200);

    await request(app).delete(`/api/mcp/connections/${created.body.id}`).expect(204);
    const after = await request(app).get("/api/mcp/connections").expect(200);
    expect(after.body).toEqual([]);
  });
});
