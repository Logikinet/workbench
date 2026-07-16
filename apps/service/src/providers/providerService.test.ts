import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { ProviderService } from "./providerService.js";

class MemoryVault implements CredentialVault {
  private readonly store = new Map<string, string>();
  async read(ref: string) {
    return this.store.get(ref);
  }
  async write(ref: string, value: string) {
    this.store.set(ref, value);
  }
  async remove(ref: string) {
    this.store.delete(ref);
  }
}

describe("ProviderService (task 05)", () => {
  let root: string;
  let connections: ConnectionService;
  let providers: ProviderService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-prov-"));
    const vault = new MemoryVault();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    connections = await ConnectionService.open(join(root, "connections.json"), vault, fetchImpl as typeof fetch);
    providers = new ProviderService({ connections, vault, fetchImpl: fetchImpl as typeof fetch });
    await providers.attachMetaPath(join(root, "provider-meta.json"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates provider, stores credential only in vault, public list has no secrets", async () => {
    const created = await providers.create({
      name: "OpenAI",
      adapter: "openai-compatible",
      authMode: "api-key",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret-never-in-json",
      defaultModelId: "gpt-4o-mini",
      discoverModels: true
    });
    expect(created.credentialConfigured).toBe(true);
    expect(JSON.stringify(created)).not.toMatch(/sk-secret/);
    const list = await providers.list();
    expect(list.some((p) => p.id === created.id)).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/sk-secret/);
  });

  it("tests connection and maps ready status", async () => {
    const created = await providers.create({
      name: "Local",
      adapter: "openai-compatible",
      authMode: "api-key",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      discoverModels: false
    });
    const result = await providers.test(created.id);
    expect(result.status).toBe("ready");
    expect(result.message).not.toMatch(/sk-test/);
  });

  it("supports ollama without api key", async () => {
    const created = await providers.create({
      name: "Ollama",
      adapter: "ollama",
      authMode: "none",
      baseUrl: "http://127.0.0.1:11434/v1",
      discoverModels: false
    });
    expect(created.authMode).toBe("none");
    expect(created.credentialConfigured).toBe(false);
  });

  it("rejects empty api-key auth without key", async () => {
    await expect(
      providers.create({
        name: "Bad",
        adapter: "openai-compatible",
        authMode: "api-key",
        baseUrl: "https://api.openai.com/v1"
      })
    ).rejects.toThrow(/API Key/i);
  });

  it("completes OAuth and stores tokens only in vault", async () => {
    const created = await providers.create({
      name: "Anthropic",
      adapter: "anthropic",
      authMode: "oauth",
      baseUrl: "https://api.anthropic.com",
      allowDeferredCredential: true,
      discoverModels: false,
      defaultModelId: "claude-haiku-4-5"
    });
    expect(created.credentialConfigured).toBe(false);

    const done = await providers.completeOAuth(created.id, {
      oauthProviderId: "anthropic",
      credentials: {
        access: "oauth-access-secret",
        refresh: "oauth-refresh-secret",
        expires: Date.now() + 3_600_000
      }
    });
    expect(done.authMode).toBe("oauth");
    expect(done.credentialConfigured).toBe(true);
    expect(JSON.stringify(done)).not.toMatch(/oauth-access-secret/);
    expect(JSON.stringify(done)).not.toMatch(/oauth-refresh-secret/);

    const start = await providers.startOAuth(created.id);
    expect(start.mode).toBe("cli-interactive");
    expect(start.supportedOAuthProviders.some((p) => p.id === "anthropic")).toBe(true);
    expect(start.message).not.toMatch(/尚未在本构建完成/);
  });
});
