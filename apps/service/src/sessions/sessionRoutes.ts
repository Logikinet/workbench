/**
 * HTTP routes for Agent Session management + Tool Cards (Task 41).
 *
 * Mount later from main / app.ts (owned by another agent if parallel):
 *
 *   import { createSessionRouter } from "../sessions/sessionRoutes.js";
 *   app.use(createSessionRouter({ sessions }));
 *
 * This module intentionally does NOT edit app.ts.
 *
 * Routes:
 * - GET    /api/sessions
 * - POST   /api/sessions
 * - GET    /api/sessions/:sessionId
 * - PATCH  /api/sessions/:sessionId
 * - DELETE /api/sessions/:sessionId
 * - POST   /api/sessions/:sessionId/clear
 * - GET    /api/sessions/:sessionId/cards
 * - POST   /api/sessions/:sessionId/messages
 * - POST   /api/sessions/:sessionId/events
 * - POST   /api/sessions/:sessionId/queue/drain
 * - POST   /api/sessions/:sessionId/cards/:cardId/collapse
 * - POST   /api/sessions/:sessionId/turns/:turnId/collapse
 * - POST   /api/sessions/:sessionId/cards/:cardId/answer
 */

import { Router, type Request, type Response } from "express";
import type { SessionService } from "./sessionService.js";
import {
  SESSION_STATUSES,
  type AnswerInteractionInput,
  type AppendMessageInput,
  type CreateSessionInput,
  type SessionIngestEvent,
  type SessionStatus,
  type UpdateSessionInput
} from "./sessionTypes.js";

export interface SessionRouteDeps {
  sessions: SessionService;
}

