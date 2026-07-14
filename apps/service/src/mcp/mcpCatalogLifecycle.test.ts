import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalMcpCatalogProvider } from "./mcpCatalog.js";
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

describe("MCP catalog lifecycle (Task 40)", () => {
  let root: string;
  let statePath: string;
  let vault: MemoryCredentialVault;
  let registry: FakeMcpRegistry;
  let catalog: LocalMcpCatalogProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-mcp-life-"));
    statePath = join(root, "mcp.json");
    vault = new MemoryCredentialVault();
    registry = new FakeMcpRegistry();
    catalog = new LocalMcpCatalogProvider();

    registry.register(
      "catalog-workspace-files",
      new FakeMcpServer({
        tools: [
          { name: "list_files", description: "List workspace files", risk: "read" },
          { name: "read_file", description: "Read a file", risk: "read" }
        ],
        handlers: {
          list_files: async () => ({ content: ["a.ts"] }),
          read_file: async () => ({ content: "ok" })
        }
      })
    );
    registry.register(
      "catalog-http-fetch",
      new FakeMcpServer({
        tools: [{ name: "fetch_url", description: "HTTP GET", risk: "network" }],
        handlers: { fetch_url: async () => ({ content: { status: 200 } }) }
      })
    );
    registry.register(
      "catalog-notes",
      new FakeMcpServer({
        tools: [{ name: "write_note", description: "Write note", risk: "write" }],
        handlers: { write_note: async () => ({ content: "saved" }) }
      })
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function openService() {
    return McpService.open({
      statePath,
      vault,
      catalog,
      clientFactory: createFakeMcpClientFactory(registry),
      defaultTimeoutMs: 200
    });
  }

  it("searches catalog, requires confirm to install, and blocks tool calls until trusted", async () => {
    const mcp = await openService();
    const search = mcp.searchCatalog({ recommendedOnly: true });
    expect(search.catalogAvailable).toBe(true);
    expect(search.entries.every((e) => e.recommended)).toBe(true);
    expect(search.entries.some((e) => e.id === "catalog-mcp-workspace-files")).toBe(true);

    await expect(mcp.installFromCatalog("catalog-mcp-workspace-files")).rejects.toThrow(/confirm/i);

    const preview = mcp.previewInstall("catalog-mcp-workspace-files");
    expect(preview.requiresConfirm).toBe(true);
    expect(preview.permissionLines.some((line) => /confirmation/i.test(line))).toBe(true);

    const installed = await mcp.installFromCatalog("catalog-mcp-workspace-files", { confirm: true });
    expect(installed).toMatchObject({
      source: "catalog",
      catalogId: "catalog-mcp-workspace-files",
      version: "1.0.0",
      trusted: false
    });

    await mcp.test(installed.id);
    await mcp.setRoleBindings("role-a", [
      { connectionId: installed.id, toolName: "list_files" }
    ]);

    const denied = await mcp.callTool(installed.id, "list_files", {}, { roleId: "role-a" });
    expect(denied).toMatchObject({ ok: false, kind: "untrusted" });

    const summary = await mcp.permissionSummary(installed.id);
    expect(summary.requiresTrustConfirmation).toBe(true);
    expect(summary.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_files", "read_file"]));

    await mcp.trust(installed.id);
    const allowed = await mcp.callTool(installed.id, "list_files", {}, { roleId: "role-a" });
    expect(allowed.ok).toBe(true);

    // Still per-tool binding — whole server not exposed
    const notBound = await mcp.callTool(installed.id, "read_file", {}, { roleId: "role-a" });
    expect(notBound).toMatchObject({ ok: false, kind: "not_bound" });
  });

  it("updates catalog version with re-trust and supports rollback", async () => {
    const mcp = await openService();
    const installed = await mcp.installFromCatalog("catalog-mcp-notes", { confirm: true });
    await mcp.trust(installed.id);
    expect((await mcp.get(installed.id)).trusted).toBe(true);

    catalog.upsert({
      ...catalog.get("catalog-mcp-notes")!,
      version: "1.2.0",
      description: "Notes server v1.2"
    });

    const preview = await mcp.previewUpdate(installed.id);
    expect(preview.requiresConfirm).toBe(true);
    expect(preview.targetVersion).toBe("1.2.0");
    expect(preview.configDiff).toContain("+version: 1.2.0");

    await expect(mcp.updateFromCatalog(installed.id)).rejects.toThrow(/confirm/i);

    const updated = await mcp.updateFromCatalog(installed.id, { confirm: true });
    expect(updated.version).toBe("1.2.0");
    expect(updated.trusted).toBe(false);
    expect(updated.description).toContain("v1.2");

    const rolled = await mcp.rollback(installed.id, { confirm: true });
    expect(rolled.version).toBe("1.1.0");
    expect(rolled.trusted).toBe(false);
  });

  it("manages installed MCP offline when catalog is unavailable", async () => {
    const mcp = await openService();
    const installed = await mcp.installFromCatalog("catalog-mcp-http-fetch", { confirm: true });
    await mcp.trust(installed.id);
    await mcp.update(installed.id, { enabled: false });

    catalog.setAvailable(false);
    const search = mcp.searchCatalog({ query: "http" });
    expect(search.catalogAvailable).toBe(false);
    expect(search.entries).toEqual([]);

    const listed = await mcp.list();
    expect(listed.some((c) => c.id === installed.id)).toBe(true);
    await mcp.update(installed.id, { enabled: true });
    expect((await mcp.get(installed.id)).enabled).toBe(true);

    await expect(mcp.installFromCatalog("catalog-mcp-workspace-files", { confirm: true })).rejects.toThrow(
      /offline/i
    );
  });

  it("exposes catalog lifecycle routes and keeps manual connections trusted by default", async () => {
    const mcp = await openService();
    const app = express();
    app.use(express.json());
    mountMcpRoutes(app, mcp);

    const catalogRes = await request(app).get("/api/mcp/catalog?recommended=true").expect(200);
    expect(catalogRes.body.catalogAvailable).toBe(true);

    await request(app)
      .post("/api/mcp/catalog/install")
      .send({ catalogId: "catalog-mcp-workspace-files" })
      .expect(400);

    const installed = await request(app)
      .post("/api/mcp/catalog/install")
      .send({ catalogId: "catalog-mcp-workspace-files", confirm: true })
      .expect(201);
    expect(installed.body.trusted).toBe(false);
    expect(installed.body.source).toBe("catalog");

    const perms = await request(app)
      .get(`/api/mcp/connections/${installed.body.id}/permissions`)
      .expect(200);
    expect(perms.body.requiresTrustConfirmation).toBe(true);

    await request(app).post(`/api/mcp/connections/${installed.body.id}/trust`).expect(200);

    // Manual create remains trusted (Task 24 backward compat)
    const manual = await request(app)
      .post("/api/mcp/connections")
      .send({ name: "manual", transport: "fake", fakeServerId: "catalog-notes" })
      .expect(201);
    expect(manual.body.trusted).toBe(true);
  });
});
