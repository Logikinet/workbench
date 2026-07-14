/**
 * HTTP routes for local automation triggers (Task 43).
 *
 * Mount later from main / app.ts (owned by wiring agent):
 *
 *   import { createAutomationRouter } from "../automation/automationRoutes.js";
 *   import { AutomationService } from "../automation/automationService.js";
 *
 *   const automation = await AutomationService.open({
 *     statePath: join(dataDirectory, "automation.json"),
 *     todos, runs
 *   });
 *   await automation.start();
 *   app.use(createAutomationRouter({ automation, clientAddress }));
 *
 * This module intentionally does NOT edit app.ts / main.ts.
 *
 * Routes:
 * - GET    /api/automation/status
 * - GET    /api/automation/jobs
 * - POST   /api/automation/jobs
 * - GET    /api/automation/jobs/:jobId
 * - PATCH  /api/automation/jobs/:jobId
 * - DELETE /api/automation/jobs/:jobId
 * - POST   /api/automation/jobs/:jobId/enable
 * - POST   /api/automation/jobs/:jobId/disable
 * - POST   /api/automation/jobs/:jobId/run
 * - GET    /api/automation/jobs/:jobId/history
 * - GET    /api/automation/history
 * - GET    /api/automation/webhooks
 * - POST   /api/automation/webhooks
 * - GET    /api/automation/webhooks/:webhookId
 * - DELETE /api/automation/webhooks/:webhookId
 * - POST   /api/automation/webhooks/:webhookId/enable
 * - POST   /api/automation/webhooks/:webhookId/disable
 * - POST   /api/automation/webhooks/:webhookId/rotate-token
 * - POST   /api/hooks/:webhookId   (token + structured schema)
 */

import express, { Router, type Express, type Request, type Response } from "express";
import type { AutomationService } from "./automationService.js";
import type {
  AutomationAction,
  AutomationSchedule,
  CreateAutomationJobInput,
  CreateWebhookInput,
  MissedRunPolicy,
  UpdateAutomationJobInput,
  WebhookEventPayload,
  WebhookEventType
} from "./automationTypes.js";
import {
  automationActionTypes,
  missedRunPolicies,
  scheduleKinds,
  webhookEventTypes
} from "./automationTypes.js";

export interface AutomationRouteDeps {
  automation: AutomationService;
  /** Optional resolver for remote address (webhook source restriction). */
  clientAddress?: (request: Request) => string | undefined;
}

