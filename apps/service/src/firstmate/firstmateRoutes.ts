/**
 * Firstmate self-management HTTP routes (Task 36).
 *
 * Mount later from main / app.ts (owned by another agent):
 *
 *   import { createFirstmateRouter } from "../firstmate/firstmateRoutes.js";
 *   app.use(createFirstmateRouter({ firstmate: selfManagement }));
 *
 * This module intentionally does NOT edit app.ts.
 *
 * Routes:
 * - GET    /api/firstmate/tools
 * - GET    /api/firstmate/tools/:toolName
 * - POST   /api/firstmate/tools/:toolName/invoke
 * - GET    /api/firstmate/audit
 * - GET    /api/firstmate/audit/:auditId
 * - GET    /api/firstmate/roles
 * - GET    /api/firstmate/roles/schema
 * - GET    /api/firstmate/roles/:roleId
 * - POST   /api/firstmate/roles
 * - PATCH  /api/firstmate/roles/:roleId
 * - DELETE /api/firstmate/roles/:roleId
 * - GET    /api/firstmate/temporary-agents
 * - GET    /api/firstmate/temporary-agents/:id
 * - POST   /api/firstmate/temporary-agents
 * - DELETE /api/firstmate/temporary-agents/:id
 * - GET    /api/firstmate/runtimes
 * - GET    /api/firstmate/runtimes/:harness
 * - GET    /api/firstmate/connections
 * - GET    /api/firstmate/connections/:connectionId
 * - GET    /api/firstmate/skills
 * - GET    /api/firstmate/skills/:skillId
 * - GET    /api/firstmate/tools-catalog
 * - GET    /api/firstmate/tools-catalog/:toolId
 * - GET    /api/firstmate/projects
 * - GET    /api/firstmate/projects/:projectId
 * - GET    /api/firstmate/runs
 * - GET    /api/firstmate/runs/:runId
 * - GET    /api/firstmate/queue
 */

import { Router, type Request, type Response } from "express";
import type { FirstmateSelfManagementService } from "./firstmateSelfManagementService.js";
import {
  getFirstmateToolSpec,
  invokeFirstmateTool,
  listFirstmateToolSpecs
} from "./firstmateTools.js";
import type {
  CreateRoleToolInput,
  CreateTemporaryAgentInput,
  RemoveRoleToolInput,
  UpdateRoleToolInput
} from "./firstmateTypes.js";

export interface FirstmateRouteDeps {
  firstmate: FirstmateSelfManagementService;
}

