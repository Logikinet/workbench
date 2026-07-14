/**
 * Enhanced connection HTTP routes (presets-aware CRUD extras, probe, usage, models, audit, hot-apply).
 *
 * ## Mount points for main agent (apps/service/src/http/app.ts or main.ts)
 *
 * ```ts
 * import { mountConnectionRoutes } from "../connections/connectionRoutes.js";
 * import { mountProviderRoutes } from "../providers/providerRoutes.js";
 *
 * // Inside createApp after options are available:
 * if (options.connections) {
 *   mountConnectionRoutes(app, options.connections);
 *   mountProviderRoutes(app);
 * }
 * ```
 *
 * Existing basic routes in app.ts (`GET/POST /api/connections`, `PATCH/DELETE`, `POST .../test`)
 * remain for backward compatibility. Prefer the public-view helpers here for UI:
 * - `GET /api/connections/public` — secret-free list with credentialPresent + diagnostics
 * - `GET /api/connections/:id/public`
 * - `GET /api/connections/:id/models`
 * - `POST /api/connections/:id/probe`
 * - `GET /api/connections/:id/usage`
 * - `POST /api/connections/:id/apply` and `POST /api/connections/apply`
 * - `GET /api/connections/audit` and `GET /api/connections/:id/audit`
 * - `POST /api/connections` with presetId/providerKind/modelSource (also via this mount)
 *
 * When both app.ts and this module mount `POST /api/connections`, register this module's
 * enhanced handlers first OR replace the legacy handlers entirely.
 */

import type { Express, Request, Response } from "express";
import {
  ConnectionService,
  toPublicConnection,
  type CreateConnectionInput,
  type UpdateConnectionInput
} from "./connectionService.js";

export function mountConnectionRoutes(app: Express, connections: ConnectionService): void {
  app.get("/api/connections/public", async (_request, response) => {
    try {
      response.json(await connections.listPublic());
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list connections.") });
    }
  });

  app.get("/api/connections/audit", async (request, response) => {
    try {
      const limit = parseLimit(request.query.limit);
      response.json(await connections.listAudit(undefined, limit));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to read audit history.") });
    }
  });

  app.get("/api/connections/revision", async (_request, response) => {
    response.json({ revision: connections.getConfigRevision() });
  });

  app.post("/api/connections/apply", async (_request, response) => {
    try {
      response.json(await connections.hotApply());
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to hot-apply connections.") });
    }
  });

  app.get("/api/connections/:connectionId/public", async (request, response) => {
    try {
      response.json(await connections.getPublic(request.params.connectionId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to load connection.") });
    }
  });

  app.get("/api/connections/:connectionId/models", async (request, response) => {
    try {
      response.json(await connections.listModels(request.params.connectionId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list models.") });
    }
  });

  app.post("/api/connections/:connectionId/probe", async (request, response) => {
    try {
      response.json(await connections.probe(request.params.connectionId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to probe connection.") });
    }
  });

  app.get("/api/connections/:connectionId/usage", async (request, response) => {
    try {
      response.json(await connections.usageSnapshot(request.params.connectionId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to read usage snapshot.") });
    }
  });

  app.post("/api/connections/:connectionId/apply", async (request, response) => {
    try {
      response.json(await connections.hotApply(request.params.connectionId));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to hot-apply connection.") });
    }
  });

  app.get("/api/connections/:connectionId/audit", async (request, response) => {
    try {
      const limit = parseLimit(request.query.limit);
      response.json(await connections.listAudit(request.params.connectionId, limit));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to read connection audit.") });
    }
  });

  /**
   * Enhanced create — accepts presetId / providerKind / modelSource.
   * Safe to use alongside legacy create if only one is registered.
   */
  app.post("/api/connections/v2", async (request, response) => {
    try {
      const created = await connections.create(parseCreateBody(request.body));
      response.status(201).json(toPublicConnection(created));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to save connection.") });
    }
  });

  app.patch("/api/connections/:connectionId/v2", async (request, response) => {
    try {
      const updated = await connections.update(request.params.connectionId, parseUpdateBody(request.body));
      response.json(toPublicConnection(updated));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to update connection.") });
    }
  });
}

function parseCreateBody(body: unknown): CreateConnectionInput {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    name: asString(value.name),
    baseUrl: asString(value.baseUrl),
    apiKey: asString(value.apiKey),
    modelId: asString(value.modelId) ?? "",
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    presetId: asString(value.presetId),
    providerKind: asString(value.providerKind),
    modelSource: asString(value.modelSource)
  };
}

function parseUpdateBody(body: unknown): UpdateConnectionInput {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    name: asString(value.name),
    baseUrl: asString(value.baseUrl),
    apiKey: asString(value.apiKey),
    modelId: asString(value.modelId),
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    presetId: asString(value.presetId),
    providerKind: asString(value.providerKind),
    modelSource: asString(value.modelSource)
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseLimit(value: unknown): number {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 100;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Minimal Express app factory for route unit tests (loopback-only not enforced). */
export async function createConnectionRouteApp(connections: ConnectionService): Promise<Express> {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  mountConnectionRoutes(app, connections);
  return app;
}
