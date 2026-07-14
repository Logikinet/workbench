/**
 * After plan approval: materialize DAG → schedule frontier → start agents.
 * Closes the Partial gap for tasks 20/21 (route + DAG not starting executors).
 */

import type { Run } from "../runs/runService.js";
import type { SubtaskDagService } from "../subtasks/subtaskDagService.js";
import type { ProfessionalAgentService, StartProfessionalAgentInput } from "../execution/professionalAgentService.js";
import type { CodexCliService } from "../codex/codexCliService.js";

export interface PostPlanOrchestratorDeps {
  subtasks: SubtaskDagService;
  professionalAgents?: Pick<ProfessionalAgentService, "start">;
  codexCli?: Pick<CodexCliService, "start">;
  /** Optional log helper. */
  recordLog?: (runId: string, input: { level: "info" | "warn" | "error"; message: string }) => Promise<unknown>;
}

export interface PostPlanOrchestrationResult {
  runId: string;
  dagCreated: boolean;
  scheduled: string[];
  startedAgents: Array<{ subtaskId: string; harness: "api" | "codex-cli"; roleId?: string }>;
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
  const result: PostPlanOrchestrationResult = {
    runId: run.id,
    dagCreated: false,
    scheduled: [],
    startedAgents: [],
    errors: []
  };

  const planVersion = run.planning?.approvedPlanVersion ?? run.planVersions.at(-1)?.version;
  if (!planVersion) {
    result.errors.push("No approved plan version to materialize.");
    return result;
  }

  const latest = run.planVersions.find((p) => p.version === planVersion) ?? run.planVersions.at(-1);
  const steps = latest?.steps ?? [];
  const assessment = run.planning?.assessment;

  let dag;
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
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : "Failed to schedule subtasks.");
      await safeLog(deps, run.id, "error", `计划批准后调度失败：${result.errors.at(-1)}`);
      return result;
    }
  }
  result.scheduled = runningIds;

  for (const subtaskId of runningIds) {
    try {
      const subtask = dag.subtasks.find((entry) => entry.id === subtaskId);
      if (!subtask) {
        result.errors.push(`Subtask ${subtaskId} missing after schedule.`);
        continue;
      }
      const harness = subtask.agentInstance?.harness ?? inferHarness(subtask.requiredCapabilities, assessment?.taskType);
      const roleId = subtask.agentInstance?.roleId;

      if (harness === "codex-cli") {
        if (!deps.codexCli) {
          result.errors.push(`Subtask ${subtaskId}: Codex CLI service unavailable.`);
          continue;
        }
        await deps.codexCli.start(run.id, roleId ? { roleId } : {});
        result.startedAgents.push({ subtaskId, harness: "codex-cli", roleId });
      } else {
        if (!deps.professionalAgents) {
          result.errors.push(`Subtask ${subtaskId}: Professional Agent service unavailable.`);
          continue;
        }
        const input: StartProfessionalAgentInput = roleId ? { roleId } : {};
        await deps.professionalAgents.start(run.id, input);
        result.startedAgents.push({ subtaskId, harness: "api", roleId });
      }
      // Only start the first write-capable agent on the first schedule tick
      // to respect maxParallelWrite=1 at the executor layer.
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent start failed.";
      result.errors.push(`Subtask ${subtaskId}: ${message}`);
      await safeLog(deps, run.id, "warn", `自动启动执行代理失败（${subtaskId}）：${message}`);
    }
  }

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

function inferHarness(
  capabilities: string[] | undefined,
  taskType?: string
): "api" | "codex-cli" {
  const caps = (capabilities ?? []).map((c) => c.toLowerCase());
  if (
    taskType === "implementation" ||
    taskType === "bug_fix" ||
    taskType === "automation" ||
    caps.some((c) => c.includes("codex") || c === "implement" || c.includes("code") || c === "codex-cli")
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