export function createAutomationRouter(deps: AutomationRouteDeps): Router {
  const router = Router();
  const resolveAddress =
    deps.clientAddress ?? ((request: Request) => request.socket.remoteAddress ?? undefined);

  router.get("/api/automation/status", (_request: Request, response: Response) => {
    response.json(deps.automation.status());
  });

  router.get("/api/automation/jobs", (request: Request, response: Response) => {
    try {
      const includeDisabled = request.query.includeDisabled !== "false";
      response.json({ jobs: deps.automation.listJobs(includeDisabled) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list automation jobs.") });
    }
  });

  router.post("/api/automation/jobs", async (request: Request, response: Response) => {
    try {
      const input = parseCreateJob(request.body);
      const job = await deps.automation.createJob(input);
      response.status(201).json(job);
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to create job.") });
    }
  });

  router.get("/api/automation/jobs/:jobId", (request: Request, response: Response) => {
    try {
      response.json(deps.automation.getJob(routeParam(request.params.jobId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load job.") });
    }
  });

  router.patch("/api/automation/jobs/:jobId", async (request: Request, response: Response) => {
    try {
      const input = parseUpdateJob(request.body);
      response.json(await deps.automation.updateJob(routeParam(request.params.jobId), input));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to update job.") });
    }
  });

  router.delete("/api/automation/jobs/:jobId", async (request: Request, response: Response) => {
    try {
      await deps.automation.deleteJob(routeParam(request.params.jobId));
      response.status(204).send();
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to delete job.") });
    }
  });

  router.post("/api/automation/jobs/:jobId/enable", async (request: Request, response: Response) => {
    try {
      response.json(await deps.automation.setJobEnabled(routeParam(request.params.jobId), true));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to enable job.") });
    }
  });

  router.post("/api/automation/jobs/:jobId/disable", async (request: Request, response: Response) => {
    try {
      response.json(await deps.automation.setJobEnabled(routeParam(request.params.jobId), false));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to disable job.") });
    }
  });

  router.post("/api/automation/jobs/:jobId/run", async (request: Request, response: Response) => {
    try {
      const force = request.body?.force === true || request.query.force === "1";
      const result = await deps.automation.runJobNow(routeParam(request.params.jobId), { force });
      response.json(result);
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to run job.") });
    }
  });

  router.get("/api/automation/jobs/:jobId/history", (request: Request, response: Response) => {
    try {
      const limit = parseLimit(request.query.limit);
      response.json({
        history: deps.automation.listHistory({
          jobId: routeParam(request.params.jobId),
          limit
        })
      });
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load job history.") });
    }
  });

  router.get("/api/automation/history", (request: Request, response: Response) => {
    try {
      const limit = parseLimit(request.query.limit);
      response.json({
        history: deps.automation.listHistory({
          jobId: typeof request.query.jobId === "string" ? request.query.jobId : undefined,
          webhookId: typeof request.query.webhookId === "string" ? request.query.webhookId : undefined,
          limit
        })
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to load automation history.") });
    }
  });

  // --- Webhook management ---

  router.get("/api/automation/webhooks", (_request: Request, response: Response) => {
    response.json({ webhooks: deps.automation.listWebhooks() });
  });

  router.post("/api/automation/webhooks", async (request: Request, response: Response) => {
    try {
      const input = parseCreateWebhook(request.body);
      const created = await deps.automation.createWebhook(input);
      response.status(201).json(created);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to create webhook.") });
    }
  });

  router.get("/api/automation/webhooks/:webhookId", (request: Request, response: Response) => {
    try {
      response.json(deps.automation.getWebhook(routeParam(request.params.webhookId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load webhook.") });
    }
  });

  router.delete("/api/automation/webhooks/:webhookId", async (request: Request, response: Response) => {
    try {
      await deps.automation.deleteWebhook(routeParam(request.params.webhookId));
      response.status(204).send();
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to delete webhook.") });
    }
  });

  router.post("/api/automation/webhooks/:webhookId/enable", async (request: Request, response: Response) => {
    try {
      response.json(await deps.automation.setWebhookEnabled(routeParam(request.params.webhookId), true));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to enable webhook.") });
    }
  });

  router.post("/api/automation/webhooks/:webhookId/disable", async (request: Request, response: Response) => {
    try {
      response.json(await deps.automation.setWebhookEnabled(routeParam(request.params.webhookId), false));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to disable webhook.") });
    }
  });

  router.post(
    "/api/automation/webhooks/:webhookId/rotate-token",
    async (request: Request, response: Response) => {
      try {
        const rotated = await deps.automation.rotateWebhookToken(routeParam(request.params.webhookId));
        response.json(rotated);
      } catch (error) {
        response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to rotate token.") });
      }
    }
  );

  // --- Inbound local webhook (token-gated) ---

  router.post("/api/hooks/:webhookId", async (request: Request, response: Response) => {
    try {
      const token = extractToken(request);
      if (!token) {
        response.status(401).json({ error: "Webhook token is required (Authorization: Bearer or X-PAW-Webhook-Token)." });
        return;
      }
      const result = await deps.automation.processWebhook({
        webhookId: routeParam(request.params.webhookId),
        token,
        sourceAddress: resolveAddress(request),
        body: request.body as WebhookEventPayload
      });
      const status = result.status === "ok" || result.status === "deduped" ? 200 : 400;
      response.status(status).json(result);
    } catch (error) {
      const code =
        typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode: number }).statusCode)
          : 400;
      response.status(Number.isFinite(code) ? code : 400).json({
        error: errorMessage(error, "Unable to process webhook.")
      });
    }
  });

  return router;
}

/** Standalone Express app for route unit tests (does not touch the main service app). */
export async function createAutomationRouteApp(deps: AutomationRouteDeps): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use(createAutomationRouter(deps));
  return app;
}

// --- parsers ---

function parseCreateJob(body: unknown): CreateAutomationJobInput {
  if (!body || typeof body !== "object") throw new Error("JSON body is required.");
  const record = body as Record<string, unknown>;
  return {
    name: readString(record.name, "name"),
    schedule: parseSchedule(record.schedule),
    action: parseAction(record.action),
    missedRunPolicy: parseMissedPolicy(record.missedRunPolicy),
    enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
    deleteAfterRun: typeof record.deleteAfterRun === "boolean" ? record.deleteAfterRun : undefined
  };
}

function parseUpdateJob(body: unknown): UpdateAutomationJobInput {
  if (!body || typeof body !== "object") throw new Error("JSON body is required.");
  const record = body as Record<string, unknown>;
  const input: UpdateAutomationJobInput = {};
  if (record.name !== undefined) input.name = readString(record.name, "name");
  if (record.schedule !== undefined) input.schedule = parseSchedule(record.schedule);
  if (record.action !== undefined) input.action = parseAction(record.action);
  if (record.missedRunPolicy !== undefined) input.missedRunPolicy = parseMissedPolicy(record.missedRunPolicy);
  if (typeof record.deleteAfterRun === "boolean") input.deleteAfterRun = record.deleteAfterRun;
  return input;
}

function parseCreateWebhook(body: unknown): CreateWebhookInput {
  if (!body || typeof body !== "object") throw new Error("JSON body is required.");
  const record = body as Record<string, unknown>;
  return {
    name: readString(record.name, "name"),
    allowedSources: Array.isArray(record.allowedSources)
      ? record.allowedSources.map((s) => String(s))
      : undefined,
    allowedEventTypes: Array.isArray(record.allowedEventTypes)
      ? record.allowedEventTypes.map((t) => {
          if (typeof t !== "string" || !(webhookEventTypes as readonly string[]).includes(t)) {
            throw new Error(`Unknown event type: ${String(t)}`);
          }
          return t as WebhookEventType;
        })
      : undefined,
    enabled: typeof record.enabled === "boolean" ? record.enabled : undefined
  };
}

function parseSchedule(value: unknown): AutomationSchedule {
  if (!value || typeof value !== "object") throw new Error("schedule is required.");
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(scheduleKinds as readonly string[]).includes(kind)) {
    throw new Error(`schedule.kind must be one of: ${scheduleKinds.join(", ")}`);
  }
  return {
    kind: kind as AutomationSchedule["kind"],
    at: typeof record.at === "string" ? record.at : undefined,
    everyMs: typeof record.everyMs === "number" ? record.everyMs : undefined,
    expr: typeof record.expr === "string" ? record.expr : undefined
  };
}

function parseAction(value: unknown): AutomationAction {
  if (!value || typeof value !== "object") throw new Error("action is required.");
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !(automationActionTypes as readonly string[]).includes(type)) {
    throw new Error(`action.type must be one of: ${automationActionTypes.join(", ")}`);
  }
  switch (type) {
    case "create_todo":
      return {
        type: "create_todo",
        title: readString(record.title, "title"),
        description: optionalString(record.description),
        projectId: optionalString(record.projectId),
        startRun: record.startRun === true,
        initialMessage: optionalString(record.initialMessage)
      };
    case "append_run_message":
      return {
        type: "append_run_message",
        runId: readString(record.runId, "runId"),
        message: readString(record.message, "message")
      };
    case "create_run":
      return {
        type: "create_run",
        todoId: readString(record.todoId, "todoId"),
        message: optionalString(record.message)
      };
    case "trigger_flow":
      return {
        type: "trigger_flow",
        flowId: readString(record.flowId, "flowId"),
        input:
          record.input && typeof record.input === "object" && !Array.isArray(record.input)
            ? (record.input as Record<string, unknown>)
            : undefined
      };
    default:
      throw new Error(`Unsupported action type: ${type}`);
  }
}

function parseMissedPolicy(value: unknown): MissedRunPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(missedRunPolicies as readonly string[]).includes(value)) {
    throw new Error(`missedRunPolicy must be one of: ${missedRunPolicies.join(", ")}`);
  }
  return value as MissedRunPolicy;
}

function extractToken(request: Request): string | undefined {
  const header = request.header("x-paw-webhook-token") ?? request.header("X-PAW-Webhook-Token");
  if (header?.trim()) return header.trim();
  const auth = request.header("authorization") ?? request.header("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  if (typeof request.body?.token === "string" && request.body.token.trim()) {
    return request.body.token.trim();
  }
  return undefined;
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error("limit must be a positive integer.");
  return n;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t || undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function statusFor(error: unknown): number {
  if (typeof error === "object" && error && "statusCode" in error) {
    const code = Number((error as { statusCode: number }).statusCode);
    if (Number.isFinite(code)) return code;
  }
  const message = error instanceof Error ? error.message : "";
  if (/not found/i.test(message)) return 404;
  return 400;
}