export function createFirstmateRouter(deps: FirstmateRouteDeps): Router {
  const router = Router();
  const { firstmate } = deps;

  // ── Tool catalog + invoke ────────────────────────────────────────────────

  router.get("/api/firstmate/tools", (_request: Request, response: Response) => {
    response.json({
      tools: listFirstmateToolSpecs(),
      mutationWorkflow: ["read", "schema", "patch", "verify"],
      notes: [
        "Long-term Role create/update/remove require userRequested=true.",
        "Built-in Firstmate cannot be deleted.",
        "Secrets are never returned from connection discovery."
      ]
    });
  });

  router.get("/api/firstmate/tools/:toolName", (request: Request, response: Response) => {
    try {
      response.json(getFirstmateToolSpec(routeParam(request.params.toolName)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unknown tool.") });
    }
  });

  router.post("/api/firstmate/tools/:toolName/invoke", async (request: Request, response: Response) => {
    try {
      const toolName = routeParam(request.params.toolName);
      const args =
        request.body && typeof request.body === "object" && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const result = await invokeFirstmateTool(firstmate, toolName, args);
      response.status(result.ok ? 200 : statusForCode(result.code)).json(result);
    } catch (error) {
      response.status(statusFor(error)).json({
        ok: false,
        error: errorMessage(error, "Unable to invoke Firstmate tool.")
      });
    }
  });

  // ── Audit ────────────────────────────────────────────────────────────────

  router.get("/api/firstmate/audit", (request: Request, response: Response) => {
    try {
      const limit = parseLimit(request.query.limit, 100);
      response.json({ audit: firstmate.listAudit(limit) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list audit.") });
    }
  });

  router.get("/api/firstmate/audit/:auditId", (request: Request, response: Response) => {
    try {
      response.json(firstmate.getAudit(routeParam(request.params.auditId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load audit.") });
    }
  });

  // ── Roles (REST convenience over tools) ──────────────────────────────────

  router.get("/api/firstmate/roles", async (_request: Request, response: Response) => {
    try {
      response.json({ roles: await firstmate.listRoles() });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list roles.") });
    }
  });

  router.get("/api/firstmate/roles/schema", (_request: Request, response: Response) => {
    response.json(firstmate.roleSchema());
  });

  router.get("/api/firstmate/roles/:roleId", async (request: Request, response: Response) => {
    try {
      response.json(await firstmate.getRole(routeParam(request.params.roleId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load role.") });
    }
  });

  router.post("/api/firstmate/roles", async (request: Request, response: Response) => {
    try {
      const input = parseCreateRole(request.body);
      const result = await firstmate.createRole(input);
      response.status(result.ok ? 201 : statusForCode(result.code)).json(result);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to create role.") });
    }
  });

  router.patch("/api/firstmate/roles/:roleId", async (request: Request, response: Response) => {
    try {
      const input = parseUpdateRole(routeParam(request.params.roleId), request.body);
      const result = await firstmate.updateRole(input);
      response.status(result.ok ? 200 : statusForCode(result.code)).json(result);
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to update role.") });
    }
  });

  router.delete("/api/firstmate/roles/:roleId", async (request: Request, response: Response) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const input: RemoveRoleToolInput = {
        roleId: routeParam(request.params.roleId),
        reason: typeof body.reason === "string" ? body.reason : undefined,
        actor: typeof body.actor === "string" ? body.actor : undefined,
        userRequested: body.userRequested === true
      };
      const result = await firstmate.removeRole(input);
      response.status(result.ok ? 200 : statusForCode(result.code)).json(result);
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to remove role.") });
    }
  });

  // ── Temporary agents ─────────────────────────────────────────────────────

  router.get("/api/firstmate/temporary-agents", (_request: Request, response: Response) => {
    response.json({ temporaryAgents: firstmate.listTemporaryAgents() });
  });

  router.get("/api/firstmate/temporary-agents/:id", (request: Request, response: Response) => {
    try {
      response.json(firstmate.getTemporaryAgent(routeParam(request.params.id)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load temporary agent.") });
    }
  });

  router.post("/api/firstmate/temporary-agents", (request: Request, response: Response) => {
    try {
      const result = firstmate.createTemporaryAgent(parseTemporary(request.body));
      response.status(result.ok ? 201 : statusForCode(result.code)).json(result);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to create temporary agent.") });
    }
  });

  router.delete("/api/firstmate/temporary-agents/:id", (request: Request, response: Response) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const result = firstmate.removeTemporaryAgent(routeParam(request.params.id), {
        reason: typeof body.reason === "string" ? body.reason : undefined,
        actor: typeof body.actor === "string" ? body.actor : undefined
      });
      response.status(result.ok ? 200 : statusForCode(result.code)).json(result);
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to remove temporary agent.") });
    }
  });

  // ── Discovery ────────────────────────────────────────────────────────────

  router.get("/api/firstmate/runtimes", async (_request: Request, response: Response) => {
    try {
      response.json({ runtimes: await firstmate.listRuntimes() });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list runtimes.") });
    }
  });

  router.get("/api/firstmate/runtimes/:harness", async (request: Request, response: Response) => {
    try {
      response.json(await firstmate.getRuntime(routeParam(request.params.harness)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load runtime.") });
    }
  });

  router.get("/api/firstmate/connections", async (_request: Request, response: Response) => {
    try {
      response.json({ connections: await firstmate.listConnections() });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list connections.") });
    }
  });

  router.get("/api/firstmate/connections/:connectionId", async (request: Request, response: Response) => {
    try {
      response.json(await firstmate.getConnection(routeParam(request.params.connectionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load connection.") });
    }
  });

  router.get("/api/firstmate/skills", (_request: Request, response: Response) => {
    try {
      response.json({ skills: firstmate.listSkills() });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list skills.") });
    }
  });

  router.get("/api/firstmate/skills/:skillId", (request: Request, response: Response) => {
    try {
      response.json(firstmate.getSkill(routeParam(request.params.skillId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load skill.") });
    }
  });

  router.get("/api/firstmate/tools-catalog", (_request: Request, response: Response) => {
    try {
      response.json({ tools: firstmate.listTools() });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list tools.") });
    }
  });

  router.get("/api/firstmate/tools-catalog/:toolId", (request: Request, response: Response) => {
    try {
      response.json(firstmate.getTool(routeParam(request.params.toolId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load tool.") });
    }
  });

  router.get("/api/firstmate/projects", async (_request: Request, response: Response) => {
    try {
      response.json({ projects: await firstmate.listProjects() });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list projects.") });
    }
  });

  router.get("/api/firstmate/projects/:projectId", async (request: Request, response: Response) => {
    try {
      response.json(await firstmate.getProject(routeParam(request.params.projectId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load project.") });
    }
  });

  router.get("/api/firstmate/runs", async (request: Request, response: Response) => {
    try {
      const limit = parseLimit(request.query.limit, 50);
      response.json({ runs: await firstmate.listRuns(limit) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list runs.") });
    }
  });

  router.get("/api/firstmate/runs/:runId", async (request: Request, response: Response) => {
    try {
      response.json(await firstmate.getRun(routeParam(request.params.runId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load run.") });
    }
  });

  router.get("/api/firstmate/queue", async (_request: Request, response: Response) => {
    try {
      response.json(await firstmate.queueStatus());
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load queue status.") });
    }
  });

  return router;
}

/** Minimal Express app factory for route unit tests (does not touch app.ts). */
export async function createFirstmateRouteApp(
  deps: FirstmateRouteDeps
): Promise<import("express").Express> {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(createFirstmateRouter(deps));
  return app;
}

// ── Parsers / helpers ────────────────────────────────────────────────────────

function parseCreateRole(body: unknown): CreateRoleToolInput {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    name: String(value.name ?? ""),
    responsibility: String(value.responsibility ?? ""),
    systemInstruction: String(value.systemInstruction ?? ""),
    connectionId: value.connectionId === null ? null : typeof value.connectionId === "string" ? value.connectionId : undefined,
    modelId: value.modelId === null ? null : typeof value.modelId === "string" ? value.modelId : undefined,
    harness: value.harness as CreateRoleToolInput["harness"],
    reasoningEffort: value.reasoningEffort as CreateRoleToolInput["reasoningEffort"],
    skills: Array.isArray(value.skills) ? value.skills.filter((s): s is string => typeof s === "string") : [],
    tools: Array.isArray(value.tools) ? value.tools.filter((s): s is string => typeof s === "string") : [],
    permissions: value.permissions as CreateRoleToolInput["permissions"],
    allowFirstmateAutoInvoke: value.allowFirstmateAutoInvoke === true,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    actor: typeof value.actor === "string" ? value.actor : undefined,
    userRequested: value.userRequested === true
  };
}

function parseUpdateRole(roleId: string, body: unknown): UpdateRoleToolInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const patch =
    value.patch && typeof value.patch === "object" && !Array.isArray(value.patch)
      ? (value.patch as UpdateRoleToolInput["patch"])
      : (value as UpdateRoleToolInput["patch"]);
  // When body uses flat patch fields (name/enabled/...), strip control keys.
  const {
    userRequested: _u,
    reason: _r,
    actor: _a,
    patch: _p,
    roleId: _id,
    ...flat
  } = value;
  const resolvedPatch =
    value.patch && typeof value.patch === "object"
      ? patch
      : (flat as UpdateRoleToolInput["patch"]);
  return {
    roleId,
    patch: resolvedPatch,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    actor: typeof value.actor === "string" ? value.actor : undefined,
    userRequested: value.userRequested === true
  };
}

function parseTemporary(body: unknown): CreateTemporaryAgentInput {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    name: String(value.name ?? ""),
    responsibility: String(value.responsibility ?? ""),
    systemInstruction: typeof value.systemInstruction === "string" ? value.systemInstruction : undefined,
    avatar:
      value.avatar && typeof value.avatar === "object" && !Array.isArray(value.avatar)
        ? (value.avatar as CreateTemporaryAgentInput["avatar"])
        : undefined,
    connectionId: value.connectionId === null ? null : typeof value.connectionId === "string" ? value.connectionId : undefined,
    modelId: value.modelId === null ? null : typeof value.modelId === "string" ? value.modelId : undefined,
    harness: value.harness as CreateTemporaryAgentInput["harness"],
    reasoningEffort: value.reasoningEffort as CreateTemporaryAgentInput["reasoningEffort"],
    skills: Array.isArray(value.skills) ? value.skills.filter((s): s is string => typeof s === "string") : undefined,
    tools: Array.isArray(value.tools) ? value.tools.filter((s): s is string => typeof s === "string") : undefined,
    permissions:
      value.permissions && typeof value.permissions === "object"
        ? (value.permissions as CreateTemporaryAgentInput["permissions"])
        : undefined,
    allowFirstmateAutoInvoke:
      value.allowFirstmateAutoInvoke === undefined ? undefined : value.allowFirstmateAutoInvoke === true,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    actor: typeof value.actor === "string" ? value.actor : undefined
  };
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

function parseLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = Array.isArray(value) ? value[0] : value;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new Error("limit must be a positive number.");
  return Math.floor(n);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function statusFor(error: unknown): number {
  if (error && typeof error === "object" && "code" in error) {
    return statusForCode(String((error as { code?: string }).code));
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("was not found") || msg.includes("not found")) return 404;
    if (msg.includes("not configured")) return 503;
  }
  return 400;
}

function statusForCode(code?: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "user_request_required":
    case "builtin_protected":
    case "forbidden":
      return 403;
    case "unavailable":
      return 503;
    case "invalid_input":
      return 400;
    default:
      return 400;
  }
}
