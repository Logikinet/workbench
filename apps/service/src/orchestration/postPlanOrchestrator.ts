/**
 * After plan approval: materialize DAG → schedule frontier → start agents.
 * After agent completion: complete running subtask(s) → schedule → start next agents.
 * Closes the Partial gap for tasks 20/21 (continuous Firstmate multi-agent orchestration).
 */

import type { Run } from "../runs/runService.js";
import type { SubtaskDagService } from "../subtasks/subtaskDagService.js";
import type { ProfessionalAgentService, StartProfessionalAgentInput } from "../execution/professionalAgentService.js";
import type { CodexCliService } from "../codex/codexCliService.js";
import type { SubtaskDag } from "../subtasks/subtaskTypes.js";

export interface PostPlanOrchestratorDeps {
  subtasks: SubtaskDagService;
  professionalAgents?: Pick<ProfessionalAgentService, "start">;
  codexCli?: Pick<CodexCliService, "start">;
  /** Re-open a Run after one agent wave so the next frontier agent can start. */
  prepareContinuedExecution?: (runId: string, summary: string) => Promise<unknown>;
  /** Optional log helper. */
  recordLog?: (runId: string, input: { level: "info" | "warn" | "error"; message: string }) => Promise<unknown>;
  /**
   * When a subtask has no roleId, pick a default executor so multi-agent plans still run.
   * Prefer API roles with connection; Codex for code tasks.
   */
  resolveDefaultRole?: (input: {
    harness: "api" | "codex-cli";
    taskType?: string;
  }) => Promise<{ roleId: string; name: string; harness: "api" | "codex-cli" } | undefined>;
}

export interface PostPlanOrchestrationResult {
  runId: string;
  dagCreated: boolean;
  scheduled: string[];
  startedAgents: Array<{ subtaskId: string; harness: "api" | "codex-cli"; roleId?: string }>;
  completedSubtasks: string[];
  dagComplete: boolean;
  errors: string[];
}

/**
 * Call only after `decidePlan(..., { decision: "approved" })` succeeded.
 * Failures are collected — orchestration must not undo the plan approval.
 */
export async function orchestrateAfterPlanApproval(
  run: Run,
  deps: PostPlanOrchestratorDeps
): Promise<PostPlanOrchestrationResult> {
  const result = emptyResult(run.id);

  const planVersion = run.planning?.approvedPlanVersion ?? run.planVersions.at(-1)?.version;
  if (!planVersion) {
    result.errors.push("No approved plan version to materialize.");
    return result;
  }

  const latest = run.planVersions.find((p) => p.version === planVersion) ?? run.planVersions.at(-1);
  const steps = latest?.steps ?? [];
  const assessment = run.planning?.assessment;

  let dag: SubtaskDag;
  try {
    // createFromApprovedPlan auto-schedules when autoSchedule !== false
    // and returns the DAG (with running frontier subtasks if any).
    dag = await deps.subtasks.createFromApprovedPlan({
      runId: run.id,
      planVersion,
      planApproved: true,
      steps,
      taskType: assessment?.taskType,
      complexity: assessment?.complexity,
      requiredCapabilities: assessment?.requiredCapabilities,
      autoSchedule: true
    });
    result.dagCreated = true;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : "Failed to create subtask DAG.");
    await safeLog(deps, run.id, "error", `计划批准后创建 DAG 失败：${result.errors.at(-1)}`);
    return result;
  }

  // Prefer subtasks already marked running by create+autoSchedule; otherwise schedule now.
  let runningIds = dag.subtasks.filter((s) => s.status === "running").map((s) => s.id);
  if (runningIds.length === 0) {
    try {
      const schedule = await deps.subtasks.schedule(run.id);
      runningIds = schedule.started;
      dag = schedule.dag;
      result.dagComplete = schedule.completed === true;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : "Failed to schedule subtasks.");
      await safeLog(deps, run.id, "error", `计划批准后调度失败：${result.errors.at(-1)}`);
      return result;
    }
  }
  result.scheduled = runningIds;

  await startAgentsForRunning(run.id, dag, runningIds, deps, result, assessment?.taskType);

  if (result.startedAgents.length > 0) {
    await safeLog(
      deps,
      run.id,
      "info",
      `Firstmate 已自动调度 ${result.scheduled.length} 个子任务并启动 ${result.startedAgents.length} 个执行代理。`
    );
  } else if (result.scheduled.length > 0) {
    await safeLog(deps, run.id, "warn", "子任务已进入运行前沿，但未能自动启动执行代理；可手动点击启动。");
  }

  return result;
}

