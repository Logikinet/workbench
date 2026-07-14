/**
 * HTTP routes for Artifact document browser (Task 42).
 *
 * Mount later from main / app.ts (owned by wiring agent if parallel):
 *
 *   import { ArtifactBrowserService, createArtifactRouter } from "../artifacts/index.js";
 *
 *   const artifacts = await ArtifactBrowserService.open({
 *     catalogPath: join(dataDirectory, "artifacts.json"),
 *     projects,
 *     runs
 *   });
 *   app.use(createArtifactRouter({ artifacts }));
 *
 * This module intentionally does NOT edit app.ts / main.ts.
 *
 * Routes:
 * - GET    /api/artifacts/office-status
 * - GET    /api/artifacts
 * - POST   /api/artifacts
 * - GET    /api/artifacts/:artifactId
 * - PATCH  /api/artifacts/:artifactId
 * - GET    /api/artifacts/:artifactId/versions
 * - POST   /api/artifacts/:artifactId/versions
 * - GET    /api/artifacts/projects/:projectId/browse
 * - GET    /api/artifacts/projects/:projectId/stat
 * - GET    /api/artifacts/projects/:projectId/preview
 * - POST   /api/artifacts/projects/:projectId/open-external
 * - POST   /api/artifacts/projects/:projectId/detect-changes
 * - POST   /api/artifacts/projects/:projectId/reveal
 * - POST   /api/artifacts/projects/:projectId/copy-path
 * - POST   /api/artifacts/projects/:projectId/export
 * - POST   /api/artifacts/projects/:projectId/package
 * - POST   /api/artifacts/runs/:runId/import
 */

import express, { Router, type Express, type Request, type Response } from "express";
import type { ArtifactBrowserService } from "./artifactBrowserService.js";
import type {
  ArtifactOrigin,
  ExportRequest,
  ExternalAppKind,
  FileFingerprint,
  PackageRequest,
  RegisterArtifactInput,
  ReviewStatus,
  UpdateArtifactInput
} from "./artifactTypes.js";
import { PathSafetyError } from "./pathSafety.js";

export interface ArtifactRouteDeps {
  artifacts: ArtifactBrowserService;
}

