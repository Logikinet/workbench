import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { RoleService } from "../roles/roleService.js";
import { RoleRouterService } from "./roleRouterService.js";
import { createRoutingRouter } from "./routingRoutes.js";

class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();
  async read(reference: string): Promise<string | undefined> { return this.values.get(reference); }
  async write(reference: string, secret: string): Promise<void> { this.values.set(reference, secret); }
  async remove(reference: string): Promise<void> { this.values.delete(reference); }
}

describe("routing routes (Task 20)", () => {
  let root: string;
  let app: express.Express;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-routing-http-"));
    const connections = await ConnectionService.open(
      join(root, "connections.json"),
      new MemoryCredentialVault(),
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 })
    );
    const roles = await RoleService.open(join(root, "roles.json"), connections);
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "gpt-5"
    });
    await roles.create({
      name: "实现者",
      responsibility: "实现",
      systemInstruction: "最小改动",
      harness: "api",
      reasoningEffort: "medium",
      skills: ["implement", "tdd"],
      tools: ["filesystem", "shell"],
      permissions: { workspace: "project_only", network: false, shell: true, externalSend: false },
      allowFirstmateAutoInvoke: true,
      connectionId: connection.id,
      modelId: "gpt-5"
    });
    const roleRouter = new RoleRouterService({ roles, connections });
    app = express();
    app.use(express.json());
    app.use(createRoutingRouter({ roleRouter }));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("POST /api/routing/decisions returns selection with reason and supports override", async () => {
    const created = await request(app)
      .post("/api/routing/decisions")
      .send({
        requiredCapabilities: ["filesystem", "tests"],
        complexity: "low",
        planApproved: true
      })
      .expect(201);

    expect(created.body.instances[0].selection.name).toBe("实现者");
    expect(created.body.instances[0].reason).toBeTruthy();
    expect(created.body.canAutoQueue).toBe(true);

    const listed = await request(app).get("/api/routing/decisions").expect(200);
    expect(listed.body.some((d: { id: string }) => d.id === created.body.id)).toBe(true);

    await request(app).get(`/api/routing/decisions/${created.body.id}`).expect(200);
  });
});
