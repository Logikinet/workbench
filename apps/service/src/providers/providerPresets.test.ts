import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { createConnectionRouteApp } from "../connections/connectionRoutes.js";
import {
  listProviderPresets,
  validateProviderConfig,
  ConfigHotReloader
} from "./index.js";
import { createProviderRouteApp } from "./providerRoutes.js";

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

describe("Provider presets and schema validation", () => {
  it("exposes presets without default relay and without secrets", () => {
    const presets = listProviderPresets();
    expect(presets.length).toBeGreaterThanOrEqual(4);
    expect(presets.every((preset) => !("apiKey" in preset))).toBe(true);
    expect(presets.some((preset) => preset.id === "custom")).toBe(true);
    expect(presets.some((preset) => preset.id === "openai")).toBe(true);
    expect(presets.some((preset) => preset.id === "ollama")).toBe(true);
    // No hard-coded third-party relay as the only option.
    expect(presets.find((preset) => /yairouter|openrouter|default-relay/i.test(preset.id))).toBeUndefined();
  });

  it("rejects illegal enums and incompatible combinations", () => {
    expect(() =>
      validateProviderConfig({
        presetId: "not-a-preset",
        baseUrl: "https://api.example.test/v1",
        modelId: "m",
        apiKey: "k"
      })
    ).toThrow(/Invalid provider preset/);

    expect(() =>
      validateProviderConfig({
        presetId: "openai",
        providerKind: "ollama",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-4o",
        apiKey: "k"
      })
    ).toThrow(/incompatible/);

    expect(() =>
      validateProviderConfig({
        presetId: "openai",
        baseUrl: "https://evil.example/v1",
        modelId: "gpt-4o",
        apiKey: "k"
      })
    ).toThrow(/Base URL/);

    // custom allows deferred credential (todos CLI: empty key → configure later)
    expect(() =>
      validateProviderConfig({
        presetId: "custom",
        baseUrl: "https://api.example.test/v1",
        modelId: "m"
      })
    ).not.toThrow();

    // openai still requires a key
    expect(() =>
      validateProviderConfig({
        presetId: "openai",
        modelId: "gpt-4o"
      })
    ).toThrow(/API Key/);

    expect(() =>
      validateProviderConfig({
        presetId: "custom",
        baseUrl: "https://api.example.test/v1",
        modelId: "m",
        modelSource: "wat"
      })
    ).toThrow(/modelSource/);
  });

  it("allows ollama without API Key and custom OpenAI-compatible Base URL", () => {
    const ollama = validateProviderConfig({
      presetId: "ollama",
      modelId: "llama3"
    });
    expect(ollama.baseUrl).toContain("11434");
    expect(ollama.apiKey).toBeUndefined();

    const custom = validateProviderConfig({
      presetId: "custom",
      baseUrl: "https://my-gateway.example/v1/",
      modelId: "gpt-5",
      apiKey: "secret"
    });
    expect(custom.baseUrl).toBe("https://my-gateway.example/v1");
  });
});

