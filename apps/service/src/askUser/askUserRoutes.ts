/**
 * HTTP routes for structured AskUser / AskApproval / AskReplan (Task 19).
 */

import { Router, type Request, type Response } from "express";
import type { AnswerAskUserInput, AskUserInputMode, AskUserKind, CreateAskUserInput } from "./askUserTypes.js";
import { askUserInputModes, askUserKinds } from "./askUserTypes.js";
import type { RunService } from "../runs/runService.js";

export function createAskUserRouter(runs: RunService): Router {
  const router = Router();

  router.get("/api/runs/:runId/ask-user", async (request: Request, response: Response) => {
    try {
      const items = await runs.listAskUser(routeParam(request.params.runId));
      response.json({
        runId: routeParam(request.params.runId),
        requests: items,
        pending: items.filter((entry) => entry.status === "pending"),
        queued: items.filter((entry) => entry.status === "queued")
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to list AskUser requests." });
    }
  });

  router.post("/api/runs/:runId/ask-user", async (request: Request, response: Response) => {
    try {
      const body = request.body ?? {};
      const input = parseCreateInput(body);
      const run = await runs.requestAskUser(routeParam(request.params.runId), input);
      response.status(201).json(run);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to create AskUser request." });
    }
  });

  router.post("/api/runs/:runId/ask-user/:requestId/answer", async (request: Request, response: Response) => {
    try {
      const body = request.body ?? {};
      const answer: AnswerAskUserInput = {
        selectedOptionIds: Array.isArray(body.selectedOptionIds)
          ? body.selectedOptionIds.filter((value: unknown): value is string => typeof value === "string")
          : undefined,
        freeText: typeof body.freeText === "string" ? body.freeText : undefined,
        approved: typeof body.approved === "boolean" ? body.approved : undefined,
        replanFeedback: typeof body.replanFeedback === "string" ? body.replanFeedback : undefined
      };
      const run = await runs.answerAskUser(
        routeParam(request.params.runId),
        routeParam(request.params.requestId),
        answer
      );
      response.json(run);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to answer AskUser request." });
    }
  });

  return router;
}

function parseCreateInput(body: Record<string, unknown>): CreateAskUserInput {
  const kind = body.kind;
  if (typeof kind !== "string" || !askUserKinds.includes(kind as AskUserKind)) {
    throw new Error("Ask kind must be ask_user, ask_approval, or ask_replan.");
  }
  const inputMode = body.inputMode;
  if (typeof inputMode !== "string" || !askUserInputModes.includes(inputMode as AskUserInputMode)) {
    throw new Error("AskUser inputMode is invalid.");
  }
  if (typeof body.prompt !== "string" || typeof body.reason !== "string") {
    throw new Error("AskUser prompt and reason are required.");
  }
  const source = body.source as { agent?: string; stepKey?: string; roleId?: string; label?: string } | undefined;
  if (!source || typeof source.agent !== "string" || typeof source.stepKey !== "string") {
    throw new Error("AskUser source.agent and source.stepKey are required.");
  }
  const options = Array.isArray(body.options)
    ? body.options
      .filter((entry): entry is { id?: string; label: string } => entry && typeof entry === "object" && typeof (entry as { label?: unknown }).label === "string")
      .map((entry) => ({ id: typeof entry.id === "string" ? entry.id : undefined, label: entry.label }))
    : undefined;

  return {
    kind: kind as AskUserKind,
    prompt: body.prompt,
    reason: body.reason,
    recommendedAnswer: typeof body.recommendedAnswer === "string" ? body.recommendedAnswer : undefined,
    recommendationRationale: typeof body.recommendationRationale === "string" ? body.recommendationRationale : undefined,
    inputMode: inputMode as AskUserInputMode,
    options,
    required: body.required === undefined ? true : Boolean(body.required),
    source: {
      agent: source.agent,
      stepKey: source.stepKey,
      roleId: typeof source.roleId === "string" ? source.roleId : undefined,
      label: typeof source.label === "string" ? source.label : undefined
    },
    forceQueue: Boolean(body.forceQueue)
  };
}

function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