export function createSessionRouter(deps: SessionRouteDeps): Router {
  const router = Router();

  router.get("/api/sessions", (request: Request, response: Response) => {
    try {
      const status = parseStatus(request.query.status);
      response.json({
        sessions: deps.sessions.list({
          q: typeof request.query.q === "string" ? request.query.q : undefined,
          tag: typeof request.query.tag === "string" ? request.query.tag : undefined,
          projectId: typeof request.query.projectId === "string" ? request.query.projectId : undefined,
          agentRoleId:
            typeof request.query.agentRoleId === "string" ? request.query.agentRoleId : undefined,
          status
        })
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list sessions.") });
    }
  });

  router.post("/api/sessions", async (request: Request, response: Response) => {
    try {
      const session = await deps.sessions.create(parseCreate(request.body));
      response.status(201).json(session);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to create session.") });
    }
  });

  router.get("/api/sessions/:sessionId", (request: Request, response: Response) => {
    try {
      response.json(deps.sessions.get(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load session.") });
    }
  });

  router.patch("/api/sessions/:sessionId", async (request: Request, response: Response) => {
    try {
      response.json(
        await deps.sessions.update(routeParam(request.params.sessionId), parseUpdate(request.body))
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to update session.") });
    }
  });

  router.delete("/api/sessions/:sessionId", async (request: Request, response: Response) => {
    try {
      response.json(await deps.sessions.delete(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to delete session.") });
    }
  });

  router.post("/api/sessions/:sessionId/clear", async (request: Request, response: Response) => {
    try {
      response.json(await deps.sessions.clear(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to clear session.") });
    }
  });

  router.get("/api/sessions/:sessionId/cards", (request: Request, response: Response) => {
    try {
      response.json(
        deps.sessions.getCards(routeParam(request.params.sessionId), {
          afterSequence: parseOptionalInt(request.query.afterSequence),
          beforeSequence: parseOptionalInt(request.query.beforeSequence),
          limit: parseOptionalInt(request.query.limit),
          compact: parseOptionalBoolean(request.query.compact) ?? false
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load cards.") });
    }
  });

  router.post("/api/sessions/:sessionId/messages", async (request: Request, response: Response) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const input: AppendMessageInput = {
        content: typeof body.content === "string" ? body.content : "",
        mode:
          body.mode === "correction" || body.mode === "force" || body.mode === "queue"
            ? body.mode
            : undefined
      };
      response.status(201).json(await deps.sessions.appendMessage(routeParam(request.params.sessionId), input));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to append message.") });
    }
  });

  router.post("/api/sessions/:sessionId/events", async (request: Request, response: Response) => {
    try {
      const events = parseEvents(request.body);
      response.json(await deps.sessions.ingestEvents(routeParam(request.params.sessionId), events));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to ingest events.") });
    }
  });

  router.post("/api/sessions/:sessionId/queue/drain", async (request: Request, response: Response) => {
    try {
      response.json(await deps.sessions.drainMessageQueue(routeParam(request.params.sessionId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to drain queue.") });
    }
  });

  router.post(
    "/api/sessions/:sessionId/cards/:cardId/collapse",
    async (request: Request, response: Response) => {
      try {
        const collapsed = (request.body as { collapsed?: unknown } | undefined)?.collapsed !== false;
        response.json(
          await deps.sessions.setCardCollapsed(
            routeParam(request.params.sessionId),
            routeParam(request.params.cardId),
            collapsed
          )
        );
      } catch (error) {
        response
          .status(statusFor(error))
          .json({ error: errorMessage(error, "Unable to collapse card.") });
      }
    }
  );

  router.post(
    "/api/sessions/:sessionId/turns/:turnId/collapse",
    async (request: Request, response: Response) => {
      try {
        const collapsed = (request.body as { collapsed?: unknown } | undefined)?.collapsed !== false;
        response.json(
          await deps.sessions.collapseTurn(
            routeParam(request.params.sessionId),
            routeParam(request.params.turnId),
            collapsed
          )
        );
      } catch (error) {
        response
          .status(statusFor(error))
          .json({ error: errorMessage(error, "Unable to collapse turn.") });
      }
    }
  );

  router.post(
    "/api/sessions/:sessionId/cards/:cardId/answer",
    async (request: Request, response: Response) => {
      try {
        response.json(
          await deps.sessions.answerInteraction(
            routeParam(request.params.sessionId),
            routeParam(request.params.cardId),
            parseAnswer(request.body)
          )
        );
      } catch (error) {
        response
          .status(statusFor(error))
          .json({ error: errorMessage(error, "Unable to answer interaction.") });
      }
    }
  );

  return router;
}

/** Minimal Express app factory for route unit tests. */
export async function createSessionRouteApp(deps: SessionRouteDeps): Promise<import("express").Express> {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(createSessionRouter(deps));
  return app;
}

function parseCreate(body: unknown): CreateSessionInput {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    title: typeof value.title === "string" ? value.title : undefined,
    projectId: typeof value.projectId === "string" ? value.projectId : undefined,
    agentRoleId: typeof value.agentRoleId === "string" ? value.agentRoleId : undefined,
    agentName: typeof value.agentName === "string" ? value.agentName : undefined,
    preferredModelId: typeof value.preferredModelId === "string" ? value.preferredModelId : undefined,
    tags: Array.isArray(value.tags)
      ? value.tags.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    runId: typeof value.runId === "string" ? value.runId : undefined,
    todoId: typeof value.todoId === "string" ? value.todoId : undefined,
    initialMessage: typeof value.initialMessage === "string" ? value.initialMessage : undefined
  };
}

function parseUpdate(body: unknown): UpdateSessionInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const update: UpdateSessionInput = {};
  if (typeof value.title === "string") update.title = value.title;
  if (Array.isArray(value.tags)) {
    update.tags = value.tags.filter((entry): entry is string => typeof entry === "string");
  }
  if (value.projectId === null) update.projectId = null;
  else if (typeof value.projectId === "string") update.projectId = value.projectId;
  if (value.agentRoleId === null) update.agentRoleId = null;
  else if (typeof value.agentRoleId === "string") update.agentRoleId = value.agentRoleId;
  if (value.agentName === null) update.agentName = null;
  else if (typeof value.agentName === "string") update.agentName = value.agentName;
  if (value.preferredModelId === null) update.preferredModelId = null;
  else if (typeof value.preferredModelId === "string") update.preferredModelId = value.preferredModelId;
  if (value.runId === null) update.runId = null;
  else if (typeof value.runId === "string") update.runId = value.runId;
  if (value.todoId === null) update.todoId = null;
  else if (typeof value.todoId === "string") update.todoId = value.todoId;
  if (typeof value.status === "string") {
    if (!(SESSION_STATUSES as readonly string[]).includes(value.status)) {
      throw new Error("Invalid session status.");
    }
    update.status = value.status as SessionStatus;
  }
  return update;
}

function parseAnswer(body: unknown): AnswerInteractionInput {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    selectedOptionIds: Array.isArray(value.selectedOptionIds)
      ? value.selectedOptionIds.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    freeText: typeof value.freeText === "string" ? value.freeText : undefined,
    approved: typeof value.approved === "boolean" ? value.approved : undefined,
    decisionNote: typeof value.decisionNote === "string" ? value.decisionNote : undefined
  };
}

function parseEvents(body: unknown): SessionIngestEvent[] {
  const value = (body ?? {}) as Record<string, unknown>;
  const events = value.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error("events array is required.");
  }
  return events as SessionIngestEvent[];
}

function parseStatus(value: unknown): SessionStatus | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (!(SESSION_STATUSES as readonly string[]).includes(value)) {
    throw new Error("Invalid status filter.");
  }
  return value as SessionStatus;
}

function parseOptionalInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return undefined;
}

function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statusFor(error: unknown): number {
  if (error && typeof error === "object" && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    if (typeof code === "number") return code;
  }
  if (error instanceof Error && /not found/i.test(error.message)) return 404;
  return 400;
}
