/**
 * HTTP routes for Firstmate Role Router (Task 20) + deterministic rules (Task 38).
 *
 * Mount later from main / app.ts (owned by another agent):
 *
 *   import { createRoutingRouter } from "../routing/routingRoutes.js";
 *   app.use(createRoutingRouter({ roleRouter, deterministicRouter }));
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
 * - GET    /api/routing/rules                  — list ordered routing rules (Task 38)
 * - PUT    /api/routing/rules                  — replace rule set
 * - POST   /api/routing/rules                  — upsert one rule
 * - DELETE /api/routing/rules/:ruleId
 * - POST   /api/routing/isolation/check        — canShareContext audit helper
 */

import { Router, type Request, type Response } from "express";
import type {
  DeterministicRouteRequest,
  DeterministicRoutingService
} from "./deterministicRoutingService.js";
import type {
  ConfirmTemporaryInput,
  OverrideInput,
  RoleRouterService,
  RouteRequest
} from "./roleRouterService.js";
import type { RoutingRuleInput } from "./routingRules.js";
import { isSessionScopeKind, type SessionScopeRef } from "./sessionScopes.js";

export interface RoutingRouteDeps {
  roleRouter: RoleRouterService;
  /** When set, decision routes prefer Task 38 deterministic routing + rules APIs. */
  deterministicRouter?: DeterministicRoutingService;
}

