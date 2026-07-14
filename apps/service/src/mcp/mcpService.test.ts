import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClientUnavailableError } from "./mcpClient.js";
import { createFakeMcpClientFactory, FakeMcpRegistry, FakeMcpServer } from "./fakeMcpServer.js";
import { McpService, type CredentialVault } from "./mcpService.js";
import { MCP_MAX_ARGS_BYTES, MCP_MAX_RESULT_BYTES } from "./mcpTypes.js";

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

describe("MCP connections (Task 24)", () => {
  let root: string;
  let statePath: string;
  let vault: MemoryCredentialVault;
  let registry: FakeMcpRegistry;
  let pauses: Array<{ connectionId: string; reason: string }>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-mcp-"));
    statePath = join(root, "mcp-connections.json");
    vault = new MemoryCredentialVault();
    registry = new FakeMcpRegistry();
    pauses = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function openService(server?: FakeMcpServer, serverId = "fake-1") {
    if (server) registry.register(serverId, server);
    return McpService.open({
      statePath,
      vault,
      clientFactory: createFakeMcpClientFactory(registry),
      onUnavailable: async (connectionId, reason) => {
        pauses.push({ connectionId, reason });
      },
      defaultTimeoutMs: 200
    });
  }

  it("creates, enables, disables MCP connections and discovers tools with descriptions", async () => {
    const server = new FakeMcpServer({
      tools: [
        { name: "read_file", description: "Read a workspace file", risk: "read" },
        { name: "http_fetch", description: "Fetch a URL over the network", risk: "network" }
      ]
    });
    const mcp = await openService(server);

    const created = await mcp.create({
      name: "本地测试 MCP",
      transport: "fake",
      fakeServerId: "fake-1",
      env: { MCP_TOKEN: "super-secret-env" }
    });

    expect(created).toMatchObject({
      name: "本地测试 MCP",
      transport: "fake",
      enabled: true,
      envKeys: ["MCP_TOKEN"],
      credentialPresent: true
    });
    expect(created).not.toHaveProperty("env");
    expect(vault.values.get(created.credentialRef)).toContain("super-secret-env");
    expect(await readFile(statePath, "utf8")).not.toContain("super-secret-env");

    const tested = await mcp.test(created.id);
    expect(tested).toMatchObject({ kind: "success", toolCount: 2 });

    const tools = await mcp.listTools(created.id);
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "read_file", description: "Read a workspace file" }),
        expect.objectContaining({ name: "http_fetch", description: "Fetch a URL over the network" })
      ])
    );

    const disabled = await mcp.update(created.id, { enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(await mcp.test(created.id)).toMatchObject({ kind: "disabled" });

    await mcp.update(created.id, { enabled: true });
    await mcp.remove(created.id);
    expect(await mcp.list()).toEqual([]);
    expect(vault.values.has(created.credentialRef)).toBe(false);
  });

  it("binds specific MCP tools to an Agent Role instead of exposing the whole server", async () => {
    const server = new FakeMcpServer({
      tools: [
        { name: "alpha", description: "A" },
        { name: "beta", description: "B" },
        { name: "gamma", description: "C" }
      ],
      handlers: {
        alpha: async () => ({ content: { value: 1 } }),
        beta: async () => ({ content: { value: 2 } }),
        gamma: async () => ({ content: { value: 3 } })
      }
    });
    const mcp = await openService(server);
    const connection = await mcp.create({
      name: "tools",
      transport: "fake",
      fakeServerId: "fake-1"
    });
    await mcp.test(connection.id);

    await mcp.setRoleBindings("role-dev", [
      { connectionId: connection.id, toolName: "alpha" },
      { connectionId: connection.id, toolName: "beta" }
    ]);

    const forRole = await mcp.listToolsForRole("role-dev");
    expect(forRole.map((t) => t.toolName).sort()).toEqual(["alpha", "beta"]);
    expect(forRole.map((t) => t.toolName)).not.toContain("gamma");

    const allowed = await mcp.callTool(connection.id, "alpha", {}, { roleId: "role-dev" });
    expect(allowed.ok).toBe(true);

    const denied = await mcp.callTool(connection.id, "gamma", {}, { roleId: "role-dev" });
    expect(denied).toMatchObject({
      ok: false,
      kind: "not_bound",
      pauseRelatedSubtasks: false
    });
  });

  it("inherits workspace, network, shell and user-approval rules for MCP tools", async () => {
    const server = new FakeMcpServer({
      tools: [
        { name: "read_note", description: "read only", risk: "read" },
        { name: "write_note", description: "write file", risk: "write" },
        { name: "http_get", description: "network fetch", risk: "network" },
        { name: "run_shell", description: "shell exec", risk: "shell" },
        { name: "danger_wipe", description: "dangerous delete", risk: "dangerous" }
      ],
      handlers: {
        read_note: async () => ({ content: "ok" }),
        write_note: async () => ({ content: "ok" }),
        http_get: async () => ({ content: "ok" }),
        run_shell: async () => ({ content: "ok" }),
        danger_wipe: async () => ({ content: "ok" })
      }
    });
    const mcp = await openService(server);
    const connection = await mcp.create({
      name: "policy",
      transport: "fake",
      fakeServerId: "fake-1"
    });
    await mcp.test(connection.id);
    await mcp.setRoleBindings("role-x", [
      { connectionId: connection.id, toolName: "read_note" },
      { connectionId: connection.id, toolName: "write_note" },
      { connectionId: connection.id, toolName: "http_get" },
      { connectionId: connection.id, toolName: "run_shell" },
      { connectionId: connection.id, toolName: "danger_wipe" }
    ]);

    const base = {
      roleId: "role-x",
      permissions: {
        workspace: "read_only" as const,
        network: false,
        shell: false,
        externalSend: false
      }
    };

    expect((await mcp.callTool(connection.id, "read_note", {}, base)).ok).toBe(true);
    expect(await mcp.callTool(connection.id, "write_note", {}, base)).toMatchObject({
      ok: false,
      kind: "permission_denied"
    });
    expect(await mcp.callTool(connection.id, "http_get", {}, base)).toMatchObject({
      ok: false,
      kind: "permission_denied"
    });
    expect(await mcp.callTool(connection.id, "run_shell", {}, base)).toMatchObject({
      ok: false,
      kind: "permission_denied"
    });
    expect(await mcp.callTool(connection.id, "danger_wipe", {}, base)).toMatchObject({
      ok: false,
      kind: "permission_denied"
    });

    const elevated = {
      roleId: "role-x",
      permissions: {
        workspace: "project_only" as const,
        network: true,
        shell: true,
        externalSend: true
      },
      approvedDangerous: false
    };
    expect((await mcp.callTool(connection.id, "http_get", {}, elevated)).ok).toBe(true);
    expect((await mcp.callTool(connection.id, "run_shell", {}, elevated)).ok).toBe(true);
    expect(await mcp.callTool(connection.id, "danger_wipe", {}, elevated)).toMatchObject({
      ok: false,
      kind: "permission_denied"
    });
    expect(
      (
        await mcp.callTool(connection.id, "danger_wipe", {}, { ...elevated, approvedDangerous: true })
      ).ok
    ).toBe(true);
  });

  it("applies argument/result size limits, timeout, log redaction and error normalization", async () => {
    const huge = "x".repeat(MCP_MAX_RESULT_BYTES + 100);
    const server = new FakeMcpServer({
      tools: [
        { name: "echo", description: "echo", risk: "read" },
        { name: "slow", description: "slow", risk: "read" },
        { name: "secretive", description: "returns secrets", risk: "read" }
      ],
      handlers: {
        echo: async (args) => ({ content: args }),
        slow: async (_args, options) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 500);
            options?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                const err = new Error("The operation was aborted.");
                err.name = "AbortError";
                reject(err);
              },
              { once: true }
            );
          });
          return { content: "done" };
        },
        secretive: async () => ({
          content: { token: "sk-abcdefghijklmnopqrstuvwxyz", note: "Bearer abc.def.ghi" }
        })
      }
    });
    // Override delay for huge result path
    server.setHandler("huge", async () => ({ content: { blob: huge } }));
    server.setTools([
      ...server.tools,
      { name: "huge", description: "big payload", risk: "read" }
    ]);

    const mcp = await openService(server);
    const connection = await mcp.create({
      name: "limits",
      transport: "fake",
      fakeServerId: "fake-1"
    });
    await mcp.test(connection.id);

    const tooBigArgs: Record<string, unknown> = {
      data: "y".repeat(MCP_MAX_ARGS_BYTES + 10)
    };
    const argsDenied = await mcp.callTool(connection.id, "echo", tooBigArgs);
    expect(argsDenied).toMatchObject({ ok: false, kind: "args_too_large" });

    const timedOut = await mcp.callTool(connection.id, "slow", {}, { timeoutMs: 30 });
    expect(timedOut).toMatchObject({ ok: false, kind: "timeout", pauseRelatedSubtasks: true });

    const controller = new AbortController();
    const cancelPromise = mcp.callTool(connection.id, "slow", {}, { signal: controller.signal, timeoutMs: 5_000 });
    controller.abort();
    const cancelled = await cancelPromise;
    expect(cancelled).toMatchObject({ ok: false, kind: "cancelled", pauseRelatedSubtasks: false });

    const secretResult = await mcp.callTool(connection.id, "secretive", {});
    expect(secretResult.ok).toBe(true);
    if (secretResult.ok) {
      const text = JSON.stringify(secretResult.content);
      expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(text).toMatch(/REDACTED/i);
    }

    const big = await mcp.callTool(connection.id, "huge", {});
    expect(big.ok).toBe(true);
    if (big.ok) {
      expect(big.truncated).toBe(true);
      expect(big.resultBytes).toBeGreaterThan(MCP_MAX_RESULT_BYTES);
    }
  });

  it("when MCP server is unavailable only pauses related subtasks and does not throw", async () => {
    const server = new FakeMcpServer({
      tools: [{ name: "ping", description: "ping", risk: "read" }],
      handlers: { ping: async () => ({ content: "pong" }) }
    });
    const mcp = await openService(server);
    const connection = await mcp.create({
      name: "flaky",
      transport: "fake",
      fakeServerId: "fake-1"
    });
    await mcp.test(connection.id);

    server.callError = new McpClientUnavailableError("MCP process exited", "server_unavailable");
    const result = await mcp.callTool(connection.id, "ping", {});
    expect(result).toMatchObject({
      ok: false,
      kind: "unavailable",
      pauseRelatedSubtasks: true
    });
    expect(pauses).toEqual([expect.objectContaining({ connectionId: connection.id })]);

    // Workbench continues: list still works, other operations soft-fail
    expect(await mcp.list()).toHaveLength(1);
    server.callError = undefined;
    server.listError = new McpClientUnavailableError("down", "network_failed");
    const testResult = await mcp.test(connection.id);
    expect(testResult.kind).toBe("network_failed");
    expect(pauses.length).toBeGreaterThanOrEqual(2);
  });

  it("exportSnapshot excludes MCP secrets and sensitive environment values", async () => {
    const server = new FakeMcpServer({
      tools: [{ name: "t", description: "t" }]
    });
    const mcp = await openService(server);
    const connection = await mcp.create({
      name: "secretive-conn",
      transport: "fake",
      fakeServerId: "fake-1",
      env: { API_KEY: "env-secret-value", HOME: "C:\\Users\\admin" },
      authToken: "http-bearer-secret"
    });
    await mcp.test(connection.id);
    await mcp.setRoleBindings("role-1", [{ connectionId: connection.id, toolName: "t" }]);

    const snapshot = await mcp.exportSnapshot();
    expect(snapshot.secretsExcluded).toBe(true);
    expect(snapshot.connections[0]).toMatchObject({
      id: connection.id,
      envKeys: ["API_KEY", "HOME"],
      credentialPresent: false
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("env-secret-value");
    expect(serialized).not.toContain("http-bearer-secret");
    expect(serialized).not.toContain("API_KEY\":\"env");
    expect(serialized).toContain("API_KEY");
    expect(snapshot.roleBindings).toHaveLength(1);

    // State file also free of secrets
    const disk = await readFile(statePath, "utf8");
    expect(disk).not.toContain("env-secret-value");
    expect(disk).not.toContain("http-bearer-secret");
  });

  it("Fake MCP covers discovery, call, failure and cancel paths end-to-end", async () => {
    const server = new FakeMcpServer({
      tools: [{ name: "add", description: "add numbers", inputSchema: { type: "object" }, risk: "read" }],
      handlers: {
        add: async (args) => ({
          content: { sum: Number(args.a ?? 0) + Number(args.b ?? 0) }
        })
      }
    });
    const mcp = await openService(server);
    const connection = await mcp.create({
      name: "fake-e2e",
      transport: "fake",
      fakeServerId: "fake-1"
    });

    // discovery
    const discovered = await mcp.test(connection.id);
    expect(discovered.kind).toBe("success");
    expect(discovered.toolCount).toBe(1);

    // call
    const sum = await mcp.callTool(connection.id, "add", { a: 2, b: 3 });
    expect(sum).toMatchObject({ ok: true, content: { sum: 5 } });
    expect(server.callLog).toEqual([expect.objectContaining({ name: "add" })]);

    // failure
    server.failNextCall = new Error("tool boom");
    const failed = await mcp.callTool(connection.id, "add", { a: 1, b: 1 });
    expect(failed).toMatchObject({ ok: false, kind: "tool_error" });

    // cancel
    server.delayMs = 300;
    const ac = new AbortController();
    const pending = mcp.callTool(connection.id, "add", { a: 0, b: 0 }, { signal: ac.signal, timeoutMs: 5_000 });
    ac.abort();
    expect(await pending).toMatchObject({ ok: false, kind: "cancelled" });
  });
});