/**
 * Production continuous orchestration: after a Professional Agent or Codex session
 * finishes successfully, mark the current running subtask(s) complete, schedule the
 * next frontier, and start the next executor. Failures do not roll back prior work.
 */
export async function continueAfterAgentCompletion(
  runId: string,
  deps: PostPlanOrchestratorDeps,
  options: {
    outcome: "completed" | "failed";
    summary?: string;
    artifacts?: string[];
    /** When set, only this subtask is completed; otherwise all currently running nodes. */
    subtaskId?: string;
  }
): Promise<PostPlanOrchestrationResult> {
  const result = emptyResult(runId);

  let dag: SubtaskDag;
  try {
    dag = deps.subtasks.getByRunId(runId);
  } catch {
    // No DAG for this run (manual single-agent path) — nothing to continue.
    return result;
  }

  if (options.outcome === "failed") {
    const targetIds = options.subtaskId
      ? [options.subtaskId]
      : dag.subtasks.filter((s) => s.status === "running").map((s) => s.id);
    for (const subtaskId of targetIds) {
      try {
        await deps.subtasks.failSubtask(runId, subtaskId, {
          error: options.summary?.trim() || "执行代理失败。",
          pause: true
        });
        result.completedSubtasks.push(subtaskId);
      } catch (error) {
        result.errors.push(
          error instanceof Error ? error.message : `Failed to mark subtask ${subtaskId} failed.`
        );
      }
    }
    await safeLog(
      deps,
      runId,
      "warn",
      `执行失败，已暂停子任务编排：${options.summary?.trim() || "见日志"}`
    );
    return result;
  }

  // Success: complete running frontier node(s), then schedule + start next.
  const toComplete = options.subtaskId
    ? dag.subtasks.filter((s) => s.id === options.subtaskId && (s.status === "running" || s.status === "ready" || s.status === "paused"))
    : dag.subtasks.filter((s) => s.status === "running");

  // Prefer the first running only when multiple are marked running but only one agent ran.
  // If multiple were intentionally started (read parallel), complete all running.
  const completeList =
    options.subtaskId || toComplete.length <= 1
      ? toComplete
      : // Single-agent-at-a-time auto path started only one executor: complete oldest running first.
        [toComplete.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))[0]!];

  for (const subtask of completeList) {
    try {
      const scheduled = await deps.subtasks.completeSubtask(runId, subtask.id, {
        summary: options.summary,
        artifacts: options.artifacts
      });
      result.completedSubtasks.push(subtask.id);
      dag = scheduled.dag;
      result.scheduled = scheduled.started;
      result.dagComplete = scheduled.completed === true;
    } catch (error) {
      result.errors.push(
        error instanceof Error ? error.message : `Failed to complete subtask ${subtask.id}.`
      );
    }
  }

  // If completeSubtask did not auto-schedule (or no new starts), try schedule once more.
  if (!result.dagComplete && result.scheduled.length === 0) {
    try {
      const scheduled = await deps.subtasks.schedule(runId);
      dag = scheduled.dag;
      result.scheduled = scheduled.started;
      result.dagComplete = scheduled.completed === true;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : "Failed to schedule next subtasks.");
      return result;
    }
  }

  if (result.dagComplete || result.scheduled.length === 0) {
    if (result.dagComplete) {
      await safeLog(deps, runId, "info", "子任务 DAG 已全部完成，可进入独立审查。");
    }
    return result;
  }

  // Prior agent called finishProfessionalExecution → Run is awaiting_review/succeeded.
  // Re-open so the next frontier agent can begin on the same Run.
  if (deps.prepareContinuedExecution) {
    try {
      await deps.prepareContinuedExecution(
        runId,
        `子任务 ${result.completedSubtasks.join(", ") || "当前节点"} 已完成，准备启动下一代理。`
      );
    } catch (error) {
      result.errors.push(
        error instanceof Error ? error.message : "Failed to prepare continued execution."
      );
      return result;
    }
  }

  await startAgentsForRunning(runId, dag, result.scheduled, deps, result, dag.taskType);

  if (result.startedAgents.length > 0) {
    await safeLog(
      deps,
      runId,
      "info",
      `连续编排：已完成 ${result.completedSubtasks.length} 个子任务，启动下一代理 ${result.startedAgents.map((a) => a.subtaskId).join(", ")}。`
    );
  }

  return result;
}

