/**
 * Injectable Fake MCP Server for TDD (Task 24).
 * Covers discovery, call, failure, and cancel paths without real processes.
 */

import {
  McpClientUnavailableError,
  type McpClient,
  type McpClientCallOptions,
  type McpClientToolResult
} from "./mcpClient.js";
import type { McpToolDescriptor } from "./mcpTypes.js";

export type FakeToolHandler = (
  args: Record<string, unknown>,
  options?: McpClientCallOptions
) => Promise<McpClientToolResult> | McpClientToolResult;

export interface FakeMcpServerOptions {
  tools?: McpToolDescriptor[];
  handlers?: Record<string, FakeToolHandler>;
  /** Artificial delay applied to list/call (ms). */
  delayMs?: number;
}

/**
 * In-memory MCP server stand-in. Register with FakeMcpRegistry and pass
 * transport: "fake" + fakeServerId when creating connections in tests.
 */
export class FakeMcpServer implements McpClient {
  tools: McpToolDescriptor[];
  handlers: Map<string, FakeToolHandler>;
  delayMs: number;

  /** When set, next listTools() rejects with this error (consumed once). */
  failNextList?: Error;
  /** When set, next callTool() rejects with this error (consumed once). */
  failNextCall?: Error;
  /** Permanent list failure until cleared. */
  listError?: Error;
  /** Permanent call failure until cleared. */
  callError?: Error;

  listCalls = 0;
  callLog: Array<{ name: string; args: Record<string, unknown> }> = [];
  /** Session close count (shared registry servers remain usable after close). */
  closeCount = 0;
  /**
   * When true, list/call fail as unavailable.
   * Prefer `shutdown()` over `close()` for permanent unavailability in tests —
   * `close()` is a session no-op so shared Fake instances can be reused.
   */
  unavailable = false;

  constructor(options: FakeMcpServerOptions = {}) {
    this.tools = options.tools ? [...options.tools] : [];
    this.handlers = new Map(Object.entries(options.handlers ?? {}));
    this.delayMs = options.delayMs ?? 0;
  }

  setTools(tools: McpToolDescriptor[]): void {
    this.tools = [...tools];
  }

  setHandler(name: string, handler: FakeToolHandler): void {
    this.handlers.set(name, handler);
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    this.listCalls += 1;
    await this.maybeDelay(undefined);
    if (this.failNextList) {
      const err = this.failNextList;
      this.failNextList = undefined;
      throw err;
    }
    if (this.listError) throw this.listError;
    if (this.unavailable) {
      throw new McpClientUnavailableError("Fake MCP server is unavailable.", "server_unavailable");
    }
    return this.tools.map((tool) => ({ ...tool, inputSchema: tool.inputSchema ? structuredClone(tool.inputSchema) : undefined }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpClientCallOptions
  ): Promise<McpClientToolResult> {
    this.callLog.push({ name, args: structuredClone(args) });
    await this.maybeDelay(options?.signal);
    if (options?.signal?.aborted) {
      throw abortError();
    }
    if (this.failNextCall) {
      const err = this.failNextCall;
      this.failNextCall = undefined;
      throw err;
    }
    if (this.callError) throw this.callError;
    if (this.unavailable) {
      throw new McpClientUnavailableError("Fake MCP server is unavailable.", "server_unavailable");
    }

    const handler = this.handlers.get(name);
    if (!handler) {
      const known = this.tools.find((tool) => tool.name === name);
      if (!known) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return { content: { ok: true, tool: name, args } };
    }

    const result = await handler(args, options);
    if (options?.signal?.aborted) {
      throw abortError();
    }
    return result;
  }

  /**
   * Session close — shared Fake servers stay available for the next openClient().
   * Use `shutdown()` to simulate permanent server death.
   */
  async close(): Promise<void> {
    this.closeCount += 1;
  }

  /** Mark the shared Fake permanently unavailable (simulates process exit). */
  shutdown(): void {
    this.unavailable = true;
  }

  /** Re-enable after shutdown (test helper). */
  restore(): void {
    this.unavailable = false;
  }

  private async maybeDelay(signal?: AbortSignal): Promise<void> {
    if (this.delayMs <= 0) {
      if (signal?.aborted) throw abortError();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, this.delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(abortError());
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** Simple id → FakeMcpServer map for test client factories. */
export class FakeMcpRegistry {
  private readonly servers = new Map<string, FakeMcpServer>();

  register(id: string, server: FakeMcpServer): void {
    this.servers.set(id, server);
  }

  get(id: string): FakeMcpServer | undefined {
    return this.servers.get(id);
  }

  resolve(id: string): FakeMcpServer | undefined {
    return this.servers.get(id);
  }

  clear(): void {
    this.servers.clear();
  }
}

/**
 * Build a factory that resolves transport "fake" via the given registry
 * and fails other transports unless overridden.
 */
export function createFakeMcpClientFactory(registry: FakeMcpRegistry) {
  return async (connection: { transport: string; id: string }, secrets: { fakeServerId?: string }) => {
    if (connection.transport !== "fake") {
      throw new McpClientUnavailableError(
        `Fake factory does not support transport “${connection.transport}”.`,
        "server_unavailable"
      );
    }
    const id = secrets.fakeServerId ?? connection.id;
    const server = registry.resolve(id);
    if (!server) {
      throw new McpClientUnavailableError(`Fake MCP server “${id}” is not registered.`, "server_unavailable");
    }
    return server;
  };
}