describe("Provider secrets, hot reload, probe, usage, audit", () => {
  let root: string;
  let statePath: string;
  let vault: MemoryCredentialVault;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-provider-"));
    statePath = join(root, "connections.json");
    vault = new MemoryCredentialVault();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps API keys in the vault only and never echoes them in public views or audit", async () => {
    const secret = "sk-live-super-secret-never-echo";
    const connections = await ConnectionService.open(statePath, vault, async () => new Response(JSON.stringify({ data: [] })));
    const created = await connections.create({
      presetId: "custom",
      name: "中转",
      baseUrl: "https://api.example.test/v1",
      apiKey: secret,
      modelId: "gpt-5"
    });

    expect(created.credentialPresent).toBe(true);
    expect(created).not.toHaveProperty("apiKey");
    expect(JSON.stringify(created)).not.toContain(secret);
    expect(await readFile(statePath, "utf8")).not.toContain(secret);
    expect(vault.values.get(created.credentialRef)).toBe(secret);

    const publicRow = await connections.getPublic(created.id);
    expect(publicRow.credentialPresent).toBe(true);
    expect(publicRow).not.toHaveProperty("credentialRef");
    expect(publicRow).not.toHaveProperty("apiKey");
    expect(JSON.stringify(publicRow)).not.toContain(secret);

    const audit = await connections.listAudit(created.id);
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("hot-applies non-secret config without process restart and notifies subscribers", async () => {
    const connections = await ConnectionService.open(statePath, vault, async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] })));
    const events: Array<{ revision: number; action: string }> = [];
    connections.subscribeConfigChanges((event) => {
      events.push({ revision: event.revision, action: event.action });
    });

    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "gpt-5"
    });
    expect(connections.getConfigRevision()).toBeGreaterThan(0);

    await connections.update(connection.id, { modelId: "gpt-5-mini", enabled: true });
    const applied = await connections.hotApply(connection.id);
    expect(applied.revision).toBe(connections.getConfigRevision());
    expect(events.some((event) => event.action === "hot_apply")).toBe(true);

    // Live get reflects update immediately (no restart).
    expect((await connections.get(connection.id)).modelId).toBe("gpt-5-mini");
  });

  it("supports dynamic model list and falls back to manual model ID", async () => {
    const connections = await ConnectionService.open(statePath, vault, async (url) => {
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "alpha"
    });
    const listed = await connections.listModels(connection.id);
    expect(listed.supported).toBe(true);
    expect(listed.manualModelIdRequired).toBe(false);
    expect(listed.models.map((model) => model.id)).toEqual(["alpha", "beta"]);

    const unsupported = await ConnectionService.open(
      join(root, "other.json"),
      vault,
      async () => new Response("gone", { status: 404 })
    );
    const other = await unsupported.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "manual-model"
    });
    const fallback = await unsupported.listModels(other.id);
    expect(fallback.manualModelIdRequired).toBe(true);
    expect(fallback.models).toEqual([]);
  });

  it("runs capability probe and usage snapshot with clear diagnostics", async () => {
    const connections = await ConnectionService.open(statePath, vault, async (url, init) => {
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 });
      }
      if (url.endsWith("/chat/completions") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
          }),
          { status: 200 }
        );
      }
      return new Response("no", { status: 404 });
    });
    const connection = await connections.create({
      presetId: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      modelId: "gpt-5"
    });

    const probe = await connections.probe(connection.id);
    expect(probe.modelsEndpoint).toBe(true);
    expect(probe.chatCompletions).toBe(true);
    expect(probe.modelListed).toBe(true);
    expect(probe.message).toMatch(/可用/);

    const usage = await connections.usageSnapshot(connection.id);
    expect(usage.available).toBe(true);
    expect(usage.totalTokens === 4 || usage.source === "last_completion" || usage.source === "provider_endpoint").toBe(true);
  });

  it("records config change audit history without secrets", async () => {
    const connections = await ConnectionService.open(statePath, vault, async () => new Response(JSON.stringify({ data: [] })));
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "secret-key-value",
      modelId: "m1"
    });
    await connections.update(connection.id, { modelId: "m2" });
    await connections.hotApply();
    const audit = await connections.listAudit();
    expect(audit.some((entry) => entry.action === "create")).toBe(true);
    expect(audit.some((entry) => entry.action === "update")).toBe(true);
    expect(audit.some((entry) => entry.action === "hot_apply")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("secret-key-value");
  });

  it("export snapshot for backup never includes vault secrets", async () => {
    const secret = "export-must-not-include-me";
    const connections = await ConnectionService.open(statePath, vault, async () => new Response(JSON.stringify({ data: [] })));
    await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: secret,
      modelId: "m1"
    });
    const snapshot = await connections.exportSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.connections[0]?.credentialRef).toMatch(/^PersonalAIWorkbench:connection:/);
  });

  it("serves provider and connection enhancement routes", async () => {
    const providerApp = await createProviderRouteApp();
    const presets = await request(providerApp).get("/api/providers/presets").expect(200);
    expect(Array.isArray(presets.body)).toBe(true);
    expect(presets.body[0]).toMatchObject({ id: expect.any(String), name: expect.any(String) });

    const connections = await ConnectionService.open(statePath, vault, async (url) => {
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 });
      }
      if (url.endsWith("/chat/completions")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "pong" } }], usage: { total_tokens: 2 } }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "gpt-5",
      presetId: "custom"
    });
    const app = await createConnectionRouteApp(connections);

    const publicList = await request(app).get("/api/connections/public").expect(200);
    expect(publicList.body[0]).toMatchObject({
      id: connection.id,
      credentialPresent: true,
      presetId: "custom"
    });
    expect(publicList.body[0]).not.toHaveProperty("apiKey");
    expect(publicList.body[0]).not.toHaveProperty("credentialRef");

    await request(app).get(`/api/connections/${connection.id}/models`).expect(200);
    await request(app).post(`/api/connections/${connection.id}/probe`).expect(200);
    await request(app).get(`/api/connections/${connection.id}/usage`).expect(200);
    await request(app).post(`/api/connections/${connection.id}/apply`).expect(200);
    const audit = await request(app).get(`/api/connections/${connection.id}/audit`).expect(200);
    expect(Array.isArray(audit.body)).toBe(true);
  });
});

describe("ConfigHotReloader", () => {
  it("increments revision and invokes listeners", async () => {
    const reloader = new ConfigHotReloader();
    const seen: number[] = [];
    reloader.subscribe((event) => {
      seen.push(event.revision);
    });
    await reloader.notify("update", "changed");
    await reloader.notify("hot_apply", "applied");
    expect(seen).toEqual([1, 2]);
    expect(reloader.getRevision()).toBe(2);
  });
});