export function createRoutingRouter(deps: RoutingRouteDeps): Router {
  const router = Router();
  const det = deps.deterministicRouter;

  router.post("/api/routing/decisions", async (request: Request, response: Response) => {
    try {
      if (det) {
        const body = parseDeterministicRouteRequest(request.body);
        const decision = await det.route(body);
        response.status(201).json(decision);
        return;
      }
      const body = parseRouteRequest(request.body);
      const decision = await deps.roleRouter.route(body);
      response.status(201).json(decision);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to route Agent Roles.") });
    }
  });

  router.get("/api/routing/decisions", async (_request: Request, response: Response) => {
    try {
      response.json(det ? det.listDecisions() : deps.roleRouter.listDecisions());
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list routing decisions.") });
    }
  });

  router.get("/api/routing/decisions/:decisionId", async (request: Request, response: Response) => {
    try {
      const id = routeParam(request.params.decisionId);
      response.json(det ? det.getDecision(id) : deps.roleRouter.getDecision(id));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load routing decision.") });
    }
  });

  router.post("/api/routing/decisions/:decisionId/override", async (request: Request, response: Response) => {
    try {
      const input = parseOverride(request.body);
      const id = routeParam(request.params.decisionId);
      const decision = det
        ? await det.override(id, input)
        : await deps.roleRouter.override(id, input);
      response.json(decision);
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to override role selection.") });
    }
  });

  router.post("/api/routing/decisions/:decisionId/confirm-temporary", async (request: Request, response: Response) => {
    try {
      const input = parseConfirmTemporary(request.body);
      const id = routeParam(request.params.decisionId);
      const result = det
        ? await det.confirmTemporaryAsLongTerm(id, input)
        : await deps.roleRouter.confirmTemporaryAsLongTerm(id, input);
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

  // --- Task 38 rule + isolation endpoints (no-op 503 when deterministic router absent) ---

  router.get("/api/routing/rules", async (_request: Request, response: Response) => {
    if (!det) {
      response.status(503).json({ error: "Deterministic routing is not configured." });
      return;
    }
    response.json(det.listRules());
  });

  router.post("/api/routing/rules", async (request: Request, response: Response) => {
    if (!det) {
      response.status(503).json({ error: "Deterministic routing is not configured." });
      return;
    }
    try {
      const rule = det.upsertRule(parseRuleInput(request.body));
      response.status(201).json(rule);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to upsert routing rule.") });
    }
  });

  router.put("/api/routing/rules", async (request: Request, response: Response) => {
    if (!det) {
      response.status(503).json({ error: "Deterministic routing is not configured." });
      return;
    }
    try {
      if (!Array.isArray(request.body)) throw new Error("Body must be an array of routing rules.");
      const rules = det.replaceRules(request.body.map((entry, i) => parseRuleInput(entry, i)));
      response.json(rules);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to replace routing rules.") });
    }
  });

  router.delete("/api/routing/rules/:ruleId", async (request: Request, response: Response) => {
    if (!det) {
      response.status(503).json({ error: "Deterministic routing is not configured." });
      return;
    }
    try {
      response.json(det.deleteRule(routeParam(request.params.ruleId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to delete routing rule.") });
    }
  });

  router.post("/api/routing/isolation/check", async (request: Request, response: Response) => {
    if (!det) {
      response.status(503).json({ error: "Deterministic routing is not configured." });
      return;
    }
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const from = parseScope(body.from, "from");
      const to = parseScope(body.to, "to");
      response.json(det.canShareContext(from, to));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to check session isolation.") });
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

function parseDeterministicRouteRequest(body: unknown): DeterministicRouteRequest {
  const base = parseRouteRequest(body);
  const value = (body ?? {}) as Record<string, unknown>;
  const out: DeterministicRouteRequest = {
    ...base,
    projectId: typeof value.projectId === "string" ? value.projectId : undefined,
    clientProfileId: typeof value.clientProfileId === "string" ? value.clientProfileId : undefined,
    enforceManualPermissions:
      typeof value.enforceManualPermissions === "boolean" ? value.enforceManualPermissions : undefined
  };
  if (value.sessionScope !== undefined) {
    out.sessionScope = parseScope(value.sessionScope, "sessionScope");
  }
  if (value.sessionLocal !== undefined) {
    if (!value.sessionLocal || typeof value.sessionLocal !== "object" || Array.isArray(value.sessionLocal)) {
      throw new Error("sessionLocal is invalid.");
    }
    const local = value.sessionLocal as Record<string, unknown>;
    out.sessionLocal = {
      tags: Array.isArray(local.tags) ? local.tags.filter((t): t is string => typeof t === "string") : undefined,
      preferredModelId: typeof local.preferredModelId === "string" ? local.preferredModelId : undefined,
      temporaryInstructions:
        typeof local.temporaryInstructions === "string" ? local.temporaryInstructions : undefined,
      agentRoleId: typeof local.agentRoleId === "string" ? local.agentRoleId : undefined
    };
  }
  return out;
}

function parseRuleInput(body: unknown, index?: number): RoutingRuleInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(index !== undefined ? `rules[${index}] is invalid.` : "Routing rule body is invalid.");
  }
  const value = body as Record<string, unknown>;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("Rule name is required.");
  if (typeof value.order !== "number" || !Number.isFinite(value.order)) {
    throw new Error("Rule order must be a finite number.");
  }
  if (typeof value.roleId !== "string" || !value.roleId.trim()) throw new Error("Rule roleId is required.");

  let match: RoutingRuleInput["match"];
  if (value.match !== undefined) {
    if (!value.match || typeof value.match !== "object" || Array.isArray(value.match)) {
      throw new Error("Rule match is invalid.");
    }
    const m = value.match as Record<string, unknown>;
    match = {
      taskTypes: Array.isArray(m.taskTypes)
        ? (m.taskTypes.filter((t): t is string => typeof t === "string") as NonNullable<
            RoutingRuleInput["match"]
          >["taskTypes"])
        : undefined,
      projectIds: Array.isArray(m.projectIds)
        ? m.projectIds.filter((t): t is string => typeof t === "string")
        : undefined,
      requiredCapabilities: Array.isArray(m.requiredCapabilities)
        ? m.requiredCapabilities.filter((t): t is string => typeof t === "string")
        : undefined,
      requiredSkills: Array.isArray(m.requiredSkills)
        ? m.requiredSkills.filter((t): t is string => typeof t === "string")
        : undefined,
      requiredTools: Array.isArray(m.requiredTools)
        ? m.requiredTools.filter((t): t is string => typeof t === "string")
        : undefined,
      harness: m.harness === "api" || m.harness === "codex-cli" ? m.harness : undefined,
      minPermissions: parsePartialPermissions(m.minPermissions)
    };
  }

  return {
    id: typeof value.id === "string" ? value.id : undefined,
    name: value.name,
    order: value.order,
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    match,
    roleId: value.roleId,
    onInvalid: value.onInvalid === "pause" || value.onInvalid === "continue" ? value.onInvalid : undefined
  };
}

function parseScope(value: unknown, label: string): SessionScopeRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a session scope object.`);
  }
  const raw = value as Record<string, unknown>;
  if (!isSessionScopeKind(raw.kind)) {
    throw new Error(`${label}.kind is invalid.`);
  }
  return {
    kind: raw.kind,
    projectId: typeof raw.projectId === "string" ? raw.projectId : undefined,
    runId: typeof raw.runId === "string" ? raw.runId : undefined,
    subtaskId: typeof raw.subtaskId === "string" ? raw.subtaskId : undefined,
    clientProfileId: typeof raw.clientProfileId === "string" ? raw.clientProfileId : undefined,
    roleId: typeof raw.roleId === "string" ? raw.roleId : undefined
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
