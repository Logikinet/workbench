/**
 * Provider preset HTTP routes.
 *
 * ## Mount points for main agent
 *
 * ```ts
 * import { mountProviderRoutes } from "../providers/providerRoutes.js";
 *
 * // Inside createApp / main wiring:
 * mountProviderRoutes(app);
 * ```
 *
 * Routes:
 * - `GET /api/providers/presets` — list built-in presets (no secrets)
 * - `GET /api/providers/presets/:presetId` — single preset
 */

import type { Express, Request, Response } from "express";
import { getProviderPreset, listProviderPresets } from "./presets.js";

export function mountProviderRoutes(app: Express): void {
  app.get("/api/providers/presets", (_request: Request, response: Response) => {
    response.json(listProviderPresets());
  });

  app.get("/api/providers/presets/:presetId", (request: Request, response: Response) => {
    const presetId = Array.isArray(request.params.presetId) ? request.params.presetId[0] : request.params.presetId;
    const preset = getProviderPreset(presetId ?? "");
    if (!preset) {
      response.status(404).json({ error: `Unknown provider preset "${presetId ?? ""}".` });
      return;
    }
    response.json(preset);
  });
}

/** Minimal Express app factory for route unit tests. */
export async function createProviderRouteApp(): Promise<Express> {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  mountProviderRoutes(app);
  return app;
}
