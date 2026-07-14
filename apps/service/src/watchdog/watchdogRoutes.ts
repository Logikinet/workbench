/**
 * HTTP routes for runtime watchdog + safe updates (Task 45).
 *
 * Mount later from main / app.ts (owned by wiring agent):
 *
 *   import { WatchdogService, createWatchdogRouter } from "../watchdog/index.js";
 *   app.use(createWatchdogRouter({ watchdog }));
 *
 * This module intentionally does NOT edit app.ts / main.ts.
 */

import express, { Router, type Express, type Request, type Response } from "express";
import type { WatchdogService } from "./watchdogService.js";

export interface WatchdogRouteDeps {
  watchdog: WatchdogService;
}

export function createWatchdogRouter(deps: WatchdogRouteDeps): Router {
  const router = Router();

  router.get("/api/watchdog/contract", (_request: Request, response: Response) => {
    response.json(deps.watchdog.contract());
  });

  router.get("/api/watchdog/runtime", async (_request: Request, response: Response) => {
    try {
      response.json(await deps.watchdog.runtimeStatus());
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to read runtime status.") });
    }
  });

  router.post("/api/watchdog/recovery/stop", (_request: Request, response: Response) => {
    try {
      response.json(deps.watchdog.stopRecovery());
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to stop recovery.") });
    }
  });

  router.post("/api/watchdog/recovery/reset", (_request: Request, response: Response) => {
    try {
      response.json(deps.watchdog.resetRecovery());
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to reset recovery.") });
    }
  });

  router.get("/api/watchdog/update", (_request: Request, response: Response) => {
    try {
      response.json(deps.watchdog.updateSnapshot());
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to read update status.") });
    }
  });

  router.post("/api/watchdog/update/check", async (_request: Request, response: Response) => {
    try {
      response.json(await deps.watchdog.checkForUpdates());
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to check for updates.") });
    }
  });

  router.post("/api/watchdog/update/download", async (_request: Request, response: Response) => {
    try {
      response.json(await deps.watchdog.downloadUpdate());
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to download update.") });
    }
  });

  router.post("/api/watchdog/update/apply", async (_request: Request, response: Response) => {
    try {
      response.json(await deps.watchdog.applyUpdate());
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to apply update.") });
    }
  });

  router.post("/api/watchdog/bundle/mark-healthy", async (request: Request, response: Response) => {
    try {
      const version = readVersion(request.body);
      response.json(await deps.watchdog.markHealthy(version));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to mark healthy.") });
    }
  });

  router.post("/api/watchdog/bundle/recover-candidate", async (_request: Request, response: Response) => {
    try {
      response.json(await deps.watchdog.recoverCandidate());
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to recover candidate.") });
    }
  });

  router.post("/api/watchdog/bundle/fail-candidate", async (request: Request, response: Response) => {
    try {
      const body = request.body;
      const version =
        body && typeof body === "object" && typeof (body as { version?: unknown }).version === "string"
          ? (body as { version: string }).version
          : undefined;
      response.json(await deps.watchdog.failCandidate(version));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to fail candidate.") });
    }
  });

  return router;
}

/** Standalone app for route tests (not production wiring). */
export function createWatchdogRouteApp(deps: WatchdogRouteDeps): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(createWatchdogRouter(deps));
  return app;
}

function readVersion(body: unknown): string {
  if (!body || typeof body !== "object") {
    throw Object.assign(new Error("body.version is required"), { statusCode: 400 });
  }
  const version = (body as { version?: unknown }).version;
  if (typeof version !== "string" || !version.trim()) {
    throw Object.assign(new Error("body.version is required"), { statusCode: 400 });
  }
  return version.trim();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function statusFor(error: unknown): number {
  if (error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number") {
    return (error as { statusCode: number }).statusCode;
  }
  const message = error instanceof Error ? error.message : "";
  if (/required|invalid|not configured|marked bad/i.test(message)) return 400;
  return 500;
}