export function createArtifactRouter(deps: ArtifactRouteDeps): Router {
  const router = Router();

  router.get("/api/artifacts/office-status", async (_request: Request, response: Response) => {
    try {
      response.json(await deps.artifacts.officeStatus());
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to probe Office/WPS.") });
    }
  });

  router.get("/api/artifacts", (request: Request, response: Response) => {
    try {
      response.json({
        artifacts: deps.artifacts.listArtifacts({
          projectId: str(request.query.projectId),
          runId: str(request.query.runId),
          q: str(request.query.q),
          tag: str(request.query.tag),
          origin: str(request.query.origin) as ArtifactOrigin | undefined,
          reviewStatus: str(request.query.reviewStatus) as ReviewStatus | undefined
        })
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list artifacts.") });
    }
  });

  router.post("/api/artifacts", async (request: Request, response: Response) => {
    try {
      const created = await deps.artifacts.registerArtifact(parseRegister(request.body));
      response.status(201).json(created);
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to register artifact.") });
    }
  });

  // Project browse routes before :artifactId to avoid shadowing.
  router.get("/api/artifacts/projects/:projectId/browse", async (request: Request, response: Response) => {
    try {
      const limit = request.query.limit !== undefined ? Number(request.query.limit) : undefined;
      response.json(
        await deps.artifacts.browse(
          routeParam(request.params.projectId),
          str(request.query.path) ?? "",
          Number.isFinite(limit) ? limit : undefined
        )
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to browse workspace.") });
    }
  });

  router.get("/api/artifacts/projects/:projectId/stat", async (request: Request, response: Response) => {
    try {
      const path = str(request.query.path);
      if (!path) {
        response.status(400).json({ error: "Query parameter path is required." });
        return;
      }
      response.json(await deps.artifacts.pathStat(routeParam(request.params.projectId), path));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to stat path.") });
    }
  });

  router.get("/api/artifacts/projects/:projectId/preview", async (request: Request, response: Response) => {
    try {
      const path = str(request.query.path);
      if (!path) {
        response.status(400).json({ error: "Query parameter path is required." });
        return;
      }
      const offset = request.query.offset !== undefined ? Number(request.query.offset) : undefined;
      const limit = request.query.limit !== undefined ? Number(request.query.limit) : undefined;
      const maxTextChars =
        request.query.maxTextChars !== undefined ? Number(request.query.maxTextChars) : undefined;
      response.json(
        await deps.artifacts.preview(routeParam(request.params.projectId), path, {
          offset: Number.isFinite(offset) ? offset : undefined,
          limit: Number.isFinite(limit) ? limit : undefined,
          maxTextChars: Number.isFinite(maxTextChars) ? maxTextChars : undefined
        })
      );
    } catch (error) {
      // Preview failures should still return a structured body when possible.
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to preview file.") });
    }
  });

  router.post(
    "/api/artifacts/projects/:projectId/open-external",
    async (request: Request, response: Response) => {
      try {
        const body = asRecord(request.body);
        const path = readString(body.path, "path");
        const preferred = (typeof body.preferred === "string" ? body.preferred : "auto") as ExternalAppKind;
        response.json(
          await deps.artifacts.openExternal(routeParam(request.params.projectId), path, preferred)
        );
      } catch (error) {
        response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to open externally.") });
      }
    }
  );

  router.post(
    "/api/artifacts/projects/:projectId/detect-changes",
    async (request: Request, response: Response) => {
      try {
        const body = asRecord(request.body);
        const path = readString(body.path, "path");
        const previous = body.previous as FileFingerprint | undefined;
        response.json(
          await deps.artifacts.detectChanges(routeParam(request.params.projectId), path, previous)
        );
      } catch (error) {
        response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to detect changes.") });
      }
    }
  );

  router.post("/api/artifacts/projects/:projectId/reveal", async (request: Request, response: Response) => {
    try {
      const body = asRecord(request.body);
      const path = readString(body.path, "path");
      response.json(await deps.artifacts.reveal(routeParam(request.params.projectId), path));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to reveal path.") });
    }
  });

  router.post(
    "/api/artifacts/projects/:projectId/copy-path",
    async (request: Request, response: Response) => {
      try {
        const body = asRecord(request.body);
        const path = readString(body.path, "path");
        response.json(await deps.artifacts.copyPath(routeParam(request.params.projectId), path));
      } catch (error) {
        response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to resolve path.") });
      }
    }
  );

  router.post("/api/artifacts/projects/:projectId/export", async (request: Request, response: Response) => {
    try {
      const body = asRecord(request.body);
      const req: ExportRequest = {
        projectId: routeParam(request.params.projectId),
        paths: stringArray(body.paths),
        destinationDir: readString(body.destinationDir, "destinationDir"),
        mode: body.mode === "manifest" ? "manifest" : "copy",
        artifactIds: body.artifactIds !== undefined ? stringArray(body.artifactIds) : undefined
      };
      response.json(await deps.artifacts.exportFiles(req));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to export files.") });
    }
  });

  router.post("/api/artifacts/projects/:projectId/package", async (request: Request, response: Response) => {
    try {
      const body = asRecord(request.body);
      const req: PackageRequest = {
        projectId: routeParam(request.params.projectId),
        paths: stringArray(body.paths),
        outputPath: readString(body.outputPath, "outputPath"),
        artifactIds: body.artifactIds !== undefined ? stringArray(body.artifactIds) : undefined,
        includeManifest: body.includeManifest !== false
      };
      response.json(await deps.artifacts.packageFiles(req));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to package files.") });
    }
  });

  router.post("/api/artifacts/runs/:runId/import", async (request: Request, response: Response) => {
    try {
      const body = asRecord(request.body);
      const projectId = readString(body.projectId, "projectId");
      const artifacts = await deps.artifacts.importRunArtifacts(
        routeParam(request.params.runId),
        projectId
      );
      response.status(201).json({ artifacts });
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to import run artifacts.") });
    }
  });

  router.get("/api/artifacts/:artifactId", (request: Request, response: Response) => {
    try {
      response.json(deps.artifacts.getArtifact(routeParam(request.params.artifactId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load artifact.") });
    }
  });

  router.patch("/api/artifacts/:artifactId", async (request: Request, response: Response) => {
    try {
      response.json(
        await deps.artifacts.updateArtifact(
          routeParam(request.params.artifactId),
          parseUpdate(request.body)
        )
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to update artifact.") });
    }
  });

  router.get("/api/artifacts/:artifactId/versions", (request: Request, response: Response) => {
    try {
      response.json({ versions: deps.artifacts.listVersions(routeParam(request.params.artifactId)) });
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to list versions.") });
    }
  });

  router.post("/api/artifacts/:artifactId/versions", async (request: Request, response: Response) => {
    try {
      const body = asRecord(request.body ?? {});
      response.status(201).json(
        await deps.artifacts.addVersion(routeParam(request.params.artifactId), {
          note: typeof body.note === "string" ? body.note : undefined,
          createdBy: typeof body.createdBy === "string" ? body.createdBy : undefined,
          runId: typeof body.runId === "string" ? body.runId : undefined
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to add version.") });
    }
  });

  return router;
}

/** Minimal Express app factory for route unit tests. */
export function createArtifactRouteApp(deps: ArtifactRouteDeps): Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(createArtifactRouter(deps));
  return app;
}

// --- parsers / helpers ---

function parseRegister(body: unknown): RegisterArtifactInput {
  const value = asRecord(body);
  return {
    projectId: readString(value.projectId, "projectId"),
    relativePath: readString(value.relativePath, "relativePath"),
    kind: typeof value.kind === "string" ? value.kind : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    origin: typeof value.origin === "string" ? (value.origin as ArtifactOrigin) : undefined,
    createdBy: typeof value.createdBy === "string" ? value.createdBy : undefined,
    runId: typeof value.runId === "string" ? value.runId : undefined,
    todoId: typeof value.todoId === "string" ? value.todoId : undefined,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    reviewStatus: typeof value.reviewStatus === "string" ? (value.reviewStatus as ReviewStatus) : undefined,
    reviewSummary: typeof value.reviewSummary === "string" ? value.reviewSummary : undefined,
    evidenceLinks: Array.isArray(value.evidenceLinks) ? (value.evidenceLinks as RegisterArtifactInput["evidenceLinks"]) : undefined,
    diffLinks: Array.isArray(value.diffLinks) ? (value.diffLinks as RegisterArtifactInput["diffLinks"]) : undefined,
    sourceLinks: Array.isArray(value.sourceLinks) ? (value.sourceLinks as RegisterArtifactInput["sourceLinks"]) : undefined,
    tags: Array.isArray(value.tags)
      ? value.tags.filter((t): t is string => typeof t === "string")
      : undefined,
    note: typeof value.note === "string" ? value.note : undefined
  };
}

function parseUpdate(body: unknown): UpdateArtifactInput {
  const value = asRecord(body);
  const update: UpdateArtifactInput = {};
  if (typeof value.title === "string") update.title = value.title;
  if (typeof value.kind === "string") update.kind = value.kind;
  if (typeof value.reviewStatus === "string") update.reviewStatus = value.reviewStatus as ReviewStatus;
  if (value.reviewSummary === null) update.reviewSummary = null;
  else if (typeof value.reviewSummary === "string") update.reviewSummary = value.reviewSummary;
  if (Array.isArray(value.evidenceLinks)) {
    update.evidenceLinks = value.evidenceLinks as UpdateArtifactInput["evidenceLinks"];
  }
  if (Array.isArray(value.diffLinks)) {
    update.diffLinks = value.diffLinks as UpdateArtifactInput["diffLinks"];
  }
  if (Array.isArray(value.sourceLinks)) {
    update.sourceLinks = value.sourceLinks as UpdateArtifactInput["sourceLinks"];
  }
  if (Array.isArray(value.tags)) {
    update.tags = value.tags.filter((t): t is string => typeof t === "string");
  }
  if (value.createdBy === null) update.createdBy = null;
  else if (typeof value.createdBy === "string") update.createdBy = value.createdBy;
  return update;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") throw Object.assign(new Error("JSON body is required."), { statusCode: 400 });
  return body as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${field} is required.`), { statusCode: 400 });
  }
  return value.trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statusFor(error: unknown): number {
  if (error instanceof PathSafetyError) {
    if (error.code === "not_found") return 404;
    if (error.code === "invalid_path" || error.code === "outside_workspace") return 400;
  }
  if (error && typeof error === "object" && "statusCode" in error) {
    const code = Number((error as { statusCode: unknown }).statusCode);
    if (Number.isFinite(code) && code >= 400 && code < 600) return code;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("not found")) return 404;
    if (msg.includes("outside") || msg.includes("traversal") || msg.includes("relative")) return 400;
  }
  return 400;
}
