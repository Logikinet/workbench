/**
 * MCP connection HTTP routes (Task 24).
 *
 * ## Mount points for main agent (apps/service/src/http/app.ts or main.ts)
 *
 * ```ts
 * import { mountMcpRoutes } from "../mcp/mcpRoutes.js";
 * import { McpService } from "../mcp/mcpService.js";
 *
 * // After McpService.open(...):
 * if (options.mcp) {
 *   mountMcpRoutes(app, options.mcp);
 * }
 * ```
 *
 * Routes:
 * - GET    /api/mcp/connections
 * - POST   /api/mcp/connections
 * - GET    /api/mcp/connections/:id
 * - PATCH  /api/mcp/connections/:id
 * - DELETE /api/mcp/connections/:id
 * - POST   /api/mcp/connections/:id/test
 * - GET    /api/mcp/connections/:id/tools
 * - POST   /api/mcp/connections/:id/tools/:toolName/call
 * - GET    /api/mcp/role-bindings
 * - GET    /api/mcp/role-bindings/:roleId
 * - PUT    /api/mcp/role-bindings/:roleId
 * - GET    /api/mcp/roles/:roleId/tools
 * - GET    /api/mcp/export-snapshot   (secret-free backup helper)
 */

import type { Express } from "express";
import { McpService, toPublicMcpConnection } from "./mcpService.js";
import type {
  CreateMcpConnectionInput,
  McpCallContext,
  McpToolRef,
  RolePermissionsLike,
  UpdateMcpConnectionInput
} from "./mcpTypes.js";

export function mountMcpRoutes(app: Express, mcp: McpService): void {
  app.get("/api/mcp/connections", async (_request, response) => {
    try {
      response.json(await mcp.listPublic());
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list MCP connections.") });
    }
  });

  app.post("/api/mcp/connections", async (request, response) => {
    try {
      const created = await mcp.create(parseCreateBody(request.body));
      response.status(201).json(toPublicMcpConnection(created));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to create MCP connection.") });
    }
  });

  app.get("/api/mcp/connections/:connectionId", async (request, response) => {
    try {
      response.json(await mcp.getPublic(request.params.connectionId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to load MCP connection.") });
    }
  });

  app.patch("/api/mcp/connections/:connectionId", async (request, response) => {
    try {
      const updated = await mcp.update(request.params.connectionId, parseUpdateBody(request.body));
      response.json(toPublicMcpConnection(updated));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to update MCP connection.") });
    }
  });

  app.delete("/api/mcp/connections/:connectionId", async (request, response) => {
    try {
      await mcp.remove(request.params.connectionId);
      response.status(204).send();
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to delete MCP connection.") });
    }
  });

  app.post("/api/mcp/connections/:connectionId/test", async (request, response) => {
    try {
      response.json(await mcp.test(request.params.connectionId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to test MCP connection.") });
    }
  });

  app.get("/api/mcp/connections/:connectionId/tools", async (request, response) => {
    try {
      const refresh = request.query.refresh === "1" || request.query.refresh === "true";
      response.json(await mcp.listTools(request.params.connectionId, { refresh }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list MCP tools.") });
    }
  });

  app.post("/api/mcp/connections/:connectionId/tools/:toolName/call", async (request, response) => {
    try {
      const args = parseArgs(request.body);
      const context = parseCallContext(request.body);
      const result = await mcp.callTool(
        request.params.connectionId,
        decodeURIComponent(request.params.toolName),
        args,
        context
      );
      response.status(result.ok ? 200 : 422).json(result);
    } catch (error) {
      // Should be rare — callTool soft-fails; this is a safety net so the workbench never crashes.
      response.status(200).json({
        ok: false,
        connectionId: request.params.connectionId,
        toolName: request.params.toolName,
        kind: "tool_error",
        message: errorMessage(error, "MCP tool call failed."),
        pauseRelatedSubtasks: false,
        durationMs: 0
      });
    }
  });

  app.get("/api/mcp/role-bindings", async (_request, response) => {
    try {
      response.json(await mcp.listRoleBindings());
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list role MCP bindings.") });
    }
  });

  app.get("/api/mcp/role-bindings/:roleId", async (request, response) => {
    try {
      response.json(await mcp.getRoleBindings(request.params.roleId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to load role MCP bindings.") });
    }
  });

  app.put("/api/mcp/role-bindings/:roleId", async (request, response) => {
    try {
      const tools = parseToolRefs(request.body);
      response.json(await mcp.setRoleBindings(request.params.roleId, tools));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to save role MCP bindings.") });
    }
  });

  app.get("/api/mcp/roles/:roleId/tools", async (request, response) => {
    try {
      response.json(await mcp.listToolsForRole(request.params.roleId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list role MCP tools.") });
    }
  });

  app.get("/api/mcp/export-snapshot", async (_request, response) => {
    try {
      response.json(await mcp.exportSnapshot());
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to export MCP snapshot.") });
    }
  });
}

function parseCreateBody(body: unknown): CreateMcpConnectionInput {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    name: asString(value.name) ?? "",
    transport: (asString(value.transport) as CreateMcpConnectionInput["transport"]) ?? "stdio",
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    command: asString(value.command),
    args: Array.isArray(value.args) ? value.args.map(String) : undefined,
    env: asStringRecord(value.env),
    url: asString(value.url),
    authToken: asString(value.authToken),
    fakeServerId: asString(value.fakeServerId)
  };
}

function parseUpdateBody(body: unknown): UpdateMcpConnectionInput {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    name: asString(value.name),
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    command: asString(value.command),
    args: Array.isArray(value.args) ? value.args.map(String) : undefined,
    env: value.env === undefined ? undefined : asStringRecord(value.env) ?? {},
    url: asString(value.url),
    authToken: asString(value.authToken),
    clearSecrets: value.clearSecrets === true,
    fakeServerId: asString(value.fakeServerId)
  };
}

function parseArgs(body: unknown): Record<string, unknown> {
  const value = (body ?? {}) as Record<string, unknown>;
  if (value.args && typeof value.args === "object" && !Array.isArray(value.args)) {
    return value.args as Record<string, unknown>;
  }
  // Allow top-level fields except known context keys
  const reserved = new Set([
    "args",
    "roleId",
    "permissions",
    "approvedDangerous",
    "workspacePath",
    "timeoutMs"
  ]);
  const args: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!reserved.has(key)) args[key] = entry;
  }
  return args;
}

function parseCallContext(body: unknown): McpCallContext {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    roleId: asString(value.roleId),
    permissions: parsePermissions(value.permissions),
    approvedDangerous: value.approvedDangerous === true,
    workspacePath: asString(value.workspacePath),
    timeoutMs: typeof value.timeoutMs === "number" && value.timeoutMs > 0 ? value.timeoutMs : undefined
  };
}

function parsePermissions(value: unknown): RolePermissionsLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const workspace = p.workspace === "read_only" ? "read_only" : "project_only";
  return {
    workspace,
    network: p.network === true,
    shell: p.shell === true,
    externalSend: p.externalSend === true
  };
}

function parseToolRefs(body: unknown): McpToolRef[] {
  const value = (body ?? {}) as Record<string, unknown>;
  const tools = value.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      return {
        connectionId: asString(row.connectionId) ?? "",
        toolName: asString(row.toolName) ?? asString(row.name) ?? ""
      };
    })
    .filter((entry) => entry.connectionId && entry.toolName);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// Silence unused Request import lint in some configs
void (null as unknown as Request);
void (null as unknown as Response);
