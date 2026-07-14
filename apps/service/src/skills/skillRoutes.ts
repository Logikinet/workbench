/**
 * Skills + capability resolution HTTP routes (Task 22).
 *
 * Mount later from main / app.ts (owned by another agent):
 *
 *   import { createSkillRouter } from "../skills/skillRoutes.js";
 *   app.use(createSkillRouter({ skills, capabilityRuntime }));
 *
 * This module intentionally does NOT edit app.ts.
 *
 * Routes:
 * - GET    /api/skills
 * - GET    /api/skills/trusted-directories
 * - GET    /api/skills/:skillId
 * - GET    /api/skills/:skillId/content
 * - POST   /api/skills/trusted-directories
 * - POST   /api/skills/import
 * - POST   /api/skills/:skillId/enable
 * - POST   /api/skills/:skillId/disable
 * - POST   /api/skills/:skillId/trust
 * - POST   /api/capabilities/resolve
 * - POST   /api/capabilities/migrate-role
 */

import { Router, type Request, type Response } from "express";
import type { CapabilityRuntime } from "./capabilityRuntime.js";
import type { SkillService } from "./skillService.js";
import type {
  PlanCapabilityAllowlist,
  ResolveCapabilitiesInput,
  RoleCapabilityConfig
} from "./skillTypes.js";
import type { Harness, ReasoningEffort, RolePermissions } from "../roles/roleService.js";

export interface SkillRouteDeps {
  skills: SkillService;
  capabilityRuntime?: CapabilityRuntime;
}

