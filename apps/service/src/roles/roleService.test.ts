import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { createApp } from "../http/app.js";
import { RoleService } from "./roleService.js";

class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();
  async read(reference: string): Promise<string | undefined> { return this.values.get(reference); }
  async write(reference: string, secret: string): Promise<void> { this.values.set(reference, secret); }
  async remove(reference: string): Promise<void> { this.values.delete(reference); }
}

describe("Agent Role configuration contract", () => {
  let root: string;
  let connections: ConnectionService;
  let roles: RoleService;
  let pausedConnections: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-roles-"));
    pausedConnections = [];
    connections = await ConnectionService.open(
      join(root, "connections.json"),
      new MemoryCredentialVault(),
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] })),
      async (connectionId) => { pausedConnections.push(connectionId); }
    );
    roles = await RoleService.open(join(root, "roles.json"), connections);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const roleInput = {
    name: "实现者",
    responsibility: "在批准范围内实现与验证",
    systemInstruction: "先读上下文，再做最小修改。",
    harness: "api" as const,
    reasoningEffort: "high" as const,
    skills: ["implement", "tdd"],
    tools: ["filesystem", "shell"],
    permissions: { workspace: "project_only" as const, network: false, shell: true, externalSend: false },
    allowFirstmateAutoInvoke: true
  };

  it("creates, copies, edits, disables and deletes an ordinary reusable Agent Role", async () => {
    const app = createApp({ version: "0.1.0", connections, roles });
    const created = await request(app).post("/api/roles").send(roleInput).expect(201);
    expect(created.body).toMatchObject({ name: "实现者", enabled: true, allowFirstmateAutoInvoke: true });

    const copied = await request(app).post(`/api/roles/${created.body.id}/copy`).send({ name: "实现者副本" }).expect(201);
    expect(copied.body).toMatchObject({ name: "实现者副本", id: expect.not.stringMatching(created.body.id) });

    await request(app).patch(`/api/roles/${created.body.id}`).send({ enabled: false, reasoningEffort: "medium" }).expect(200);
    expect(await roles.get(created.body.id)).toMatchObject({ enabled: false, reasoningEffort: "medium" });
    await request(app).delete(`/api/roles/${copied.body.id}`).expect(204);
    expect((await roles.list()).map((role) => role.id)).toEqual([created.body.id]);
  });

  it("keeps Firstmate orchestration and security rules outside ordinary Role configuration", async () => {
    expect(roles.firstmateCoreRules).toContain("Firstmate only orchestrates");
    await expect(roles.create({ ...roleInput, roleKind: "firstmate" })).rejects.toThrow("cannot be configured as an ordinary Agent Role");
  });

  it("rejects malformed permission values instead of persisting an untrusted Role", async () => {
    const app = createApp({ version: "0.1.0", connections, roles });

    await request(app)
      .post("/api/roles")
      .send({ ...roleInput, permissions: { ...roleInput.permissions, network: "allowed" } })
      .expect(400);

    expect(await roles.list()).toEqual([]);
  });

  it("rejects malformed permission values on update instead of silently keeping the old value", async () => {
    const app = createApp({ version: "0.1.0", connections, roles });
    const role = await roles.create(roleInput);

    await request(app)
      .patch(`/api/roles/${role.id}`)
      .send({ permissions: { ...roleInput.permissions, shell: "yes" } })
      .expect(400);

    expect((await roles.get(role.id)).permissions).toEqual(roleInput.permissions);
  });

  it("allows a user to clear a model binding and reports a removed binding as not ready", async () => {
    const app = createApp({ version: "0.1.0", connections, roles });
    const connection = await connections.create({ baseUrl: "https://api.example.test/v1", apiKey: "key", modelId: "gpt-5" });
    const role = await roles.create({ ...roleInput, connectionId: connection.id, modelId: "gpt-5" });

    const cleared = await request(app).patch(`/api/roles/${role.id}`).send({ connectionId: null, modelId: null }).expect(200);
    expect(cleared.body).not.toHaveProperty("connectionId");
    expect(cleared.body).not.toHaveProperty("modelId");

    await roles.update(role.id, { connectionId: connection.id });
    await connections.remove(connection.id);
    await expect(roles.verify(role.id)).resolves.toMatchObject({ ready: false, connection: { ready: false } });
  });

  it("verifies connections and requested tools without creating a formal Run", async () => {
    const connection = await connections.create({ baseUrl: "https://api.example.test/v1", apiKey: "key", modelId: "gpt-5" });
    const role = await roles.create({ ...roleInput, connectionId: connection.id, modelId: "gpt-5" });

    expect(await roles.verify(role.id)).toMatchObject({ ready: true, formalRunStarted: false });
    const modelMismatch = await roles.create({ ...roleInput, name: "错误模型", connectionId: connection.id, modelId: "not-available" });
    expect(await roles.verify(modelMismatch.id)).toMatchObject({ ready: false, formalRunStarted: false, connection: { ready: false } });
    expect(pausedConnections).toEqual([]);
    const broken = await roles.create({ ...roleInput, name: "缺工具", tools: ["missing-tool"] });
    expect(await roles.verify(broken.id)).toMatchObject({ ready: false, missingTools: ["missing-tool"], formalRunStarted: false });
  });
});
