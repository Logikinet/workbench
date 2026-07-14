/**
 * HTTP routes for Subtask DAG orchestration (Task 21).
 *
 * Mount from main / app.ts:
 *
 *   import { createSubtaskRouter } from "../subtasks/subtaskRoutes.js";
 *   app.use(createSubtaskRouter({ subtasks }));
 *
 * Routes:
 * - POST   /api/subtasks/from-plan                 — create DAG from approved plan (auto-schedules)
 * - GET    /api/subtasks                           — list DAGs
 * - GET    /api/subtasks/runs/:runId               — DAG for a run (status, frontier, agents, times)
 * - GET    /api/subtasks/runs/:runId/frontier      — current execution frontier
 * - POST   /api/subtasks/runs/:runId/schedule      — Firstmate schedule tick
 * - POST   /api/subtasks/runs/:runId/subtasks/:id/complete
 * - POST   /api/subtasks/runs/:runId/subtasks/:id/fail
 * - POST   /api/subtasks/runs/:runId/subtasks/:id/assign
 * - POST   /api/subtasks/runs/:runId/correct       — scoped correction / major → AskReplan
 * - POST   /api/subtasks/runs/:runId/checkpoint
 * - POST   /api/subtasks/runs/:runId/resume
 */

import { Router, type Request, type Response } from "express";
import type { SubtaskDagService } from "./subtaskDagService.js";
import type {
  CompleteSubtaskInput,
  CorrectionInput,
  CreateDagFromPlanInput,
  FailSubtaskInput,
  SubtaskAgentInstance
} from "./subtaskTypes.js";

export interface SubtaskRouteDeps {
  subtasks: SubtaskDagService;
}

