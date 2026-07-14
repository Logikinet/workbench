/**
 * HTTP routes for document / paper writing sessions (Task 33).
 */

import { Router, type Request, type Response } from "express";
import type { DocumentService } from "./documentService.js";

export interface DocumentRouteDeps {
  documents: DocumentService;
}

export function createDocumentRouter(deps: DocumentRouteDeps): Router {
  const router = Router();

  router.get("/api/documents/sessions", async (_request: Request, response: Response) => {
    try {
      response.json(await deps.documents.listSessions());
    } catch (error) {
      response.status(500).json({ error: message(error, "Unable to list document sessions.") });
    }
  });

  router.post("/api/documents/sessions", async (request: Request, response: Response) => {
    try {
      const session = await deps.documents.createSession({
        title: String(request.body?.title ?? ""),
        goal: String(request.body?.goal ?? ""),
        runId: optionalString(request.body?.runId),
        projectId: optionalString(request.body?.projectId),
        researchSessionId: optionalString(request.body?.researchSessionId),
        bibliographyStyle: request.body?.bibliographyStyle,
        projectFacts: Array.isArray(request.body?.projectFacts)
          ? request.body.projectFacts.map(String)
          : undefined
      });
      response.status(201).json(session);
    } catch (error) {
      response.status(400).json({ error: message(error, "Unable to create document session.") });
    }
  });

  router.get("/api/documents/sessions/:sessionId", async (request: Request, response: Response) => {
    try {
      response.json(await deps.documents.getSession(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Document session not found.") });
    }
  });

  router.post("/api/documents/sessions/:sessionId/outline", async (request: Request, response: Response) => {
    try {
      response.json(await deps.documents.generateOutline(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to generate outline.") });
    }
  });

  router.post("/api/documents/sessions/:sessionId/chapters/:chapterId/write", async (request: Request, response: Response) => {
    try {
      response.json(
        await deps.documents.writeChapter(routeParam(request.params.sessionId), routeParam(request.params.chapterId), {
          revisionNote: optionalString(request.body?.revisionNote),
          enforceGrounding: request.body?.enforceGrounding
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to write chapter.") });
    }
  });

  router.post("/api/documents/sessions/:sessionId/export", async (request: Request, response: Response) => {
    try {
      response.json(
        await deps.documents.exportAll(routeParam(request.params.sessionId), {
          dir: optionalString(request.body?.dir)
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to export document.") });
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
