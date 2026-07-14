/**
 * HTTP routes for plugin lifecycle (Task 46).
 */

import { Router, type Request, type Response } from "express";
import type { PluginService } from "./pluginService.js";

export interface PluginRouteDeps {
  plugins: PluginService;
}

export function createPluginRouter(deps: PluginRouteDeps): Router {
  const router = Router();

  router.get("/api/plugins", async (_request: Request, response: Response) => {
    try {
      response.json(deps.plugins.list());
    } catch (error) {
      response.status(500).json({ error: message(error, "Unable to list plugins.") });
    }
  });

  router.get("/api/plugins/:pluginId", async (request: Request, response: Response) => {
    try {
      response.json(deps.plugins.get(routeParam(request.params.pluginId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Plugin not found.") });
    }
  });

  router.post("/api/plugins/install", async (request: Request, response: Response) => {
    try {
      if (request.body?.confirm !== true) {
        return response.status(400).json({ error: "Installing a plugin requires confirm: true." });
      }
      response.status(201).json(
        await deps.plugins.install({
          sourcePath: String(request.body?.sourcePath ?? ""),
          confirm: true,
          approvedPermissions: request.body?.approvedPermissions,
          requireAllDeclared: request.body?.requireAllDeclared,
          config: request.body?.config,
          secrets: request.body?.secrets
        })
      );
    } catch (error) {
      response.status(400).json({ error: message(error, "Unable to install plugin.") });
    }
  });

  router.post("/api/plugins/:pluginId/enable", async (request: Request, response: Response) => {
    try {
      response.json(
        await deps.plugins.enable({
          pluginId: routeParam(request.params.pluginId),
          approvedPermissions: request.body?.approvedPermissions
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to enable plugin.") });
    }
  });

  router.post("/api/plugins/:pluginId/disable", async (request: Request, response: Response) => {
    try {
      response.json(await deps.plugins.disable(routeParam(request.params.pluginId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to disable plugin.") });
    }
  });

  router.delete("/api/plugins/:pluginId", async (request: Request, response: Response) => {
    try {
      if (request.body?.confirm !== true && request.query?.confirm !== "true") {
        return response.status(400).json({ error: "Uninstalling a plugin requires confirm: true." });
      }
      await deps.plugins.uninstall(routeParam(request.params.pluginId), { confirm: true });
      response.json({ ok: true, pluginId: routeParam(request.params.pluginId) });
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to uninstall plugin.") });
    }
  });

  return router;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statusFor(error: unknown): number {
  const msg = message(error, "");
  if (/not found/i.test(msg)) return 404;
  return 400;
}