export function createSubtaskRouter(deps: SubtaskRouteDeps): Router {
  const router = Router();

  router.post("/api/subtasks/from-plan", async (request: Request, response: Response) => {
    try {
      const body = parseCreateInput(request.body);
      const dag = await deps.subtasks.createFromApprovedPlan(body);
      response.status(201).json(dag);
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to create subtask DAG.") });
    }
  });

  router.get("/api/subtasks", async (_request: Request, response: Response) => {
    try {
      response.json(deps.subtasks.list());
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to list subtask DAGs.") });
    }
  });

  router.get("/api/subtasks/runs/:runId", async (request: Request, response: Response) => {
    try {
      response.json(deps.subtasks.getByRunId(routeParam(request.params.runId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load subtask DAG.") });
    }
  });

  router.get("/api/subtasks/runs/:runId/frontier", async (request: Request, response: Response) => {
    try {
      const runId = routeParam(request.params.runId);
      const dag = deps.subtasks.getByRunId(runId);
      response.json({ runId, frontier: deps.subtasks.getFrontier(runId), dagStatus: dag.status });
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to load frontier.") });
    }
  });

  router.post("/api/subtasks/runs/:runId/schedule", async (request: Request, response: Response) => {
    try {
      response.json(await deps.subtasks.schedule(routeParam(request.params.runId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to schedule subtasks.") });
    }
  });

  router.post("/api/subtasks/runs/:runId/subtasks/:subtaskId/complete", async (request: Request, response: Response) => {
    try {
      const input = parseComplete(request.body);
      response.json(
        await deps.subtasks.completeSubtask(
          routeParam(request.params.runId),
          routeParam(request.params.subtaskId),
          input
        )
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to complete subtask.") });
    }
  });

  router.post("/api/subtasks/runs/:runId/subtasks/:subtaskId/fail", async (request: Request, response: Response) => {
    try {
      const input = parseFail(request.body);
      response.json(
        await deps.subtasks.failSubtask(
          routeParam(request.params.runId),
          routeParam(request.params.subtaskId),
          input
        )
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to fail subtask.") });
    }
  });

  router.post("/api/subtasks/runs/:runId/subtasks/:subtaskId/assign", async (request: Request, response: Response) => {
    try {
      const agent = parseAgent(request.body);
      response.json(
        await deps.subtasks.assignAgent(
          routeParam(request.params.runId),
          routeParam(request.params.subtaskId),
          agent
        )
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to assign agent.") });
    }
  });

  router.post("/api/subtasks/runs/:runId/correct", async (request: Request, response: Response) => {
    try {
      const input = parseCorrection(request.body);
      response.json(await deps.subtasks.applyCorrection(routeParam(request.params.runId), input));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to apply correction.") });
    }
  });

  router.post("/api/subtasks/runs/:runId/checkpoint", async (request: Request, response: Response) => {
    try {
      const note = typeof request.body?.note === "string" ? request.body.note : undefined;
      response.json(await deps.subtasks.saveCheckpoint(routeParam(request.params.runId), note));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to checkpoint DAG.") });
    }
  });

  router.post("/api/subtasks/runs/:runId/resume", async (request: Request, response: Response) => {
    try {
      response.json(await deps.subtasks.resumeFromCheckpoint(routeParam(request.params.runId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: errorMessage(error, "Unable to resume DAG.") });
    }
  });

  return router;
}

function parseCreateInput(body: unknown): CreateDagFromPlanInput {
  const value = (body ?? {}) as Record<string, unknown>;
  if (typeof value.runId !== "string" || !value.runId.trim()) {
    throw new Error("runId is required.");
  }
  if (typeof value.planVersion !== "number" || !Number.isFinite(value.planVersion)) {
    throw new Error("planVersion is required.");
  }
  const steps = Array.isArray(value.steps)
    ? value.steps.filter((s): s is string => typeof s === "string")
    : [];
  const list = (key: string) =>
    Array.isArray(value[key]) ? value[key].filter((entry): entry is string => typeof entry === "string") : undefined;

  let explicitSubtasks: CreateDagFromPlanInput["explicitSubtasks"];
  if (value.explicitSubtasks !== undefined) {
    if (!Array.isArray(value.explicitSubtasks)) throw new Error("explicitSubtasks must be an array.");
    explicitSubtasks = value.explicitSubtasks.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`explicitSubtasks[${index}] is invalid.`);
      }
      const item = entry as Record<string, unknown>;
      if (typeof item.title !== "string" || !item.title.trim()) {
        throw new Error(`explicitSubtasks[${index}].title is required.`);
      }
      return {
        id: typeof item.id === "string" ? item.id : undefined,
        title: item.title,
        description: typeof item.description === "string" ? item.description : undefined,
        requiredCapabilities: Array.isArray(item.requiredCapabilities)
          ? item.requiredCapabilities.filter((c): c is string => typeof c === "string")
          : undefined,
        inputs: Array.isArray(item.inputs) ? item.inputs.filter((c): c is string => typeof c === "string") : undefined,
        outputs: Array.isArray(item.outputs)
          ? item.outputs.filter((c): c is string => typeof c === "string")
          : undefined,
        dependsOn: Array.isArray(item.dependsOn)
          ? item.dependsOn.filter((c): c is string => typeof c === "string")
          : undefined,
        acceptanceCriteria: Array.isArray(item.acceptanceCriteria)
          ? item.acceptanceCriteria.filter((c): c is string => typeof c === "string")
          : undefined,
        accessMode: item.accessMode === "read_only" || item.accessMode === "write" ? item.accessMode : undefined,
        independentWorktree: typeof item.independentWorktree === "boolean" ? item.independentWorktree : undefined,
        routingInstanceId: typeof item.routingInstanceId === "string" ? item.routingInstanceId : undefined
      };
    });
  }

  let routingSelections: CreateDagFromPlanInput["routingSelections"];
  if (value.routingSelections !== undefined) {
    if (!Array.isArray(value.routingSelections)) throw new Error("routingSelections must be an array.");
    routingSelections = value.routingSelections.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`routingSelections[${index}] is invalid.`);
      }
      const item = entry as Record<string, unknown>;
      if (typeof item.instanceId !== "string" || typeof item.name !== "string") {
        throw new Error(`routingSelections[${index}] requires instanceId and name.`);
      }
      return {
        instanceId: item.instanceId,
        name: item.name,
        roleId: typeof item.roleId === "string" ? item.roleId : undefined,
        temporaryRoleId: typeof item.temporaryRoleId === "string" ? item.temporaryRoleId : undefined,
        harness: item.harness === "api" || item.harness === "codex-cli" ? item.harness : undefined,
        modelId: typeof item.modelId === "string" ? item.modelId : undefined,
        connectionId: typeof item.connectionId === "string" ? item.connectionId : undefined,
        skills: Array.isArray(item.skills) ? item.skills.filter((c): c is string => typeof c === "string") : undefined,
        tools: Array.isArray(item.tools) ? item.tools.filter((c): c is string => typeof c === "string") : undefined
      };
    });
  }

  const complexity =
    value.complexity === "low" || value.complexity === "medium" || value.complexity === "high"
      ? value.complexity
      : undefined;

  return {
    runId: value.runId.trim(),
    planVersion: value.planVersion,
    steps,
    acceptanceCriteria: list("acceptanceCriteria"),
    requiredCapabilities: list("requiredCapabilities"),
    taskType: typeof value.taskType === "string" ? (value.taskType as CreateDagFromPlanInput["taskType"]) : undefined,
    complexity,
    expectedArtifacts: list("expectedArtifacts"),
    allowedScope: list("allowedScope"),
    explicitSubtasks,
    autoSchedule: typeof value.autoSchedule === "boolean" ? value.autoSchedule : undefined,
    planApproved: value.planApproved === true || value.planApproved === undefined ? true : false,
    routingSelections,
    maxParallelRead: typeof value.maxParallelRead === "number" ? value.maxParallelRead : undefined,
    maxParallelIndependentWrite:
      typeof value.maxParallelIndependentWrite === "number" ? value.maxParallelIndependentWrite : undefined
  };
}

function parseComplete(body: unknown): CompleteSubtaskInput {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    artifacts: Array.isArray(value.artifacts)
      ? value.artifacts.filter((c): c is string => typeof c === "string")
      : undefined,
    summary: typeof value.summary === "string" ? value.summary : undefined
  };
}

function parseFail(body: unknown): FailSubtaskInput {
  const value = (body ?? {}) as Record<string, unknown>;
  if (typeof value.error !== "string" || !value.error.trim()) {
    throw new Error("error is required.");
  }
  return {
    error: value.error,
    pause: typeof value.pause === "boolean" ? value.pause : undefined
  };
}

function parseCorrection(body: unknown): CorrectionInput {
  const value = (body ?? {}) as Record<string, unknown>;
  if (typeof value.note !== "string" || !value.note.trim()) {
    throw new Error("note is required.");
  }
  return {
    note: value.note,
    major: typeof value.major === "boolean" ? value.major : undefined,
    relatedSubtaskIds: Array.isArray(value.relatedSubtaskIds)
      ? value.relatedSubtaskIds.filter((c): c is string => typeof c === "string")
      : undefined
  };
}

function parseAgent(body: unknown): SubtaskAgentInstance {
  const value = (body ?? {}) as Record<string, unknown>;
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("agent name is required.");
  }
  return {
    name: value.name.trim(),
    roleId: typeof value.roleId === "string" ? value.roleId : undefined,
    temporaryRoleId: typeof value.temporaryRoleId === "string" ? value.temporaryRoleId : undefined,
    harness: value.harness === "api" || value.harness === "codex-cli" ? value.harness : undefined,
    modelId: typeof value.modelId === "string" ? value.modelId : undefined,
    connectionId: typeof value.connectionId === "string" ? value.connectionId : undefined,
    skills: Array.isArray(value.skills) ? value.skills.filter((c): c is string => typeof c === "string") : undefined,
    tools: Array.isArray(value.tools) ? value.tools.filter((c): c is string => typeof c === "string") : undefined,
    source:
      value.source === "role"
      || value.source === "temporary"
      || value.source === "user_specified"
      || value.source === "user_override"
      || value.source === "unassigned"
        ? value.source
        : undefined
  };
}

function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (/was not found/i.test(message)) return 404;
  return 400;
}
