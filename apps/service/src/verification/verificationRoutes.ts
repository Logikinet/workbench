/**
 * Project-aware verification HTTP routes (Ticket 25).
 *
 * Mount via `registerVerificationRoutes(app, deps)` from the main HTTP app.
 * This module is intentionally separate so the implementer does not edit app.ts;
 * the main agent should wire it next to planning / worktree routes.
 *
 * Routes:
 * - POST /api/verification/detect              { workspacePath }
 * - POST /api/verification/propose             { workspacePath, taskType?, userCommands?, ... }
 * - POST /api/verification/evidence            { results, stackPrimary, planVersion?, manualChecklist? }
 * - POST /api/verification/check-execution     { requested, approved }
 * - POST /api/runs/:runId/verification/propose — resolve workspace from Run/Todo/Project
 * - PATCH /api/runs/:runId/verification        — persist edited commands onto Run planning
 */

import type { Express, Request, Response } from "express";
import { createVerificationService, type VerificationService } from "./verificationService.js";
import { taskTypes as verificationTaskTypes, type VerificationTaskType } from "./taskTypes.js";
import type { VerificationPlan, VerificationResultRow } from "./types.js";

export interface VerificationRouteRuns {
  get(runId: string): Promise<{
    id: string;
    todoId: string;
    planning?: {
      assessment?: { taskType?: string };
      approvalStatus?: string;
      approvedPlanVersion?: number;
      verificationCommands?: string[][];
    };
    planVersions?: Array<{ version: number; verificationCommands?: string[][] }>;
  }>;
  updatePlanning?(runId: string, input: {
    taskType?: VerificationTaskType;
    requiredCapabilities?: string[];
    verificationCommands?: string[][];
    additionalContext?: string;
  }): Promise<unknown>;
}

export interface VerificationRouteTodos {
  get(todoId: string): Promise<{ id: string; projectId?: string; title?: string; description?: string }>;
}

export interface VerificationRouteProjects {
  get(projectId: string): Promise<{ id: string; workspacePath?: string; name?: string }>;
}

export interface VerificationRouteDeps {
  verification?: VerificationService;
  runs?: VerificationRouteRuns;
  todos?: VerificationRouteTodos;
  projects?: VerificationRouteProjects;
}

