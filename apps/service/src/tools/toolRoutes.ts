/**
 * Tool Registry HTTP routes (Task 22).
 *
 * Mount later from main / app.ts (owned by another agent):
 *
 *   import { createToolRouter } from "../tools/toolRoutes.js";
 *   app.use(createToolRouter({ tools }));
 *
 * This module intentionally does NOT edit app.ts.
 *
 * Routes:
 * - GET    /api/tools
 * - GET    /api/tools/categories
 * - GET    /api/tools/:toolId
 * - POST   /api/tools/register
 * - POST   /api/tools/:toolId/enable
 * - POST   /api/tools/:toolId/disable
 * - POST   /api/tools/:toolId/trust
 */

import { Router, type Request, type Response } from "express";
import type { ToolRegistry } from "./toolRegistry.js";
import {
  TOOL_PERMISSION_CATEGORIES,
  type RegisterToolInput,
  type ToolPermissionCategory
} from "./toolTypes.js";

export interface ToolRouteDeps {
  tools: ToolRegistry;
}

export function createToolRouter(deps: ToolRouteDeps): Router {
  const router = Router();

  router.get("/api/tools", (request: Request, response: Response) => {
    try {
      const category = parseCategory(request.query.category);
      const enabled = parseOptionalBoolean(request.query.enabled);
      const trusted = parseOptionalBoolean(request.query.trusted);
      response.json({
        tools: deps.tools.list({
          category,
          enabled,
          trusted
        }),
        categories: deps.tools.categories()
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list tools.") });
    }
  });

  router.get("/api/tools/categories", (_request: Request, response: Response) => {
    response.json({ categories: [...TOOL_PERMISSION_CATEGORIES] });
  });

  router.get("/api/tools/:toolId", (request: Request, response: Response) => {
    try {
      response.json(deps.tools.get(routeParam(request.params.toolId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load tool.") });
    }
  });

  router.post("/api/tools/register", async (request: Request, response: Response) => {
    try {
      const input = parseRegister(request.body);
      const tool = await deps.tools.register(input);
      response.status(201).json(tool);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to register tool.") });
    }
  });

  router.post("/api/tools/:toolId/enable", async (request: Request, response: Response) => {
    try {
      response.json(await deps.tools.setEnabled(routeParam(request.params.toolId), true));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to enable tool.") });
    }
  });

  router.post("/api/tools/:toolId/disable", async (request: Request, response: Response) => {
    try {
      response.json(await deps.tools.setEnabled(routeParam(request.params.toolId), false));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to disable tool.") });
    }
  });

  router.post("/api/tools/:toolId/trust", async (request: Request, response: Response) => {
    try {
      response.json(await deps.tools.trust(routeParam(request.params.toolId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to trust tool.") });
    }
  });

  return router;
}

/** Minimal Express app factory for route unit tests. */
export async function createToolRouteApp(deps: ToolRouteDeps): Promise<import("express").Express> {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(createToolRouter(deps));
  return app;
}

function parseRegister(body: unknown): RegisterToolInput {
  const value = (body ?? {}) as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id.trim()) throw new Error("Tool id is required.");
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("Tool name is required.");
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new Error("Tool description is required.");
  }
  if (typeof value.category !== "string" || !isCategory(value.category)) {
    throw new Error(`Tool category is invalid. Expected: ${TOOL_PERMISSION_CATEGORIES.join(", ")}.`);
  }
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    description: value.description.trim(),
    version: typeof value.version === "string" ? value.version : undefined,
    category: value.category,
    source: value.source === "mcp" || value.source === "registered" || value.source === "builtin"
      ? value.source
      : "registered",
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    trusted: typeof value.trusted === "boolean" ? value.trusted : undefined,
    requiresApproval: typeof value.requiresApproval === "boolean" ? value.requiresApproval : undefined,
    inputSchema:
      value.inputSchema && typeof value.inputSchema === "object" && !Array.isArray(value.inputSchema)
        ? (value.inputSchema as Record<string, unknown>)
        : undefined,
    tags: Array.isArray(value.tags)
      ? value.tags.filter((entry): entry is string => typeof entry === "string")
      : undefined
  };
}

function parseCategory(value: unknown): ToolPermissionCategory | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !isCategory(raw)) {
    throw new Error(`Invalid tool category. Expected: ${TOOL_PERMISSION_CATEGORIES.join(", ")}.`);
  }
  return raw;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === true || raw === "true" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "0") return false;
  throw new Error("Boolean query parameter is invalid.");
}

function isCategory(value: string): value is ToolPermissionCategory {
  return (TOOL_PERMISSION_CATEGORIES as readonly string[]).includes(value);
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (/not found/i.test(message)) return 404;
  return 400;
}
