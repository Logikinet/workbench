/**
 * Skills + capability resolution HTTP routes (Task 22 + Task 40 lifecycle).
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
 * - GET    /api/skills/catalog
 * - GET    /api/skills/trusted-directories
 * - GET    /api/skills/project-directories
 * - GET    /api/skills/:skillId
 * - GET    /api/skills/:skillId/detail
 * - GET    /api/skills/:skillId/content
 * - GET    /api/skills/:skillId/permissions
 * - GET    /api/skills/:skillId/drift
 * - GET    /api/skills/:skillId/update-preview
 * - POST   /api/skills/trusted-directories
 * - POST   /api/skills/project-directories
 * - POST   /api/skills/import
 * - POST   /api/skills/catalog/install
 * - POST   /api/skills/catalog/preview-install
 * - POST   /api/skills/:skillId/enable
 * - POST   /api/skills/:skillId/disable
 * - POST   /api/skills/:skillId/trust
 * - POST   /api/skills/:skillId/revoke-trust
 * - POST   /api/skills/:skillId/update
 * - POST   /api/skills/:skillId/rollback
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

  router.get("/api/skills/catalog", (request: Request, response: Response) => {
    try {
      const tagsRaw = request.query.tags;
      const tags =
        typeof tagsRaw === "string"
          ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
          : Array.isArray(tagsRaw)
            ? tagsRaw.flatMap((t) => String(t).split(",")).map((t) => t.trim()).filter(Boolean)
            : undefined;
      response.json(
        deps.skills.searchCatalog({
          query: typeof request.query.q === "string" ? request.query.q : typeof request.query.query === "string" ? request.query.query : undefined,
          tags,
          recommendedOnly: request.query.recommended === "1" || request.query.recommended === "true",
          notInstalledOnly: request.query.notInstalled === "1" || request.query.notInstalled === "true"
        })
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to search skill catalog.") });
    }
  });

  router.get("/api/skills/trusted-directories", (_request: Request, response: Response) => {
    response.json({ trustedDirectories: deps.skills.trustedDirectories() });
  });

  router.get("/api/skills/project-directories", (_request: Request, response: Response) => {
    response.json({ projectDirectories: deps.skills.projectDirectories() });
  });

  router.get("/api/skills/:skillId/detail", async (request: Request, response: Response) => {
    try {
      response.json(await deps.skills.getDetail(routeParam(request.params.skillId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load skill detail.") });
    }
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
        source: skill.source,
        trusted: skill.trusted,
        installStatus: skill.installStatus,
        permissionHints: skill.permissionHints,
        requiredTools: skill.requiredTools,
        instructions: skill.instructions,
        raw
      });
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load skill content.") });
    }
  });

  router.get("/api/skills/:skillId/permissions", (request: Request, response: Response) => {
    try {
      response.json(deps.skills.permissionSummary(routeParam(request.params.skillId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load permission summary.") });
    }
  });

  router.get("/api/skills/:skillId/drift", async (request: Request, response: Response) => {
    try {
      response.json(await deps.skills.checkDrift(routeParam(request.params.skillId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to check skill drift.") });
    }
  });

  router.get("/api/skills/:skillId/update-preview", async (request: Request, response: Response) => {
    try {
      response.json(await deps.skills.previewUpdate(routeParam(request.params.skillId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to preview skill update.") });
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

  router.post("/api/skills/project-directories", async (request: Request, response: Response) => {
    try {
      const projectId = readString(request.body?.projectId, "projectId");
      const directory = readString(request.body?.directory ?? request.body?.path, "directory");
      const resolved = await deps.skills.addProjectDirectory(projectId, directory);
      response.status(201).json({
        projectId,
        directory: resolved,
        projectDirectories: deps.skills.projectDirectories()
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to register project skill directory.") });
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

  router.post("/api/skills/catalog/preview-install", (request: Request, response: Response) => {
    try {
      const catalogId = readString(request.body?.catalogId ?? request.body?.id, "catalogId");
      response.json(deps.skills.previewInstall(catalogId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to preview catalog install.") });
    }
  });

  router.post("/api/skills/catalog/install", async (request: Request, response: Response) => {
    try {
      const catalogId = readString(request.body?.catalogId ?? request.body?.id, "catalogId");
      if (request.body?.confirm !== true) {
        response.status(400).json({
          error: "Install requires explicit user confirmation (confirm: true)."
        });
        return;
      }
      const installed = await deps.skills.installFromCatalog(catalogId, { confirm: true });
      response.status(201).json(installed);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to install skill from catalog.") });
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

  router.post("/api/skills/:skillId/revoke-trust", async (request: Request, response: Response) => {
    try {
      response.json(await deps.skills.revokeTrust(routeParam(request.params.skillId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to revoke skill trust.") });
    }
  });

  router.post("/api/skills/:skillId/update", async (request: Request, response: Response) => {
    try {
      if (request.body?.confirm !== true) {
        response.status(400).json({ error: "Update requires explicit user confirmation (confirm: true)." });
        return;
      }
      response.json(
        await deps.skills.updateFromCatalog(routeParam(request.params.skillId), {
          confirm: true,
          forceDespiteDrift: request.body?.forceDespiteDrift === true
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to update skill.") });
    }
  });

  router.post("/api/skills/:skillId/rollback", async (request: Request, response: Response) => {
    try {
      if (request.body?.confirm !== true) {
        response.status(400).json({ error: "Rollback requires explicit user confirmation (confirm: true)." });
        return;
      }
      response.json(
        await deps.skills.rollback(routeParam(request.params.skillId), {
          confirm: true,
          version: typeof request.body?.version === "string" ? request.body.version : undefined
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to rollback skill.") });
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