export function registerVerificationRoutes(app: Express, deps: VerificationRouteDeps = {}): void {
  const verification = deps.verification ?? createVerificationService();

  app.post("/api/verification/detect", async (request, response) => {
    const workspacePath = request.body?.workspacePath;
    if (typeof workspacePath !== "string" || !workspacePath.trim()) {
      return response.status(400).json({ error: "workspacePath is required." });
    }
    try {
      response.json(await verification.detect(workspacePath.trim()));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to detect project stack.") });
    }
  });

  app.post("/api/verification/propose", async (request, response) => {
    const workspacePath = request.body?.workspacePath;
    if (typeof workspacePath !== "string" || !workspacePath.trim()) {
      return response.status(400).json({ error: "workspacePath is required." });
    }
    const taskType = parseTaskType(request.body?.taskType);
    if (request.body?.taskType !== undefined && !taskType) {
      return response.status(400).json({ error: "taskType is invalid." });
    }
    try {
      const plan = await verification.proposeFromWorkspace({
        workspacePath: workspacePath.trim(),
        taskType: taskType ?? undefined,
        userCommands: parseCommandLists(request.body?.userCommands),
        disabledCommands: parseCommandLists(request.body?.disabledCommands),
        supplementalCommands: parseCommandLists(request.body?.supplementalCommands),
        userConstraints: typeof request.body?.userConstraints === "string" ? request.body.userConstraints : undefined
      });
      response.json(plan);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to propose verification plan.") });
    }
  });

  app.post("/api/verification/evidence", (request, response) => {
    const results = parseResults(request.body?.results);
    if (!results) {
      return response.status(400).json({ error: "results must be an array of { command, exitCode, stdout, stderr }." });
    }
    const stackPrimary = request.body?.stackPrimary;
    if (typeof stackPrimary !== "string" || !stackPrimary.trim()) {
      return response.status(400).json({ error: "stackPrimary is required." });
    }
    try {
      response.json(verification.buildEvidence({
        results,
        stackPrimary: stackPrimary as VerificationPlan["stack"]["primary"],
        planVersion: typeof request.body?.planVersion === "number" ? request.body.planVersion : undefined
      }));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to build verification evidence.") });
    }
  });

  app.post("/api/verification/check-execution", (request, response) => {
    const requested = parseCommandLists(request.body?.requested);
    const approved = parseCommandLists(request.body?.approved);
    if (!requested || !approved) {
      return response.status(400).json({ error: "requested and approved must be command argument arrays." });
    }
    try {
      response.json(verification.checkExecution(requested, approved));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to check execution.") });
    }
  });

  app.post("/api/runs/:runId/verification/propose", async (request: Request, response: Response) => {
    if (!deps.runs || !deps.todos) {
      return response.status(503).json({ error: "Run and Todo services are required for run-scoped verification." });
    }
    try {
      const run = await deps.runs.get(routeParam(request.params.runId));
      const todo = await deps.todos.get(run.todoId);
      let workspacePath =
        typeof request.body?.workspacePath === "string" ? request.body.workspacePath.trim() : "";
      if (!workspacePath && todo.projectId && deps.projects) {
        try {
          const project = await deps.projects.get(todo.projectId);
          workspacePath = project.workspacePath?.trim() ?? "";
        } catch {
          workspacePath = "";
        }
      }
      if (!workspacePath) {
        return response.status(400).json({ error: "Project workspacePath is required to propose verification." });
      }
      const taskType =
        parseTaskType(request.body?.taskType)
        ?? parseTaskType(run.planning?.assessment?.taskType)
        ?? undefined;
      const plan = await verification.proposeFromWorkspace({
        workspacePath,
        taskType,
        userCommands: parseCommandLists(request.body?.userCommands),
        disabledCommands: parseCommandLists(request.body?.disabledCommands),
        supplementalCommands: parseCommandLists(request.body?.supplementalCommands),
        userConstraints: typeof request.body?.userConstraints === "string" ? request.body.userConstraints : undefined
      });
      response.json(plan);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to propose verification for run.") });
    }
  });

  app.patch("/api/runs/:runId/verification", async (request: Request, response: Response) => {
    if (!deps.runs?.updatePlanning) {
      return response.status(503).json({ error: "Run planning updates are not available." });
    }
    const commands = parseCommandLists(request.body?.verificationCommands ?? request.body?.commands);
    if (commands === undefined && request.body?.verificationCommands === undefined && request.body?.commands === undefined) {
      return response.status(400).json({ error: "verificationCommands must be an array of command argument arrays." });
    }
    if (commands === undefined && (request.body?.verificationCommands !== undefined || request.body?.commands !== undefined)) {
      return response.status(400).json({ error: "verificationCommands must be an array of command argument arrays." });
    }
    const taskType = parseTaskType(request.body?.taskType);
    if (request.body?.taskType !== undefined && !taskType) {
      return response.status(400).json({ error: "taskType is invalid." });
    }
    const requiredCapabilities = request.body?.requiredCapabilities;
    if (
      requiredCapabilities !== undefined
      && (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((value: unknown) => typeof value !== "string"))
    ) {
      return response.status(400).json({ error: "requiredCapabilities must be a string array." });
    }
    // Empty commands array is allowed (manual checklist only).
    try {
      const updated = await deps.runs.updatePlanning(routeParam(request.params.runId), {
        taskType,
        requiredCapabilities,
        verificationCommands: commands,
        additionalContext: typeof request.body?.additionalContext === "string" ? request.body.additionalContext : undefined
      });
      response.json(updated);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error, "Unable to update verification commands.") });
    }
  });
}

function parseTaskType(value: unknown): VerificationTaskType | undefined {
  if (typeof value !== "string") return undefined;
  return (verificationTaskTypes as readonly string[]).includes(value) ? value as VerificationTaskType : undefined;
}

function parseCommandLists(value: unknown): string[][] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  if (!value.every((command) => Array.isArray(command) && command.every((part) => typeof part === "string"))) {
    return undefined;
  }
  return value.map((command: string[]) => command.map((part) => part));
}

function parseResults(value: unknown): VerificationResultRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: VerificationResultRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    const command = (entry as { command?: unknown }).command;
    if (!Array.isArray(command) || !command.every((part) => typeof part === "string")) return undefined;
    const exitCode = (entry as { exitCode?: unknown }).exitCode;
    if (!(exitCode === null || typeof exitCode === "number")) return undefined;
    rows.push({
      command: command as string[],
      exitCode: exitCode as number | null,
      stdout: typeof (entry as { stdout?: unknown }).stdout === "string" ? (entry as { stdout: string }).stdout : "",
      stderr: typeof (entry as { stderr?: unknown }).stderr === "string" ? (entry as { stderr: string }).stderr : ""
    });
  }
  return rows;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
