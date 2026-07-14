/**
 * HTTP routes for Firstmate Role Router (Task 20).
 *
 * Mount later from main / app.ts (owned by another agent):
 *
 *   import { createRoutingRouter } from "../routing/routingRoutes.js";
 *   app.use(createRoutingRouter({ roleRouter }));
 *
 * This module intentionally does NOT edit app.ts.
 *
 * Routes:
 * - POST   /api/routing/decisions              — route roles for a plan/task
 * - GET    /api/routing/decisions              — list recent decisions
 * - GET    /api/routing/decisions/:decisionId  — fetch one decision (role/model/harness/reason)
 * - POST   /api/routing/decisions/:decisionId/override
 * - POST   /api/routing/decisions/:decisionId/confirm-temporary
 * - GET    /api/routing/temporary/:temporaryRoleId
 */

import { Router, type Request, type Response } from "express";
import type {
  ConfirmTemporaryInput,
  OverrideInput,
  RoleRouterService,
  RouteRequest
} from "./roleRouterService.js";

export interface RoutingRouteDeps {
  roleRouter: RoleRouterService;
}

export function createRoutingRouter(deps: RoutingRouteDeps): Router {
  const router = Router();

  router.post("/api/routing/decisions", async (request: Request, response: Response) => {
    try {
      const body = parseRouteRequest(request.body);
      const decision = await deps.roleRouter.route(body);
      response.status(201).json(decision);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to route Agent Roles.") });
    }
  });

  router.get("/api/routing/decisions", async (_request: Request, response: Response) => {
    try {
      response.json(deps.roleRouter.listDecisions());
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list routing decisions.") });
    }
  });

  router.get("/api/routing/decisions/:decisionId", async (request: Request, response: Response) => {
    try {
      response.json(deps.roleRouter.getDecision(routeParam(request.params.decisionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load routing decision.") });
    }
  });

  router.post("/api/routing/decisions/:decisionId/override", async (request: Request, response: Response) => {
    try {
      const input = parseOverride(request.body);
      const decision = await deps.roleRouter.override(routeParam(request.params.decisionId), input);
      response.json(decision);
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to override role selection.") });
    }
  });

  router.post("/api/routing/decisions/:decisionId/confirm-temporary", async (request: Request, response: Response) => {
    try {
      const input = parseConfirmTemporary(request.body);
      const result = await deps.roleRouter.confirmTemporaryAsLongTerm(
        routeParam(request.params.decisionId),
        input
      );
      response.json(result);
    } catch (error) {
      response.status(statusFor(error)).json({
        error: errorMessage(error, "Unable to confirm temporary Role.")
      });
    }
  });

  router.get("/api/routing/temporary/:temporaryRoleId", async (request: Request, response: Response) => {
    try {
      response.json(deps.roleRouter.getTemporaryRole(routeParam(request.params.temporaryRoleId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load temporary Role.") });
    }
  });

  return router;
}

function parseRouteRequest(body: unknown): RouteRequest {
  const value = (body ?? {}) as Record<string, unknown>;
  const list = (key: string) =>
    Array.isArray(value[key]) ? value[key].filter((entry): entry is string => typeof entry === "string") : undefined;
  const text = (key: string) => (typeof value[key] === "string" ? value[key] : undefined);
  const bool = (key: string) => (typeof value[key] === "boolean" ? value[key] : undefined);

  const harness = value.preferredHarness === "api" || value.preferredHarness === "codex-cli"
    ? value.preferredHarness
    : undefined;
  const complexity =
    value.complexity === "low" || value.complexity === "medium" || value.complexity === "high"
      ? value.complexity
      : undefined;
  const taskType = typeof value.taskType === "string" ? (value.taskType as RouteRequest["taskType"]) : undefined;

  let instances: RouteRequest["instances"];
  if (value.instances !== undefined) {
    if (!Array.isArray(value.instances)) throw new Error("instances must be an array.");
    instances = value.instances.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`instances[${index}] is invalid.`);
      }
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" && item.id.trim() ? item.id : `instance-${index + 1}`;
      return {
        id,
        name: typeof item.name === "string" ? item.name : undefined,
        capabilities: Array.isArray(item.capabilities)
          ? item.capabilities.filter((c): c is string => typeof c === "string")
          : undefined,
        skills: Array.isArray(item.skills) ? item.skills.filter((c): c is string => typeof c === "string") : undefined,
        tools: Array.isArray(item.tools) ? item.tools.filter((c): c is string => typeof c === "string") : undefined,
        harness: item.harness === "api" || item.harness === "codex-cli" ? item.harness : undefined,
        permissions: parsePartialPermissions(item.permissions),
        reasoningEffort:
          item.reasoningEffort === "low" || item.reasoningEffort === "medium" || item.reasoningEffort === "high"
            ? item.reasoningEffort
            : undefined,
        responsibilityHint: typeof item.responsibilityHint === "string" ? item.responsibilityHint : undefined,
        systemInstructionHint: typeof item.systemInstructionHint === "string" ? item.systemInstructionHint : undefined
      };
    });
  }

  return {
    runId: text("runId"),
    todoId: text("todoId"),
    taskType,
    complexity,
    requiredCapabilities: list("requiredCapabilities"),
    requiredSkills: list("requiredSkills"),
    requiredTools: list("requiredTools"),
    preferredHarness: harness,
    requiredPermissions: parsePartialPermissions(value.requiredPermissions),
    explicitRoleId: text("explicitRoleId"),
    instances,
    planApproved: bool("planApproved"),
    verifyAvailability: bool("verifyAvailability"),
    defaultConnectionId: text("defaultConnectionId"),
    defaultModelId: text("defaultModelId")
  };
}

function parsePartialPermissions(value: unknown): RouteRequest["requiredPermissions"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("requiredPermissions is invalid.");
  }
  const p = value as Record<string, unknown>;
  const out: NonNullable<RouteRequest["requiredPermissions"]> = {};
  if (p.workspace === "project_only" || p.workspace === "read_only") out.workspace = p.workspace;
  if (typeof p.network === "boolean") out.network = p.network;
  if (typeof p.shell === "boolean") out.shell = p.shell;
  if (typeof p.externalSend === "boolean") out.externalSend = p.externalSend;
  return out;
}

function parseOverride(body: unknown): OverrideInput {
  const value = (body ?? {}) as Record<string, unknown>;
  if (typeof value.roleId !== "string" || !value.roleId.trim()) {
    throw new Error("roleId is required for override.");
  }
  return {
    roleId: value.roleId.trim(),
    instanceId: typeof value.instanceId === "string" ? value.instanceId : undefined
  };
}

function parseConfirmTemporary(body: unknown): ConfirmTemporaryInput {
  const value = (body ?? {}) as Record<string, unknown>;
  if (typeof value.temporaryRoleId !== "string" || !value.temporaryRoleId.trim()) {
    throw new Error("temporaryRoleId is required.");
  }
  if (value.confirm !== true) {
    throw new Error("Confirm before saving a temporary Role into the long-term library.");
  }
  return {
    temporaryRoleId: value.temporaryRoleId.trim(),
    confirm: true,
    name: typeof value.name === "string" ? value.name : undefined
  };
}

function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (/was not found/i.test(message)) return 404;
  return 400;
}
