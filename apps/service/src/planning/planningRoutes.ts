/**
 * Optional HTTP wiring for AI Firstmate / Secondmate planning.
 *
 * Main agent / app.ts should mount this when ModelRuntime + AiPlanningService are constructed:
 *
 *   import { createPlanningRouter } from "../planning/planningRoutes.js";
 *   app.use(createPlanningRouter({ aiPlanning, runs, todos, projects }));
 *
 * This module does NOT edit app.ts (owned by another agent).
 */

import { Router, type Request, type Response } from "express";
import type { AiPlanningService, RunLikePlanningInput } from "./aiPlanningService.js";
import { taskTypes, type TaskType } from "./planningService.js";

export interface PlanningRouteDeps {
  aiPlanning: AiPlanningService;
  /** Minimal Run/Todo/Project accessors — duck-typed to avoid tight coupling. */
  runs: {
    get(runId: string): Promise<{
      id: string;
      todoId: string;
      messages: Array<{ content: string }>;
      status: string;
    }>;
  };
  todos: {
    get(todoId: string): Promise<{
      id: string;
      title: string;
      description?: string;
      projectId?: string;
    }>;
  };
  projects?: {
    get(projectId: string): Promise<{
      id: string;
      name: string;
      summary?: string;
      workspacePath?: string;
    }>;
  };
}

/**
 * POST /api/runs/:runId/ai-planning — run AI Firstmate/Secondmate against Run-like context.
 * Does not mutate formal files; returns assessment/plan for the caller to apply.
 */
export function createPlanningRouter(deps: PlanningRouteDeps): Router {
  const router = Router();

  router.post("/api/runs/:runId/ai-planning", async (request: Request, response: Response) => {
    const runId = routeParam(request.params.runId);
    try {
      const run = await deps.runs.get(runId);
      const todo = await deps.todos.get(run.todoId);
      let project: RunLikePlanningInput["project"];
      if (todo.projectId && deps.projects) {
        try {
          const record = await deps.projects.get(todo.projectId);
          project = {
            id: record.id,
            name: record.name,
            summary: record.summary,
            workspacePath: record.workspacePath
          };
        } catch {
          project = undefined;
        }
      }

      const body = request.body ?? {};
      const taskType = body.taskType;
      if (taskType !== undefined && (typeof taskType !== "string" || !taskTypes.includes(taskType as TaskType))) {
        response.status(400).json({ error: "Task type is invalid." });
        return;
      }
      const requiredCapabilities = body.requiredCapabilities;
      if (
        requiredCapabilities !== undefined
        && (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((value: unknown) => typeof value !== "string"))
      ) {
        response.status(400).json({ error: "Required capabilities must be a string array." });
        return;
      }

      const outcome = await deps.aiPlanning.plan({
        runId: run.id,
        todo: { title: todo.title, description: todo.description },
        messages: run.messages,
        project,
        workspaceSummary: typeof body.workspaceSummary === "string" ? body.workspaceSummary : undefined,
        relatedFiles: Array.isArray(body.relatedFiles) ? body.relatedFiles : undefined,
        revisionNote: typeof body.revisionNote === "string" ? body.revisionNote : undefined,
        overrides: {
          taskType: taskType as TaskType | undefined,
          requiredCapabilities
        }
      });

      response.json({
        runId: run.id,
        outcome,
        formalMutations: outcome.formalMutations,
        dangerousCommands: outcome.dangerousCommands
      });
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Unable to run AI planning."
      });
    }
  });

  return router;
}

function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
