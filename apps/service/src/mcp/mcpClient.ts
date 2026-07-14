/**
 * Injectable MCP client contract.
 * Production code may later wrap @modelcontextprotocol/sdk transports;
 * tests inject FakeMcpServer via McpClientFactory.
 */

import type { McpConnection, McpToolDescriptor, McpVaultSecrets } from "./mcpTypes.js";

export interface McpClientCallOptions {
  signal?: AbortSignal;
}

export interface McpClientToolResult {
  content: unknown;
  isError?: boolean;
}

/**
 * Minimal client surface used by McpService:
 * list tools, call a tool, optional close.
 */
export interface McpClient {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpClientCallOptions
  ): Promise<McpClientToolResult>;
  close?(): Promise<void>;
}

export type McpClientFactory = (
  connection: McpConnection,
  secrets: McpVaultSecrets
) => Promise<McpClient>;

/**
 * Default factory: fake transport for tests; real HTTP / stdio for production.
 */
export function createDefaultMcpClientFactory(
  resolveFake?: (id: string) => McpClient | undefined
): McpClientFactory {
  return async (connection, secrets) => {
    if (connection.transport === "fake") {
      const id = secrets.fakeServerId ?? connection.id;
      const client = resolveFake?.(id);
      if (!client) {
        throw new McpClientUnavailableError(
          `Fake MCP server “${id}” is not registered.`,
          "server_unavailable"
        );
      }
      return client;
    }
    if (connection.transport === "http") {
      const { createHttpMcpClient } = await import("./mcpHttpStdioClients.js");
      return createHttpMcpClient(connection, secrets);
    }
    if (connection.transport === "stdio") {
      const { createStdioMcpClient } = await import("./mcpHttpStdioClients.js");
      return createStdioMcpClient(connection, secrets);
    }
    throw new McpClientUnavailableError(
      `Unsupported MCP transport: ${String((connection as McpConnection).transport)}`,
      "server_unavailable"
    );
  };
}

export type McpClientFailureKind = "server_unavailable" | "authentication_failed" | "network_failed";

export class McpClientUnavailableError extends Error {
  readonly kind: McpClientFailureKind;

  constructor(message: string, kind: McpClientFailureKind = "server_unavailable") {
    super(message);
    this.name = "McpClientUnavailableError";
    this.kind = kind;
  }
}
