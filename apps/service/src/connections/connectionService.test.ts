import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../http/app.js";
import { ConnectionService, type CredentialVault } from "./connectionService.js";

class MemoryCredentialVault implements CredentialVault {
  readonly values = new Map<string, string>();
  async read(reference: string): Promise<string | undefined> { return this.values.get(reference); }
  async write(reference: string, secret: string): Promise<void> { this.values.set(reference, secret); }
  async remove(reference: string): Promise<void> { this.values.delete(reference); }
}

describe("OpenAI-compatible model connection contract", () => {
  let root: string;
  let statePath: string;
  let vault: MemoryCredentialVault;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-connections-"));
    statePath = join(root, "connections.json");
    vault = new MemoryCredentialVault();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores custom Base URL, model ID and API Key while keeping the key out of normal persisted state", async () => {
    const connections = await ConnectionService.open(statePath, vault, async () => new Response(JSON.stringify({ data: [] })));
    const app = createApp({ version: "0.1.0", connections });
    const created = await request(app)
      .post("/api/connections")
      .send({ name: "我的中转站", baseUrl: "https://api.yairouter.com/v1", apiKey: "very-secret-key", modelId: "gpt-5" })
      .expect(201);

    expect(created.body).toMatchObject({
      name: "我的中转站",
      baseUrl: "https://api.yairouter.com/v1",
      modelId: "gpt-5",
      enabled: true
    });
    expect(created.body).not.toHaveProperty("apiKey");
    expect(created.body).not.toHaveProperty("credentialRef");
    expect(vault.values.get((await connections.get(created.body.id)).credentialRef)).toBe("very-secret-key");
    expect(await readFile(statePath, "utf8")).not.toContain("very-secret-key");
  });

  it("reports success, authentication failure, network failure and unavailable model distinctly", async () => {
    const responses = [
      new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 }),
      new Response("unauthorized", { status: 401 }),
      new Error("socket closed"),
      new Response(JSON.stringify({ data: [{ id: "other-model" }] }), { status: 200 })
    ];
    const connections = await ConnectionService.open(statePath, vault, async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next!;
    });
    const connection = await connections.create({ baseUrl: "https://api.example.test/v1", apiKey: "key", modelId: "gpt-5" });

    expect(await connections.test(connection.id)).toMatchObject({ kind: "success" });
    expect(await connections.test(connection.id)).toMatchObject({ kind: "authentication_failed" });
    expect(await connections.test(connection.id)).toMatchObject({ kind: "network_failed" });
    expect(await connections.test(connection.id)).toMatchObject({ kind: "model_unavailable" });
  });

  it("notifies the execution layer to pause affected work when a connection becomes unusable", async () => {
    const pauses: Array<{ connectionId: string; reason: string }> = [];
    const connections = await ConnectionService.open(
      statePath,
      vault,
      async () => new Response("unauthorized", { status: 401 }),
      async (connectionId, reason) => { pauses.push({ connectionId, reason }); }
    );
    const connection = await connections.create({ baseUrl: "https://api.example.test/v1", apiKey: "key", modelId: "gpt-5" });

    expect(await connections.test(connection.id)).toMatchObject({ kind: "authentication_failed" });
    expect(pauses).toEqual([expect.objectContaining({ connectionId: connection.id })]);
  });

  it("allows users to enable, disable, edit and delete a connection without leaving a credential behind", async () => {
    const connections = await ConnectionService.open(statePath, vault, async () => new Response(JSON.stringify({ data: [] })));
    const connection = await connections.create({ baseUrl: "https://api.example.test/v1", apiKey: "old-key", modelId: "old" });

    const disabled = await connections.update(connection.id, { enabled: false, modelId: "new" });
    expect(disabled).toMatchObject({ enabled: false, modelId: "new" });
    await connections.update(connection.id, { apiKey: "new-key" });
    expect(vault.values.get(connection.credentialRef)).toBe("new-key");
    await connections.remove(connection.id);
    expect(await connections.list()).toEqual([]);
    expect(vault.values.has(connection.credentialRef)).toBe(false);
  });

  it("does not replace a stored credential when another field in the same update is invalid", async () => {
    const connections = await ConnectionService.open(statePath, vault, async () => new Response(JSON.stringify({ data: [] })));
    const connection = await connections.create({ baseUrl: "https://api.example.test/v1", apiKey: "old-key", modelId: "old" });

    await expect(connections.update(connection.id, { apiKey: "new-key", baseUrl: "not a URL" })).rejects.toThrow("Base URL");
    expect(vault.values.get(connection.credentialRef)).toBe("old-key");
  });
});
