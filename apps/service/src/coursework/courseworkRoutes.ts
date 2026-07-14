/**
 * HTTP routes for coursework composite workflow (Task 34).
 */

import { Router, type Request, type Response } from "express";
import type { CourseworkService } from "./courseworkService.js";

export interface CourseworkRouteDeps {
  coursework: CourseworkService;
}

export function createCourseworkRouter(deps: CourseworkRouteDeps): Router {
  const router = Router();

  router.get("/api/coursework/sessions", async (_request: Request, response: Response) => {
    try {
      response.json(await deps.coursework.listSessions());
    } catch (error) {
      response.status(500).json({ error: message(error, "Unable to list coursework sessions.") });
    }
  });

  router.post("/api/coursework/sessions", async (request: Request, response: Response) => {
    try {
      const session = await deps.coursework.createSession({
        title: String(request.body?.title ?? ""),
        goal: String(request.body?.goal ?? ""),
        assignmentBrief: String(request.body?.assignmentBrief ?? ""),
        runId: optionalString(request.body?.runId),
        projectId: optionalString(request.body?.projectId),
        existingProjectNotes: optionalString(request.body?.existingProjectNotes),
        scopePolicy: request.body?.scopePolicy
      });
      response.status(201).json(session);
    } catch (error) {
      response.status(400).json({ error: message(error, "Unable to create coursework session.") });
    }
  });

  router.get("/api/coursework/sessions/:sessionId", async (request: Request, response: Response) => {
    try {
      response.json(await deps.coursework.getSession(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Coursework session not found.") });
    }
  });

  router.post("/api/coursework/sessions/:sessionId/extract-spec", async (request: Request, response: Response) => {
    try {
      response.json(await deps.coursework.extractSpec(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to extract specification.") });
    }
  });

  router.post("/api/coursework/sessions/:sessionId/plan", async (request: Request, response: Response) => {
    try {
      response.json(await deps.coursework.generatePlan(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to generate plan.") });
    }
  });

  router.post("/api/coursework/sessions/:sessionId/approve-plan", async (request: Request, response: Response) => {
    try {
      response.json(
        await deps.coursework.approvePlan(routeParam(request.params.sessionId), {
          createDag: request.body?.createDag,
          planVersion: typeof request.body?.planVersion === "number" ? request.body.planVersion : undefined
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to approve plan.") });
    }
  });

  return router;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statusFor(error: unknown): number {
  const msg = message(error, "");
  if (/not found/i.test(msg)) return 404;
  return 400;
}