async function startAgentsForRunning(
  runId: string,
  dag: SubtaskDag,
  runningIds: string[],
  deps: PostPlanOrchestratorDeps,
  result: PostPlanOrchestrationResult,
  taskType?: string
): Promise<void> {
  for (const subtaskId of runningIds) {
    try {
      const subtask = dag.subtasks.find((entry) => entry.id === subtaskId);
      if (!subtask) {
        result.errors.push(`Subtask ${subtaskId} missing after schedule.`);
        continue;
      }
      let harness =
        subtask.agentInstance?.harness ?? inferHarness(subtask.requiredCapabilities, taskType);
      let roleId = subtask.agentInstance?.roleId;

      // Resolve a real Role when routing left the node unassigned.
      if (!roleId && deps.resolveDefaultRole) {
        const fallback = await deps.resolveDefaultRole({ harness, taskType });
        if (fallback) {
          roleId = fallback.roleId;
          harness = fallback.harness;
          subtask.agentInstance = {
            roleId: fallback.roleId,
            name: fallback.name,
            harness: fallback.harness,
            source: "role"
          };
        }
      }

      if (harness === "codex-cli") {
        if (!deps.codexCli) {
          result.errors.push(`Subtask ${subtaskId}: Codex CLI service unavailable.`);
          continue;
        }
        await deps.codexCli.start(runId, roleId ? { roleId } : {});
        result.startedAgents.push({ subtaskId, harness: "codex-cli", roleId });
      } else {
        if (!deps.professionalAgents) {
          result.errors.push(`Subtask ${subtaskId}: Professional Agent service unavailable.`);
          continue;
        }
        const input: StartProfessionalAgentInput = roleId
          ? { roleId }
          : subtask.agentInstance?.connectionId
            ? {
                temporaryAgent: {
                  name: subtask.agentInstance.name || `执行 · ${subtask.title}`,
                  connectionId: subtask.agentInstance.connectionId,
                  modelId: subtask.agentInstance.modelId,
                  responsibility: subtask.title,
                  systemInstruction: `你负责子任务：${subtask.title}。仅在批准计划与项目工作区内完成，并回报可验证结果。`,
                  tools: subtask.agentInstance.tools ?? ["filesystem"]
                }
              }
            : {};
        if (!input.roleId && !input.temporaryAgent) {
          result.errors.push(
            `Subtask ${subtaskId}: 没有可分配的执行角色，请到 Agents 配置并绑定模型连接。`
          );
          continue;
        }
        await deps.professionalAgents.start(runId, input);
        result.startedAgents.push({ subtaskId, harness: "api", roleId });
      }
      // Only start the first write-capable agent on each schedule tick
      // to respect maxParallelWrite=1 at the executor layer.
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent start failed.";
      // If agent already active for this run, treat as soft success for that subtask.
      if (/already has an active/i.test(message)) {
        result.startedAgents.push({
          subtaskId,
          harness: "api",
          roleId: dag.subtasks.find((s) => s.id === subtaskId)?.agentInstance?.roleId
        });
        break;
      }
      result.errors.push(`Subtask ${subtaskId}: ${message}`);
      await safeLog(deps, runId, "warn", `自动启动执行代理失败（${subtaskId}）：${message}`);
    }
  }
}

function emptyResult(runId: string): PostPlanOrchestrationResult {
  return {
    runId,
    dagCreated: false,
    scheduled: [],
    startedAgents: [],
    completedSubtasks: [],
    dagComplete: false,
    errors: []
  };
}

function inferHarness(
  capabilities: string[] | undefined,
  taskType?: string
): "api" | "codex-cli" {
  const caps = (capabilities ?? []).map((c) => c.toLowerCase());
  // Prefer codex for code-shaped work only when capabilities explicitly request it.
  // Default to API so local installs without Codex CLI still execute (not a dead shell).
  if (
    caps.some((c) => c.includes("codex") || c === "codex-cli") ||
    ((taskType === "implementation" || taskType === "bug_fix" || taskType === "automation") &&
      caps.some((c) => c === "implement" || c.includes("code")))
  ) {
    return "codex-cli";
  }
  return "api";
}

async function safeLog(
  deps: PostPlanOrchestratorDeps,
  runId: string,
  level: "info" | "warn" | "error",
  message: string
): Promise<void> {
  if (!deps.recordLog) return;
  try {
    await deps.recordLog(runId, { level, message });
  } catch {
    // ignore logging failures
  }
}
