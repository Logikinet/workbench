/**
 * HTTP routes for evidence-first research sessions (Task 32).
 */

import { Router, type Request, type Response } from "express";
import type { ResearchService } from "./researchService.js";

export interface ResearchRouteDeps {
  research: ResearchService;
}

export function createResearchRouter(deps: ResearchRouteDeps): Router {
  const router = Router();

  router.get("/api/research/sessions", async (_request: Request, response: Response) => {
    try {
      response.json(await deps.research.listSessions());
    } catch (error) {
      response.status(500).json({ error: message(error, "Unable to list research sessions.") });
    }
  });

  router.post("/api/research/sessions", async (request: Request, response: Response) => {
    try {
      const session = await deps.research.createSession({
        title: String(request.body?.title ?? ""),
        goal: String(request.body?.goal ?? ""),
        runId: optionalString(request.body?.runId),
        projectId: optionalString(request.body?.projectId),
        forceEvidenceMode: request.body?.forceEvidenceMode,
        subQuestions: Array.isArray(request.body?.subQuestions)
          ? request.body.subQuestions.map(String)
          : undefined,
        parallelSteps: request.body?.parallelSteps
      });
      response.status(201).json(session);
    } catch (error) {
      response.status(400).json({ error: message(error, "Unable to create research session.") });
    }
  });

  router.get("/api/research/sessions/:sessionId", async (request: Request, response: Response) => {
    try {
      response.json(await deps.research.getSession(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Research session not found.") });
    }
  });

  router.post("/api/research/sessions/:sessionId/begin", async (request: Request, response: Response) => {
    try {
      response.json(await deps.research.beginGathering(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to begin gathering.") });
    }
  });

  router.post("/api/research/sessions/:sessionId/search", async (request: Request, response: Response) => {
    try {
      response.json(
        await deps.research.searchWeb(routeParam(request.params.sessionId), String(request.body?.query ?? ""), {
          limit: typeof request.body?.limit === "number" ? request.body.limit : undefined,
          stepId: optionalString(request.body?.stepId)
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Web search failed.") });
    }
  });

  router.post("/api/research/sessions/:sessionId/claims", async (request: Request, response: Response) => {
    try {
      response.status(201).json(
        await deps.research.addClaim(routeParam(request.params.sessionId), {
          text: String(request.body?.text ?? ""),
          kind: request.body?.kind ?? "finding",
          evidenceIds: Array.isArray(request.body?.evidenceIds)
            ? request.body.evidenceIds.map(String)
            : undefined,
          notes: optionalString(request.body?.notes),
          stepId: optionalString(request.body?.stepId)
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to add claim.") });
    }
  });

  router.post("/api/research/sessions/:sessionId/aggregate", async (request: Request, response: Response) => {
    try {
      response.json(await deps.research.aggregate(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to aggregate research.") });
    }
  });

  router.post("/api/research/sessions/:sessionId/artifacts", async (request: Request, response: Response) => {
    try {
      response.json(await deps.research.produceArtifacts(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to produce artifacts.") });
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
  if (/not configured/i.test(msg)) return 503;
  return 400;
}
