/**
 * Real MCP transports (HTTP JSON-RPC + stdio Content-Length framing).
 * Minimal client surface for listTools / callTool without bundling the full SDK.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpClient, McpClientCallOptions } from "./mcpClient.js";
import { McpClientUnavailableError } from "./mcpClient.js";
import type { McpConnection, McpToolDescriptor, McpVaultSecrets } from "./mcpTypes.js";

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

export class HttpMcpClient implements McpClient {
  private nextId = 1;
  private initialized = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
  ) {}

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.ensureInitialized();
    const result = await this.rpc("tools/list", {});
    return normalizeTools(result);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpClientCallOptions
  ): Promise<{ content: unknown; isError?: boolean }> {
    await this.ensureInitialized();
    const result = await this.rpc(
      "tools/call",
      { name, arguments: args },
      options?.signal
    );
    const record = asRecord(result);
    return {
      content: record?.content ?? result,
      isError: record?.isError === true
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "personal-ai-workbench", version: "0.1.0" }
    });
    // notifications/initialized is best-effort
    try {
      await this.rpcNotify("notifications/initialized", {});
    } catch {
      /* some servers ignore */
    }
    this.initialized = true;
  }

  private async rpc(
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const id = this.nextId++;
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...this.headers
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal
      });
    } catch (error) {
      throw new McpClientUnavailableError(
        error instanceof Error ? error.message : "MCP HTTP request failed.",
        "network_failed"
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new McpClientUnavailableError(
        `MCP HTTP authentication failed (${response.status}).`,
        "authentication_failed"
      );
    }
    if (!response.ok) {
      throw new McpClientUnavailableError(
        `MCP HTTP server returned ${response.status}.`,
        "server_unavailable"
      );
    }
    const body = (await response.json().catch(() => null)) as JsonRpcResponse | null;
    if (!body || typeof body !== "object") {
      throw new McpClientUnavailableError("MCP HTTP response was not JSON-RPC.", "server_unavailable");
    }
    if (body.error) {
      throw new McpClientUnavailableError(
        body.error.message ?? "MCP JSON-RPC error.",
        "server_unavailable"
      );
    }
    return body.result;
  }

  private async rpcNotify(method: string, params: unknown): Promise<void> {
    await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...this.headers
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params })
    }).catch(() => undefined);
  }
}

// ── stdio ────────────────────────────────────────────────────────────────────

export class StdioMcpClient implements McpClient {
  private nextId = 1;
  private initialized = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv
  ) {}

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.ensureInitialized();
    const result = await this.rpc("tools/list", {});
    return normalizeTools(result);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    _options?: McpClientCallOptions
  ): Promise<{ content: unknown; isError?: boolean }> {
    await this.ensureInitialized();
    const result = await this.rpc("tools/call", { name, arguments: args });
    const record = asRecord(result);
    return {
      content: record?.content ?? result,
      isError: record?.isError === true
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      child.kill();
    }
    for (const [, waiter] of this.pending) {
      waiter.reject(new McpClientUnavailableError("MCP stdio client closed.", "server_unavailable"));
    }
    this.pending.clear();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.spawnChild();
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "personal-ai-workbench", version: "0.1.0" }
    });
    try {
      this.writeMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    } catch {
      /* ignore */
    }
    this.initialized = true;
  }

  private spawnChild(): void {
    if (this.child) return;
    try {
      this.child = spawn(this.command, this.args, {
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      throw new McpClientUnavailableError(
        error instanceof Error ? error.message : "Failed to spawn MCP stdio process.",
        "server_unavailable"
      );
    }
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", () => {
      /* diagnostics only — never echo secrets */
    });
    this.child.on("error", (error) => {
      for (const [, waiter] of this.pending) {
        waiter.reject(
          new McpClientUnavailableError(error.message, "server_unavailable")
        );
      }
      this.pending.clear();
    });
    this.child.on("close", () => {
      if (!this.closed) {
        for (const [, waiter] of this.pending) {
          waiter.reject(
            new McpClientUnavailableError("MCP stdio process exited.", "server_unavailable")
          );
        }
        this.pending.clear();
      }
      this.child = null;
      this.initialized = false;
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(body) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (parsed.id == null) continue;
      const id = Number(parsed.id);
      const waiter = this.pending.get(id);
      if (!waiter) continue;
      this.pending.delete(id);
      if (parsed.error) {
        waiter.reject(
          new McpClientUnavailableError(
            parsed.error.message ?? "MCP JSON-RPC error.",
            "server_unavailable"
          )
        );
      } else {
        waiter.resolve(parsed.result);
      }
    }
  }

  private writeMessage(message: unknown): void {
    if (!this.child?.stdin.writable) {
      throw new McpClientUnavailableError("MCP stdio stdin is not writable.", "server_unavailable");
    }
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8"),
      payload
    ]);
    this.child.stdin.write(frame);
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new McpClientUnavailableError("MCP stdio client closed.", "server_unavailable")
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.writeMessage({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

// ── Factory helpers ──────────────────────────────────────────────────────────

export function createHttpMcpClient(
  connection: McpConnection,
  secrets: McpVaultSecrets
): HttpMcpClient {
  if (!connection.url) {
    throw new McpClientUnavailableError("HTTP MCP connection is missing url.", "server_unavailable");
  }
  const headers: Record<string, string> = {};
  if (secrets.authToken) {
    headers.Authorization = secrets.authToken.startsWith("Bearer ")
      ? secrets.authToken
      : `Bearer ${secrets.authToken}`;
  }
  return new HttpMcpClient(connection.url, headers);
}

export function createStdioMcpClient(
  connection: McpConnection,
  secrets: McpVaultSecrets
): StdioMcpClient {
  if (!connection.command) {
    throw new McpClientUnavailableError("stdio MCP connection is missing command.", "server_unavailable");
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (secrets.env && typeof secrets.env === "object") {
    for (const [key, value] of Object.entries(secrets.env)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  return new StdioMcpClient(connection.command, connection.args ?? [], env);
}

function normalizeTools(result: unknown): McpToolDescriptor[] {
  const record = asRecord(result);
  const tools = Array.isArray(record?.tools) ? record!.tools : Array.isArray(result) ? result : [];
  const out: McpToolDescriptor[] = [];
  for (const entry of tools) {
    const tool = asRecord(entry);
    if (!tool || typeof tool.name !== "string") continue;
    const descriptor: McpToolDescriptor = { name: tool.name };
    if (typeof tool.description === "string") descriptor.description = tool.description;
    if (tool.inputSchema && typeof tool.inputSchema === "object") {
      descriptor.inputSchema = tool.inputSchema as Record<string, unknown>;
    }
    out.push(descriptor);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
