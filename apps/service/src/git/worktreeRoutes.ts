import type { Express, Request, Response } from "express";
import {
  isWorktreeApplyBusyMessage,
  type KeepPendingResult,
  type WorktreeApplyPreview,
  type WorktreeApplyResult
} from "./worktreeApply.js";
import type { GitWorktreeService } from "./gitWorktreeService.js";

/**
 * Worktree accept / apply / keep-pending routes (Ticket 27).
 *
 * Mount via `registerWorktreeApplyRoutes(app, deps)` from the main HTTP app.
 * This module is intentionally separate so the implementer does not edit app.ts;
 * the main agent should wire it next to existing GET/POST/DELETE worktree routes.
 *
 * Routes:
 * - GET  /api/runs/:runId/worktree/apply/preview  — preflight + Chinese commit draft
 * - POST /api/runs/:runId/worktree/apply          — accept apply { commitMessage? }
 * - POST /api/runs/:runId/worktree/keep-pending   — keep pending (no main mutation)
 *
 * Existing DELETE /api/runs/:runId/worktree remains the discard path in app.ts.
 */

export interface WorktreeApplyRouteRuns {
  get(runId: string): Promise<{
    status: string;
    execution: { status: string; terminationUnconfirmed?: boolean };
    reviews?: unknown[];
    reviewLoop?: unknown;
  }>;
  /** Optional: mark artifacts after successful apply (main agent may wire Run helpers). */
  markWorktreeArtifactsApplied?(runId: string, input: {
    commitSha?: string;
    commitMessage?: string;
  }): Promise<unknown>;
  markWorktreeArtifactsDiscarded?(runId: string): Promise<unknown>;
  /** Task 29: optional review+accept gate before applying worktree to main. */
  canApplyWorktree?(runId: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface WorktreeApplyRouteDeps {
  worktrees: Pick<GitWorktreeService, "previewApply" | "applyToMain" | "keepPending" | "get">;
  runs?: WorktreeApplyRouteRuns;
}

export function registerWorktreeApplyRoutes(app: Express, deps: WorktreeApplyRouteDeps): void {
  app.get("/api/runs/:runId/worktree/apply/preview", async (request, response) => {
    try {
      const preview = await deps.worktrees.previewApply(request.params.runId);
      response.json(preview satisfies WorktreeApplyPreview);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to preview worktree apply.";
      response.status(statusForMessage(message)).json({ error: message });
    }
  });

  app.post("/api/runs/:runId/worktree/apply", async (request, response) => {
    try {
      if (deps.runs) {
        const run = await deps.runs.get(request.params.runId);
        if (run.status === "running" || run.execution.status === "running" || run.execution.terminationUnconfirmed) {
          return response.status(409).json({
            error: "An active or unconfirmed execution must stop before worktree changes can be applied."
          });
        }
        if (deps.runs.canApplyWorktree) {
          const gate = await deps.runs.canApplyWorktree(request.params.runId);
          if (!gate.ok) {
            return response.status(409).json({
              error: gate.reason ?? "独立审查通过并经用户验收后，才能将 Worktree 应用到主工作区。"
            });
          }
        }
      }
      const commitMessage = typeof request.body?.commitMessage === "string"
        ? request.body.commitMessage
        : undefined;
      const result = await deps.worktrees.applyToMain(request.params.runId, { commitMessage });
      if (result.status === "applied" && deps.runs?.markWorktreeArtifactsApplied) {
        await deps.runs.markWorktreeArtifactsApplied(request.params.runId, {
          commitSha: result.commitSha,
          commitMessage: result.commitMessage
        });
      }
      response.status(httpStatusForApply(result)).json(result satisfies WorktreeApplyResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to apply worktree changes.";
      response.status(statusForMessage(message)).json({ error: message });
    }
  });

  app.post("/api/runs/:runId/worktree/keep-pending", async (request, response) => {
    try {
      if (deps.runs) {
        const run = await deps.runs.get(request.params.runId);
        if (run.status === "running" || run.execution.status === "running" || run.execution.terminationUnconfirmed) {
          return response.status(409).json({
            error: "An active or unconfirmed execution must stop before keep-pending can be recorded."
          });
        }
      }
      const result = await deps.worktrees.keepPending(request.params.runId);
      response.json(result satisfies KeepPendingResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to keep worktree pending.";
      response.status(statusForMessage(message)).json({ error: message });
    }
  });
}

/**
 * Structured apply outcomes (including conflict/blocked) use 200 so clients receive
 * conflict file lists without treating them as transport errors.
 * Busy / active-run races still use 409 via thrown messages.
 */
function httpStatusForApply(result: WorktreeApplyResult): number {
  switch (result.status) {
    case "applied":
    case "already_applied":
    case "no_changes":
    case "conflict":
    case "blocked":
    case "keep_pending":
      return 200;
    case "busy":
      return 409;
    default:
      return 400;
  }
}

function statusForMessage(message: string): number {
  if (isWorktreeApplyBusyMessage(message)) return 409;
  if (/未找到|not found/i.test(message)) return 404;
  return 400;
}

/** Optional Express Request typing helper for tests. */
export type WorktreeApplyRequest = Request;
export type WorktreeApplyResponse = Response;
