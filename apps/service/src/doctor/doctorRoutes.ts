/**
 * HTTP routes for Doctor / runtime health (Task 44).
 *
 * Mount later from main / app.ts (owned by wiring agent):
 *
 *   import { DoctorService, createDoctorRouter } from "../doctor/index.js";
 *
 *   const doctor = new DoctorService({
 *     version: serviceVersion,
 *     dataDirectory,
 *     port,
 *     connections,
 *     codex: codexCli,
 *     mcp,
 *     // ...
 *   });
 *   app.use(createDoctorRouter({ doctor }));
 *
 * This module intentionally does NOT edit app.ts / main.ts.
 *
 * Routes:
 * - GET  /api/doctor/contract
 * - GET  /api/doctor/status
 * - GET  /api/doctor
 * - POST /api/doctor/run
 * - POST /api/doctor/fix
 * - GET  /api/doctor/logs
 * - GET  /api/doctor/logs/crash
 * - GET  /api/doctor/logs/archives
 * - GET  /api/doctor/logs/archives/:name
 * - POST /api/doctor/export
 */

import express, { Router, type Express, type Request, type Response } from "express";
import type { DoctorService } from "./doctorService.js";
import type { DoctorFixRequest, DoctorRunOptions, LogKind } from "./doctorTypes.js";

export interface DoctorRouteDeps {
  doctor: DoctorService;
}

export function createDoctorRouter(deps: DoctorRouteDeps): Router {
  const router = Router();

  router.get("/api/doctor/contract", (_request: Request, response: Response) => {
    response.json(deps.doctor.contract());
  });

  router.get("/api/doctor/status", async (request: Request, response: Response) => {
    try {
      const verbose = parseBool(request.query.verbose);
      response.json(await deps.doctor.status({ verbose }));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to collect status.") });
    }
  });

  router.get("/api/doctor", async (request: Request, response: Response) => {
    try {
      const verbose = parseBool(request.query.verbose);
      const report = await deps.doctor.doctor({ verbose });
      response.status(report.exitCode === 0 ? 200 : 200).json(report);
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to run doctor.") });
    }
  });

  router.post("/api/doctor/run", async (request: Request, response: Response) => {
    try {
      const options = parseRunOptions(request.body);
      response.json(await deps.doctor.run(options));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to re-run doctor.") });
    }
  });

  router.post("/api/doctor/fix", async (request: Request, response: Response) => {
    try {
      const body = request.body;
      if (!body || typeof body !== "object" || (body as DoctorFixRequest).confirm !== true) {
        response.status(400).json({
          error: "Auto-fix requires explicit confirm=true (user confirmation)."
        });
        return;
      }
      const checkIds = Array.isArray((body as DoctorFixRequest).checkIds)
        ? (body as DoctorFixRequest).checkIds!.map(String)
        : undefined;
      response.json(await deps.doctor.fixAndRecheck({ confirm: true, checkIds }));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to apply doctor fixes.") });
    }
  });

  router.get("/api/doctor/logs", async (request: Request, response: Response) => {
    try {
      response.json(
        await deps.doctor.getLogs({
          kind: "service",
          lines: parseLines(request.query.lines),
          redact: parseRedact(request.query.redact)
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to read logs.") });
    }
  });

  router.get("/api/doctor/logs/crash", async (request: Request, response: Response) => {
    try {
      response.json(
        await deps.doctor.getLogs({
          kind: "crash",
          lines: parseLines(request.query.lines),
          redact: parseRedact(request.query.redact)
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to read crash logs.") });
    }
  });

  router.get("/api/doctor/logs/archives", async (_request: Request, response: Response) => {
    try {
      response.json({ archives: await deps.doctor.listLogArchives() });
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to list log archives.") });
    }
  });

  router.get("/api/doctor/logs/archives/:name", async (request: Request, response: Response) => {
    try {
      const name = routeParam(request.params.name);
      response.json(
        await deps.doctor.getLogs({
          kind: "archive" satisfies LogKind,
          archiveName: name,
          lines: parseLines(request.query.lines),
          redact: parseRedact(request.query.redact)
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to read archive log.") });
    }
  });

  router.post("/api/doctor/export", async (_request: Request, response: Response) => {
    try {
      const result = await deps.doctor.exportDiagnosticPack();
      response.status(201).json({
        manifest: result.manifest,
        // Compact summary only — full report is on disk in the pack.
        summary: result.report.summary,
        exitCode: result.report.exitCode,
        level: result.report.status.level,
        recommendations: result.report.recommendations
      });
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to export diagnostic pack.") });
    }
  });

  return router;
}

/** Standalone Express app for route tests (loopback-only middleware omitted). */
export function createDoctorRouteApp(deps: DoctorRouteDeps): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(createDoctorRouter(deps));
  return app;
}

function parseRunOptions(body: unknown): DoctorRunOptions {
  if (body === undefined || body === null || body === "") return {};
  if (typeof body !== "object") throw Object.assign(new Error("JSON body must be an object."), { statusCode: 400 });
  const record = body as Record<string, unknown>;
  const options: DoctorRunOptions = {};
  if (record.verbose !== undefined) options.verbose = record.verbose === true;
  if (record.fix !== undefined) options.fix = record.fix === true;
  if (record.confirm !== undefined) options.confirm = record.confirm === true;
  if (Array.isArray(record.checkIds)) options.checkIds = record.checkIds.map(String);
  return options;
}

function parseBool(value: unknown): boolean {
  if (value === true || value === "true" || value === "1") return true;
  return false;
}

function parseRedact(value: unknown): boolean {
  // Default true; only disable when explicitly false (still recommended to keep redaction on).
  if (value === false || value === "false" || value === "0") return false;
  return true;
}

function parseLines(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error("lines must be a positive integer."), { statusCode: 400 });
  }
  return n;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function statusFor(error: unknown): number {
  if (typeof error === "object" && error && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    if (typeof code === "number" && code >= 400 && code < 600) return code;
  }
  return 500;
}