export function createSkillRouter(deps: SkillRouteDeps): Router {
  const router = Router();

  router.get("/api/skills", (_request: Request, response: Response) => {
    try {
      response.json({ skills: deps.skills.list() });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list skills.") });
    }
  });

  router.get("/api/skills/trusted-directories", (_request: Request, response: Response) => {
    response.json({ trustedDirectories: deps.skills.trustedDirectories() });
  });

  router.get("/api/skills/:skillId", (request: Request, response: Response) => {
    try {
      const skill = deps.skills.get(routeParam(request.params.skillId));
      // Avoid dumping huge raw content on detail unless requested.
      const { rawContent: _raw, ...rest } = skill;
      response.json(rest);
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load skill.") });
    }
  });

  router.get("/api/skills/:skillId/content", async (request: Request, response: Response) => {
    try {
      const skillId = routeParam(request.params.skillId);
      const skill = deps.skills.get(skillId);
      const raw = await deps.skills.loadRaw(skillId);
      response.json({
        id: skill.id,
        name: skill.name,
        version: skill.version,
        instructions: skill.instructions,
        raw
      });
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load skill content.") });
    }
  });

  router.post("/api/skills/trusted-directories", async (request: Request, response: Response) => {
    try {
      const directory = readString(request.body?.directory ?? request.body?.path, "directory");
      const trusted = await deps.skills.addTrustedDirectory(directory);
      response.status(201).json({
        trustedDirectory: trusted,
        trustedDirectories: deps.skills.trustedDirectories()
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to trust skill directory.") });
    }
  });

  router.post("/api/skills/import", async (request: Request, response: Response) => {
    try {
      const directory = readString(request.body?.directory ?? request.body?.path, "directory");
      // Allow one-shot: add trusted + import when `trustDirectory: true`.
      if (request.body?.trustDirectory === true) {
        await deps.skills.addTrustedDirectory(directory, { rescan: false });
      }
      const result = await deps.skills.importFromTrustedDirectory(directory);
      response.status(201).json(result);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to import skills.") });
    }
  });

  router.post("/api/skills/:skillId/enable", async (request: Request, response: Response) => {
    try {
      response.json(await deps.skills.setEnabled(routeParam(request.params.skillId), true));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to enable skill.") });
    }
  });

  router.post("/api/skills/:skillId/disable", async (request: Request, response: Response) => {
    try {
      response.json(await deps.skills.setEnabled(routeParam(request.params.skillId), false));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to disable skill.") });
    }
  });

  router.post("/api/skills/:skillId/trust", async (request: Request, response: Response) => {
    try {
      response.json(await deps.skills.trust(routeParam(request.params.skillId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to trust skill.") });
    }
  });

  router.post("/api/capabilities/resolve", (request: Request, response: Response) => {
    try {
      const runtime = requireRuntime(deps);
      const input = parseResolveInput(request.body);
      response.json(runtime.resolve(input));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to resolve capabilities.") });
    }
  });

  router.post("/api/capabilities/migrate-role", (request: Request, response: Response) => {
    try {
      const runtime = requireRuntime(deps);
      const skills = readStringArray(request.body?.skills, "skills");
      const tools = readStringArray(request.body?.tools, "tools");
      response.json(runtime.migrateRoleNames({ skills, tools }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to migrate role capability names.") });
    }
  });

  return router;
}

/** Minimal Express app factory for route unit tests. */
export async function createSkillRouteApp(deps: SkillRouteDeps): Promise<import("express").Express> {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(createSkillRouter(deps));
  return app;
}

function requireRuntime(deps: SkillRouteDeps): CapabilityRuntime {
  if (!deps.capabilityRuntime) {
    throw new Error("CapabilityRuntime is not configured on skill routes.");
  }
  return deps.capabilityRuntime;
}

function parseResolveInput(body: unknown): ResolveCapabilitiesInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const roleRaw = value.role;
  if (!roleRaw || typeof roleRaw !== "object" || Array.isArray(roleRaw)) {
    throw new Error("role is required.");
  }
  const roleObj = roleRaw as Record<string, unknown>;
  const harness = roleObj.harness;
  if (harness !== "api" && harness !== "codex-cli") {
    throw new Error('role.harness must be "api" or "codex-cli".');
  }
  const reasoningEffort = roleObj.reasoningEffort;
  if (reasoningEffort !== "low" && reasoningEffort !== "medium" && reasoningEffort !== "high") {
    throw new Error('role.reasoningEffort must be "low", "medium", or "high".');
  }

  const role: RoleCapabilityConfig = {
    id: typeof roleObj.id === "string" ? roleObj.id : undefined,
    name: typeof roleObj.name === "string" ? roleObj.name : undefined,
    harness: harness as Harness,
    reasoningEffort: reasoningEffort as ReasoningEffort,
    skills: readStringArray(roleObj.skills, "role.skills"),
    tools: readStringArray(roleObj.tools, "role.tools"),
    permissions: parsePermissions(roleObj.permissions),
    enabled: typeof roleObj.enabled === "boolean" ? roleObj.enabled : undefined,
    systemInstruction: typeof roleObj.systemInstruction === "string" ? roleObj.systemInstruction : undefined
  };

  let plan: PlanCapabilityAllowlist | undefined;
  if (value.plan && typeof value.plan === "object" && !Array.isArray(value.plan)) {
    const planObj = value.plan as Record<string, unknown>;
    plan = {
      skills: planObj.skills !== undefined ? readStringArray(planObj.skills, "plan.skills") : undefined,
      tools: planObj.tools !== undefined ? readStringArray(planObj.tools, "plan.tools") : undefined
    };
  }

  return {
    role,
    plan,
    requireTrust: typeof value.requireTrust === "boolean" ? value.requireTrust : undefined,
    enforceRolePermissions:
      typeof value.enforceRolePermissions === "boolean" ? value.enforceRolePermissions : undefined,
    harnessSupportsReasoning:
      typeof value.harnessSupportsReasoning === "boolean" ? value.harnessSupportsReasoning : undefined,
    extraHarnessConfig:
      value.extraHarnessConfig
      && typeof value.extraHarnessConfig === "object"
      && !Array.isArray(value.extraHarnessConfig)
        ? (value.extraHarnessConfig as Record<string, unknown>)
        : undefined
  };
}

function parsePermissions(value: unknown): RolePermissions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("role.permissions is required.");
  }
  const permissions = value as Record<string, unknown>;
  if (
    (permissions.workspace !== "project_only" && permissions.workspace !== "read_only")
    || typeof permissions.network !== "boolean"
    || typeof permissions.shell !== "boolean"
    || typeof permissions.externalSend !== "boolean"
  ) {
    throw new Error("role.permissions is invalid.");
  }
  return {
    workspace: permissions.workspace,
    network: permissions.network,
    shell: permissions.shell,
    externalSend: permissions.externalSend
  };
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
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
