/**
 * Subtask DAG orchestration (Task 21).
 *
 * Converts approved plans into a trackable dependency graph and lets Firstmate
 * continuously schedule professional agents along the frontier:
 * - only completed-deps tasks enter the frontier
 * - write tasks serial (max 1); read-only / independent worktree may parallel (≤3)
 * - fail / block / pause prevent downstream
 * - user correction scopes unfinished work; major → AskReplan signal
 * - durable subtasks.json + checkpoint/resume from frontier
 *
 * Does not mutate skills, MCP, tools, codex, git, verification, askUser, or routing.
 * Optional RoleRouterService may be injected only for selection hints.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AppendRemediationResult,
  AppendRemediationSubtasksInput,
  CompleteSubtaskInput,
  CorrectionInput,
  CorrectionResult,
  CreateDagFromPlanInput,
  DagCheckpoint,
  ExplicitSubtaskDef,
  FailSubtaskInput,
  ResumeResult,
  RoutingSelectionHint,
  ScheduleResult,
  Subtask,
  SubtaskAccessMode,
  SubtaskAgentInstance,
  SubtaskDag,
  SubtaskPermissions,
  SubtaskStateFile,
  SubtaskStatus,
  TaskType
} from "./subtaskTypes.js";

export interface SubtaskDagServiceOptions {
  /** Optional clock for tests. */
  now?: () => Date;
  /**
   * Optional role router used only to attach selection hints after plan approve.
   * Import type only — routing module is not modified.
   */
  roleRouter?: {
    route(request: {
      runId?: string;
      taskType?: TaskType;
      complexity?: "low" | "medium" | "high";
      requiredCapabilities?: string[];
      planApproved?: boolean;
      verifyAvailability?: boolean;
      instances?: Array<{
        id: string;
        name?: string;
        capabilities?: string[];
        permissions?: Partial<SubtaskPermissions>;
      }>;
    }): Promise<{
      queuePayload: {
        selections: Array<{
          instanceId: string;
          roleId?: string;
          temporaryRoleId?: string;
          name: string;
          harness: "api" | "codex-cli";
          modelId?: string;
          connectionId?: string;
          skills: string[];
          tools: string[];
          source: SubtaskAgentInstance["source"];
          permissions?: SubtaskPermissions;
        }>;
      };
      canAutoQueue: boolean;
    }>;
  };
}

const READ_ONLY_STEP_PATTERN =
  /(调研|研究|分析|查阅|只读|调查|证据|research|analy[sz]e|analysis|review|read[- ]only|investigate|inspect)/i;
const WRITE_STEP_PATTERN =
  /(实现|修改|修复|写入|创建|删除|提交|implement|write|fix|edit|create|delete|patch|refactor|automate|自动化)/i;

function emptyState(): SubtaskStateFile {
  return { schemaVersion: 1, dags: [] };
}

export class SubtaskDagService {
  private readonly now: () => Date;

  private constructor(
    private readonly statePath: string,
    private state: SubtaskStateFile,
    private readonly options: SubtaskDagServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  static async open(statePath: string, options: SubtaskDagServiceOptions = {}): Promise<SubtaskDagService> {
    try {
      const decoded = JSON.parse(await readFile(statePath, "utf8")) as Partial<SubtaskStateFile>;
      if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.dags)) {
        throw new Error("Subtask state is not compatible with this service version.");
      }
      return new SubtaskDagService(statePath, { schemaVersion: 1, dags: decoded.dags as SubtaskDag[] }, options);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return new SubtaskDagService(statePath, emptyState(), options);
      }
      throw error;
    }
  }

  /** Create a DAG from an approved plan. Replaces any existing DAG for the same runId. */
  async createFromApprovedPlan(input: CreateDagFromPlanInput): Promise<SubtaskDag> {
    if (!input.runId?.trim()) throw new Error("runId is required.");
    if (!Number.isFinite(input.planVersion) || input.planVersion < 1) {
      throw new Error("planVersion must be a positive number.");
    }
    if (input.planApproved !== true) {
      throw new Error("Subtask DAG can only be created from an approved plan.");
    }

    const steps = Array.isArray(input.steps) ? input.steps.map((s) => String(s).trim()).filter(Boolean) : [];
    if (steps.length === 0 && (!input.explicitSubtasks || input.explicitSubtasks.length === 0)) {
      throw new Error("Plan must include at least one step or explicit subtask.");
    }

    const now = this.now().toISOString();
    const subtasks = input.explicitSubtasks?.length
      ? buildFromExplicit(input, now)
      : buildFromSteps({ ...input, steps }, now);

    // Optional routing hints (pre-supplied or via RoleRouter).
    let selections = input.routingSelections ?? [];
    if (selections.length === 0 && this.options.roleRouter) {
      try {
        const decision = await this.options.roleRouter.route({
          runId: input.runId,
          taskType: input.taskType,
          complexity: input.complexity,
          requiredCapabilities: input.requiredCapabilities,
          planApproved: true,
          verifyAvailability: false,
          instances: subtasks.map((s) => ({
            id: s.id,
            name: s.title,
            capabilities: s.requiredCapabilities,
            permissions: s.permissions
          }))
        });
        selections = decision.queuePayload.selections.map((sel) => ({
          instanceId: sel.instanceId,
          roleId: sel.roleId,
          temporaryRoleId: sel.temporaryRoleId,
          name: sel.name,
          harness: sel.harness,
          modelId: sel.modelId,
          connectionId: sel.connectionId,
          skills: sel.skills,
          tools: sel.tools,
          source: sel.source,
          permissions: sel.permissions
        }));
      } catch {
        // Routing is optional — DAG still schedules without pre-assigned roles.
      }
    }
    applyRoutingHints(subtasks, selections);

    const dag: SubtaskDag = {
      id: randomUUID(),
      runId: input.runId.trim(),
      planVersion: input.planVersion,
      taskType: input.taskType,
      complexity: input.complexity,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      subtasks,
      autoSchedule: input.autoSchedule !== false,
      maxParallelWrite: 1,
      maxParallelRead: clampParallel(input.maxParallelRead ?? 3),
      maxParallelIndependentWrite: clampParallel(input.maxParallelIndependentWrite ?? 2),
      frontier: [],
      needsAskReplan: false,
      planApproved: true
    };

    recomputeStatuses(dag);
    this.state.dags = this.state.dags.filter((entry) => entry.runId !== dag.runId);
    this.state.dags.push(dag);
    await this.persist();

    if (dag.autoSchedule) {
      return (await this.schedule(dag.runId)).dag;
    }
    return cloneDag(dag);
  }

  getByRunId(runId: string): SubtaskDag {
    const dag = this.state.dags.find((entry) => entry.runId === runId);
    if (!dag) throw new Error(`Subtask DAG for run ${runId} was not found.`);
    return cloneDag(dag);
  }

  list(): SubtaskDag[] {
    return this.state.dags.map(cloneDag);
  }

  getSubtask(runId: string, subtaskId: string): Subtask {
    const dag = this.requireDag(runId);
    const subtask = dag.subtasks.find((entry) => entry.id === subtaskId);
    if (!subtask) throw new Error(`Subtask ${subtaskId} was not found for run ${runId}.`);
    return cloneSubtask(subtask);
  }

  /**
   * Pure frontier: ready subtask ids whose dependencies are all completed.
   * Exposed for tests and inspectors.
   */
  getFrontier(runId: string): string[] {
    const dag = this.requireDag(runId);
    return [...computeFrontierIds(dag.subtasks)];
  }

  /** Firstmate continuous scheduling tick. */
  async schedule(runId: string): Promise<ScheduleResult> {
    const dag = this.requireDag(runId);
    if (dag.needsAskReplan) {
      return {
        dag: cloneDag(dag),
        started: [],
        frontier: [...dag.frontier],
        blocked: dag.subtasks.filter((s) => s.status === "blocked").map((s) => s.id),
        completed: isDagFullyDone(dag)
      };
    }
    if (dag.status === "awaiting_replan" || dag.status === "paused") {
      recomputeStatuses(dag);
      await this.persist();
      return {
        dag: cloneDag(dag),
        started: [],
        frontier: [...dag.frontier],
        blocked: dag.subtasks.filter((s) => s.status === "blocked").map((s) => s.id),
        completed: isDagFullyDone(dag)
      };
    }

    recomputeStatuses(dag);
    const started: string[] = [];
    const now = this.now().toISOString();
    const candidates = dag.subtasks.filter((s) => s.status === "ready");

    for (const candidate of orderForSchedule(candidates)) {
      if (!canStartNow(dag, candidate)) continue;
      candidate.status = "running";
      candidate.startedAt = now;
      candidate.error = undefined;
      candidate.blockedReason = undefined;
      if (!candidate.agentInstance) {
        candidate.agentInstance = {
          name: "Firstmate 调度默认执行代理",
          source: "unassigned"
        };
      }
      started.push(candidate.id);
    }

    dag.lastScheduleAt = now;
    dag.updatedAt = now;
    refreshDagAggregate(dag);
    await this.persist();

    return {
      dag: cloneDag(dag),
      started,
      frontier: [...dag.frontier],
      blocked: dag.subtasks.filter((s) => s.status === "blocked").map((s) => s.id),
      completed: isDagFullyDone(dag)
    };
  }

  async completeSubtask(runId: string, subtaskId: string, input: CompleteSubtaskInput = {}): Promise<ScheduleResult> {
    const dag = this.requireDag(runId);
    const subtask = requireSubtask(dag, subtaskId);
    if (subtask.status !== "running" && subtask.status !== "ready" && subtask.status !== "paused") {
      throw new Error(`Subtask ${subtaskId} cannot complete from status ${subtask.status}.`);
    }
    const now = this.now().toISOString();
    subtask.status = "completed";
    subtask.completedAt = now;
    if (!subtask.startedAt) subtask.startedAt = now;
    subtask.error = undefined;
    subtask.blockedReason = undefined;
    if (input.artifacts?.length) {
      subtask.artifacts = uniqueStrings([...subtask.artifacts, ...input.artifacts]);
    }
    if (input.summary?.trim()) {
      subtask.outputs = uniqueStrings([...subtask.outputs, input.summary.trim()]);
    }
    dag.updatedAt = now;
    recomputeStatuses(dag);
    refreshDagAggregate(dag);
    await this.persist();

    if (dag.autoSchedule && !dag.needsAskReplan && dag.status !== "paused" && dag.status !== "awaiting_replan") {
      return this.schedule(runId);
    }
    return {
      dag: cloneDag(dag),
      started: [],
      frontier: [...dag.frontier],
      blocked: dag.subtasks.filter((s) => s.status === "blocked").map((s) => s.id),
      completed: isDagFullyDone(dag)
    };
  }

  async failSubtask(runId: string, subtaskId: string, input: FailSubtaskInput): Promise<ScheduleResult> {
    if (!input.error?.trim()) throw new Error("error is required when failing a subtask.");
    const dag = this.requireDag(runId);
    const subtask = requireSubtask(dag, subtaskId);
    const now = this.now().toISOString();
    subtask.status = input.pause ? "paused" : "failed";
    subtask.error = input.error.trim();
    subtask.completedAt = now;
    if (!subtask.startedAt) subtask.startedAt = now;
    dag.lastError = subtask.error;
    dag.updatedAt = now;

    // Downstream becomes blocked when this node fails/pauses.
    recomputeStatuses(dag);
    if (input.pause) {
      dag.status = "paused";
    } else {
      refreshDagAggregate(dag);
    }
    await this.persist();

    return {
      dag: cloneDag(dag),
      started: [],
      frontier: [...dag.frontier],
      blocked: dag.subtasks.filter((s) => s.status === "blocked").map((s) => s.id),
      completed: false
    };
  }

  /**
   * User correction scope:
   * - major → needsAskReplan (caller raises AskReplan); unfinished related work paused
   * - minor → only related unfinished subtasks re-opened; completed stay completed
   */
  async applyCorrection(runId: string, input: CorrectionInput): Promise<CorrectionResult> {
    const note = input.note?.trim();
    if (!note) throw new Error("Correction note is required.");
    const dag = this.requireDag(runId);
    const now = this.now().toISOString();
    const unfinished = dag.subtasks.filter((s) => s.status !== "completed" && s.status !== "cancelled");
    const relatedIds = new Set(
      (input.relatedSubtaskIds?.length
        ? input.relatedSubtaskIds
        : unfinished.map((s) => s.id)
      ).filter((id) => dag.subtasks.some((s) => s.id === id))
    );

    const affected: string[] = [];
    for (const subtask of dag.subtasks) {
      if (!relatedIds.has(subtask.id)) continue;
      if (subtask.status === "completed" || subtask.status === "cancelled") continue;
      subtask.correctionNotes = [...subtask.correctionNotes, note];
      if (input.major) {
        subtask.status = "paused";
        subtask.blockedReason = `重大纠偏，等待 AskReplan：${note.slice(0, 120)}`;
      } else {
        // Re-open related unfinished work so frontier can re-evaluate.
        subtask.status = "pending";
        subtask.error = undefined;
        subtask.blockedReason = undefined;
        subtask.startedAt = undefined;
        subtask.completedAt = undefined;
      }
      affected.push(subtask.id);
    }

    dag.correctionNote = note;
    dag.updatedAt = now;

    if (input.major) {
      dag.needsAskReplan = true;
      dag.replanFeedback = note;
      dag.status = "awaiting_replan";
      dag.autoSchedule = false;
      recomputeStatuses(dag);
      await this.persist();
      return {
        dag: cloneDag(dag),
        affectedSubtaskIds: affected,
        needsAskReplan: true,
        replanFeedback: note
      };
    }

    dag.needsAskReplan = false;
    dag.replanFeedback = undefined;
    if (dag.status === "awaiting_replan" || dag.status === "paused") {
      dag.status = "idle";
    }
    if (!dag.autoSchedule) dag.autoSchedule = true;
    recomputeStatuses(dag);
    refreshDagAggregate(dag);
    await this.persist();

    if (dag.autoSchedule) {
      const scheduled = await this.schedule(runId);
      return {
        dag: scheduled.dag,
        affectedSubtaskIds: affected,
        needsAskReplan: false
      };
    }

    return {
      dag: cloneDag(dag),
      affectedSubtaskIds: affected,
      needsAskReplan: false
    };
  }

  /** Snapshot frontier + statuses for interrupt recovery. */
  async saveCheckpoint(runId: string, note?: string): Promise<SubtaskDag> {
    const dag = this.requireDag(runId);
    recomputeStatuses(dag);
    const checkpoint: DagCheckpoint = {
      savedAt: this.now().toISOString(),
      frontier: [...dag.frontier],
      subtaskStatuses: Object.fromEntries(dag.subtasks.map((s) => [s.id, s.status])),
      completedIds: dag.subtasks.filter((s) => s.status === "completed").map((s) => s.id),
      runningIds: dag.subtasks.filter((s) => s.status === "running").map((s) => s.id),
      note: note?.trim() || undefined
    };
    dag.checkpoint = checkpoint;
    dag.updatedAt = checkpoint.savedAt;
    await this.persist();
    return cloneDag(dag);
  }

  /**
   * Rebuild DAG statuses after interrupt and continue from current frontier.
   * Running tasks interrupted mid-flight return to ready (replay from frontier).
   */
  async resumeFromCheckpoint(runId: string): Promise<ResumeResult> {
    const dag = this.requireDag(runId);
    const now = this.now().toISOString();

    if (dag.needsAskReplan) {
      return {
        dag: cloneDag(dag),
        frontier: [...dag.frontier],
        resumed: false,
        reason: "DAG awaits AskReplan before resume."
      };
    }

    // If a checkpoint exists, re-apply completed statuses as baseline and clear mid-flight running.
    if (dag.checkpoint) {
      for (const subtask of dag.subtasks) {
        const snap = dag.checkpoint.subtaskStatuses[subtask.id];
        if (snap === "completed") {
          subtask.status = "completed";
          continue;
        }
        if (snap === "failed") {
          subtask.status = "failed";
          continue;
        }
        if (snap === "cancelled") {
          subtask.status = "cancelled";
          continue;
        }
        if (snap === "running" || subtask.status === "running") {
          // Interrupted in-flight work re-enters frontier for replay.
          subtask.status = "pending";
          subtask.startedAt = undefined;
          subtask.error = undefined;
          subtask.blockedReason = undefined;
        } else if (snap === "blocked" || snap === "paused") {
          subtask.status = snap;
        } else if (snap === "ready" || snap === "pending") {
          subtask.status = "pending";
        }
      }
    } else {
      // No explicit checkpoint: treat any running as interrupted.
      for (const subtask of dag.subtasks) {
        if (subtask.status === "running") {
          subtask.status = "pending";
          subtask.startedAt = undefined;
        }
      }
    }

    dag.status = "idle";
    dag.autoSchedule = true;
    dag.updatedAt = now;
    recomputeStatuses(dag);
    refreshDagAggregate(dag);
    await this.persist();

    const scheduled = await this.schedule(runId);
    return {
      dag: scheduled.dag,
      frontier: scheduled.frontier,
      resumed: true,
      reason: dag.checkpoint
        ? `Resumed from checkpoint at ${dag.checkpoint.savedAt}.`
        : "Resumed from persisted DAG frontier."
    };
  }

  /** Assign / update agent instance metadata for PWA visibility. */
  async assignAgent(runId: string, subtaskId: string, agent: SubtaskAgentInstance): Promise<Subtask> {
    const dag = this.requireDag(runId);
    const subtask = requireSubtask(dag, subtaskId);
    subtask.agentInstance = { ...agent };
    dag.updatedAt = this.now().toISOString();
    await this.persist();
    return cloneSubtask(subtask);
  }

  /**
   * Task 29: append constrained fix subtasks from independent review findings.
   * Creates a remediation-only DAG when none exists for the run.
   * Cancels incomplete prior remediation nodes by default so only the current cycle is active.
   */
  async appendRemediationSubtasks(input: AppendRemediationSubtasksInput): Promise<AppendRemediationResult> {
    if (!input.runId?.trim()) throw new Error("runId is required.");
    if (!input.reviewId?.trim()) throw new Error("reviewId is required.");
    if (!Array.isArray(input.explicitSubtasks) || input.explicitSubtasks.length === 0) {
      throw new Error("At least one remediation subtask is required.");
    }

    const runId = input.runId.trim();
    const reviewId = input.reviewId.trim();
    const now = this.now().toISOString();
    let created = false;
    let dag = this.state.dags.find((entry) => entry.runId === runId);

    if (!dag) {
      created = true;
      dag = {
        id: randomUUID(),
        runId,
        planVersion: Number.isFinite(input.planVersion) && (input.planVersion as number) >= 1
          ? (input.planVersion as number)
          : 1,
        taskType: "bug_fix",
        complexity: "medium",
        createdAt: now,
        updatedAt: now,
        status: "idle",
        subtasks: [],
        autoSchedule: input.autoSchedule !== false,
        maxParallelWrite: 1,
        maxParallelRead: 3,
        maxParallelIndependentWrite: 2,
        frontier: [],
        needsAskReplan: false,
        planApproved: true
      };
      this.state.dags.push(dag);
    }

    const cancelledIds: string[] = [];
    if (input.cancelPriorRemediation !== false) {
      for (const subtask of dag.subtasks) {
        if (subtask.origin !== "review_remediation") continue;
        if (subtask.status === "completed" || subtask.status === "cancelled") continue;
        subtask.status = "cancelled";
        subtask.blockedReason = `被新的审查修复循环取代（review ${reviewId}）。`;
        subtask.completedAt = now;
        cancelledIds.push(subtask.id);
      }
    }

    const baseStep = dag.subtasks.reduce((max, s) => Math.max(max, s.stepIndex), -1) + 1;
    const built = buildRemediationSubtasks({
      runId,
      planVersion: dag.planVersion,
      reviewId,
      cycle: input.cycle ?? 0,
      stepBase: baseStep,
      defs: input.explicitSubtasks,
      now
    });

    // Reject duplicate ids against remaining active/completed nodes.
    const existingIds = new Set(dag.subtasks.map((s) => s.id));
    for (const subtask of built) {
      if (existingIds.has(subtask.id) && !cancelledIds.includes(subtask.id)) {
        // Replace cancelled same-id nodes; otherwise allocate a unique suffix.
        const collision = dag.subtasks.find((s) => s.id === subtask.id);
        if (collision && collision.status === "cancelled") {
          // drop cancelled node so the new one can reuse the id
          dag.subtasks = dag.subtasks.filter((s) => s.id !== subtask.id);
        } else if (collision) {
          subtask.id = `${subtask.id}-${randomUUID().slice(0, 8)}`;
        }
      }
    }

    dag.subtasks.push(...built);
    const createdIds = built.map((s) => s.id);

    if (input.agentAssignments?.length) {
      for (const assignment of input.agentAssignments) {
        const target = dag.subtasks.find(
          (s) => s.id === assignment.subtaskId || s.routingInstanceId === assignment.subtaskId
        );
        if (!target) continue;
        // Reviewer must never be assigned as a fix agent.
        if (looksLikeReviewerAgent(assignment.agent)) continue;
        target.agentInstance = { ...assignment.agent };
      }
    }

    // Default unassigned remediation tasks get a placeholder fix agent name (not Reviewer).
    for (const subtask of built) {
      if (!subtask.agentInstance) {
        subtask.agentInstance = {
          name: "原专业代理（修复）",
          source: "unassigned",
          tools: ["filesystem", "shell"]
        };
      }
    }

    if (input.autoSchedule !== undefined) {
      dag.autoSchedule = input.autoSchedule;
    } else if (!dag.autoSchedule) {
      dag.autoSchedule = true;
    }
    dag.needsAskReplan = false;
    if (dag.status === "awaiting_replan" || dag.status === "paused" || dag.status === "failed" || dag.status === "completed") {
      dag.status = "idle";
    }
    dag.updatedAt = now;
    recomputeStatuses(dag);
    refreshDagAggregate(dag);
    await this.persist();

    if (dag.autoSchedule && !dag.needsAskReplan) {
      const scheduled = await this.schedule(runId);
      return {
        dag: scheduled.dag,
        createdIds,
        cancelledIds,
        created
      };
    }

    return {
      dag: cloneDag(dag),
      createdIds,
      cancelledIds,
      created
    };
  }

  private requireDag(runId: string): SubtaskDag {
    const dag = this.state.dags.find((entry) => entry.runId === runId);
    if (!dag) throw new Error(`Subtask DAG for run ${runId} was not found.`);
    return dag;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: constants.S_IRUSR | constants.S_IWUSR
    });
    await rename(temporaryPath, this.statePath);
  }
}

// ─── Pure helpers (exported for unit tests) ─────────────────────────────────

export function inferAccessMode(step: string, taskType?: TaskType): SubtaskAccessMode {
  if (READ_ONLY_STEP_PATTERN.test(step) && !WRITE_STEP_PATTERN.test(step)) return "read_only";
  if (taskType === "research" || taskType === "analysis") {
    if (!WRITE_STEP_PATTERN.test(step)) return "read_only";
  }
  if (/(确认目标|确认范围|检查|收集|整理|核对)/.test(step) && !WRITE_STEP_PATTERN.test(step)) {
    return "read_only";
  }
  return "write";
}

export function defaultPermissions(accessMode: SubtaskAccessMode, caps: string[]): SubtaskPermissions {
  const lower = caps.map((c) => c.toLowerCase());
  return {
    workspace: accessMode === "read_only" ? "read_only" : "project_only",
    network: lower.some((c) => c === "network" || c === "web"),
    shell: accessMode === "write" && lower.some((c) => c === "shell" || c === "tests" || c === "automation"),
    externalSend: false
  };
}

export function computeFrontierIds(subtasks: Subtask[]): string[] {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const frontier: string[] = [];
  for (const subtask of subtasks) {
    if (subtask.status === "completed" || subtask.status === "cancelled") continue;
    if (subtask.status === "running") continue;
    if (subtask.status === "failed" || subtask.status === "paused") continue;
    if (subtask.status === "blocked") continue;
    const deps = subtask.dependsOn.map((id) => byId.get(id)).filter(Boolean) as Subtask[];
    if (deps.length !== subtask.dependsOn.length) continue;
    if (deps.every((d) => d.status === "completed")) {
      frontier.push(subtask.id);
    }
  }
  return frontier;
}

export function recomputeStatuses(dag: SubtaskDag): void {
  const byId = new Map(dag.subtasks.map((s) => [s.id, s]));
  // Multiple passes so blocking propagates transitively.
  for (let pass = 0; pass < dag.subtasks.length + 1; pass++) {
    let changed = false;
    for (const subtask of dag.subtasks) {
      if (
        subtask.status === "completed"
        || subtask.status === "cancelled"
        || subtask.status === "running"
        || subtask.status === "failed"
        || subtask.status === "paused"
      ) {
        continue;
      }

      const deps = subtask.dependsOn.map((id) => byId.get(id));
      const missing = deps.some((d) => !d);
      if (missing) {
        if (subtask.status !== "blocked") {
          subtask.status = "blocked";
          subtask.blockedReason = "依赖子任务缺失。";
          changed = true;
        }
        continue;
      }

      const failedDep = (deps as Subtask[]).find(
        (d) => d.status === "failed" || d.status === "blocked" || d.status === "cancelled"
      );
      if (failedDep) {
        const nextReason = `上游子任务 ${failedDep.id}（${failedDep.title}）状态为 ${failedDep.status}，已阻止下游。`;
        if (subtask.status !== "blocked" || subtask.blockedReason !== nextReason) {
          subtask.status = "blocked";
          subtask.blockedReason = nextReason;
          changed = true;
        }
        continue;
      }

      const pausedDep = (deps as Subtask[]).find((d) => d.status === "paused");
      if (pausedDep) {
        const nextReason = `上游子任务 ${pausedDep.id} 已暂停，下游等待。`;
        if (subtask.status !== "blocked" || subtask.blockedReason !== nextReason) {
          subtask.status = "blocked";
          subtask.blockedReason = nextReason;
          changed = true;
        }
        continue;
      }

      const allDone = (deps as Subtask[]).every((d) => d.status === "completed");
      if (allDone) {
        if (subtask.status !== "ready") {
          subtask.status = "ready";
          subtask.blockedReason = undefined;
          changed = true;
        }
      } else if (subtask.status !== "pending") {
        subtask.status = "pending";
        subtask.blockedReason = undefined;
        changed = true;
      }
    }
    if (!changed) break;
  }
  dag.frontier = computeFrontierIds(dag.subtasks);
}

export function canStartNow(dag: SubtaskDag, candidate: Subtask): boolean {
  if (candidate.status !== "ready") return false;
  const running = dag.subtasks.filter((s) => s.status === "running");

  if (candidate.accessMode === "read_only") {
    const runningReads = running.filter((s) => s.accessMode === "read_only").length;
    // Read-only may run alongside write tasks (non-conflicting observation).
    return runningReads < dag.maxParallelRead;
  }

  // Write task
  const runningWrites = running.filter((s) => s.accessMode === "write");
  if (runningWrites.length === 0) return true;

  // Controlled parallel only when candidate + all running writes are independent worktrees.
  if (
    candidate.independentWorktree
    && runningWrites.every((s) => s.independentWorktree)
    && runningWrites.length < dag.maxParallelIndependentWrite
  ) {
    return true;
  }

  // Default: one serial write.
  return false;
}

export function orderForSchedule(candidates: Subtask[]): Subtask[] {
  // Prefer earlier plan steps; among same index prefer read_only first so they fill parallel slots.
  return [...candidates].sort((a, b) => {
    if (a.stepIndex !== b.stepIndex) return a.stepIndex - b.stepIndex;
    if (a.accessMode !== b.accessMode) return a.accessMode === "read_only" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

function buildFromSteps(input: CreateDagFromPlanInput & { steps: string[] }, _now: string): Subtask[] {
  const steps = input.steps.map((s) => s.trim()).filter(Boolean);
  const caps = uniqueStrings(input.requiredCapabilities ?? defaultCapabilities(input.taskType));
  const acceptance = uniqueStrings(input.acceptanceCriteria ?? []);
  const artifacts = uniqueStrings(input.expectedArtifacts ?? []);
  const ids = steps.map((_, index) => `step-${index + 1}`);

  return steps.map((title, index) => {
    const accessMode = inferAccessMode(title, input.taskType);
    const permissions = defaultPermissions(accessMode, caps);
    const dependsOn = index === 0 ? [] : [ids[index - 1]!];
    // Adjacent read-only steps after a shared write ancestor can be parallelized:
    // when two consecutive steps are both read_only, only depend on the last write ancestor.
    let resolvedDeps = dependsOn;
    if (index > 0 && accessMode === "read_only") {
      const prevMode = inferAccessMode(steps[index - 1]!, input.taskType);
      if (prevMode === "read_only") {
        // Find nearest write ancestor (or none).
        let ancestor: string | undefined;
        for (let i = index - 1; i >= 0; i--) {
          if (inferAccessMode(steps[i]!, input.taskType) === "write") {
            ancestor = ids[i];
            break;
          }
        }
        resolvedDeps = ancestor ? [ancestor] : [];
      }
    }

    const inputs =
      index === 0
        ? uniqueStrings([...(input.allowedScope ?? []), "已批准计划"])
        : [`上游产物: ${steps[index - 1]}`];

    return {
      id: ids[index]!,
      runId: input.runId.trim(),
      planVersion: input.planVersion,
      stepIndex: index,
      title,
      description: title,
      requiredCapabilities: caps,
      inputs,
      outputs: artifacts.length && index === steps.length - 1 ? [...artifacts] : [`步骤 ${index + 1} 产出`],
      dependsOn: resolvedDeps,
      permissions,
      acceptanceCriteria:
        acceptance.length > 0
          ? index === steps.length - 1
            ? acceptance
            : [`完成：${title}`]
          : [`完成：${title}`],
      accessMode,
      independentWorktree: false,
      status: "pending" as SubtaskStatus,
      artifacts: [],
      correctionNotes: [],
      routingInstanceId: undefined,
      origin: "plan"
    } satisfies Subtask;
  });
}

function buildFromExplicit(input: CreateDagFromPlanInput, _now: string): Subtask[] {
  const defs = input.explicitSubtasks ?? [];
  const caps = uniqueStrings(input.requiredCapabilities ?? defaultCapabilities(input.taskType));
  const idMap = new Map<string, string>();

  // First pass: assign stable ids.
  defs.forEach((def, index) => {
    const local = def.id?.trim() || `step-${index + 1}`;
    idMap.set(local, local);
    idMap.set(String(index), local);
  });

  return defs.map((def, index) => {
    const id = def.id?.trim() || `step-${index + 1}`;
    const accessMode = def.accessMode ?? inferAccessMode(def.title, input.taskType);
    const permissions: SubtaskPermissions = {
      ...defaultPermissions(accessMode, def.requiredCapabilities ?? caps),
      ...def.permissions,
      workspace: def.permissions?.workspace
        ?? (accessMode === "read_only" ? "read_only" : "project_only")
    };
    const dependsOn = resolveDependsOn(def, index, idMap);
    return {
      id,
      runId: input.runId.trim(),
      planVersion: input.planVersion,
      stepIndex: index,
      title: def.title.trim(),
      description: def.description?.trim() || def.title.trim(),
      requiredCapabilities: uniqueStrings(def.requiredCapabilities ?? caps),
      inputs: uniqueStrings(def.inputs ?? ["已批准计划"]),
      outputs: uniqueStrings(def.outputs ?? [`${def.title} 产出`]),
      dependsOn,
      permissions,
      acceptanceCriteria: uniqueStrings(
        def.acceptanceCriteria?.length ? def.acceptanceCriteria : [`完成：${def.title}`]
      ),
      accessMode,
      independentWorktree: Boolean(def.independentWorktree),
      status: "pending" as SubtaskStatus,
      artifacts: [],
      correctionNotes: [],
      routingInstanceId: def.routingInstanceId,
      origin: def.origin ?? "plan",
      sourceReviewId: def.sourceReviewId,
      findingSeverity: def.findingSeverity
    } satisfies Subtask;
  });
}

function buildRemediationSubtasks(input: {
  runId: string;
  planVersion: number;
  reviewId: string;
  cycle: number;
  stepBase: number;
  defs: ExplicitSubtaskDef[];
  now: string;
}): Subtask[] {
  const idMap = new Map<string, string>();
  input.defs.forEach((def, index) => {
    const local = def.id?.trim() || `remediation-c${input.cycle}-${index + 1}`;
    idMap.set(local, local);
    idMap.set(String(index), local);
  });

  return input.defs.map((def, index) => {
    const id = def.id?.trim() || `remediation-c${input.cycle}-${index + 1}`;
    const accessMode: SubtaskAccessMode = def.accessMode ?? "write";
    const caps = uniqueStrings(def.requiredCapabilities ?? ["filesystem", "workspace"]);
    const permissions: SubtaskPermissions = {
      ...defaultPermissions(accessMode, caps),
      ...def.permissions,
      workspace: def.permissions?.workspace ?? "project_only",
      externalSend: false
    };
    const dependsOn = resolveDependsOn(def, index, idMap);
    return {
      id,
      runId: input.runId,
      planVersion: input.planVersion,
      stepIndex: input.stepBase + index,
      title: def.title.trim(),
      description: def.description?.trim() || def.title.trim(),
      requiredCapabilities: caps,
      inputs: uniqueStrings(def.inputs ?? [`review:${input.reviewId}`]),
      outputs: uniqueStrings(def.outputs ?? [`修复产出：${def.title}`]),
      dependsOn,
      permissions,
      acceptanceCriteria: uniqueStrings(
        def.acceptanceCriteria?.length ? def.acceptanceCriteria : [`完成：${def.title}`]
      ),
      accessMode,
      independentWorktree: Boolean(def.independentWorktree),
      status: "pending" as SubtaskStatus,
      artifacts: [],
      correctionNotes: [],
      routingInstanceId: def.routingInstanceId ?? id,
      origin: "review_remediation",
      sourceReviewId: def.sourceReviewId ?? input.reviewId,
      findingSeverity: def.findingSeverity
    } satisfies Subtask;
  });
}

function looksLikeReviewerAgent(agent: SubtaskAgentInstance): boolean {
  const blob = [
    agent.name,
    agent.roleId ?? "",
    ...(agent.skills ?? []),
    ...(agent.tools ?? [])
  ].join(" ").toLowerCase();
  return /reviewer|no-mistakes|独立审查/.test(blob)
    && !/fix|implement|实现|修复/.test(blob);
}

function resolveDependsOn(def: ExplicitSubtaskDef, index: number, idMap: Map<string, string>): string[] {
  // Omitted dependsOn → default linear chain. Explicit [] means no dependencies (parallel root).
  if (def.dependsOn === undefined) {
    if (index === 0) return [];
    const prev = idMap.get(String(index - 1));
    return prev ? [prev] : [];
  }
  return uniqueStrings(
    def.dependsOn.map((ref) => {
      const mapped = idMap.get(ref) ?? idMap.get(String(ref));
      return mapped ?? ref;
    })
  );
}

function applyRoutingHints(subtasks: Subtask[], selections: RoutingSelectionHint[]): void {
  if (selections.length === 0) return;
  const byInstance = new Map(selections.map((s) => [s.instanceId, s]));
  for (const subtask of subtasks) {
    const hit =
      (subtask.routingInstanceId ? byInstance.get(subtask.routingInstanceId) : undefined)
      ?? byInstance.get(subtask.id)
      ?? (selections.length === 1 ? selections[0] : undefined);
    if (!hit) continue;
    subtask.agentInstance = {
      roleId: hit.roleId,
      temporaryRoleId: hit.temporaryRoleId,
      name: hit.name,
      harness: hit.harness,
      modelId: hit.modelId,
      connectionId: hit.connectionId,
      skills: hit.skills,
      tools: hit.tools,
      source: hit.source ?? (hit.roleId ? "role" : hit.temporaryRoleId ? "temporary" : "unassigned")
    };
    if (hit.permissions) {
      subtask.permissions = { ...subtask.permissions, ...hit.permissions };
    }
    subtask.routingInstanceId = hit.instanceId;
  }
}

function refreshDagAggregate(dag: SubtaskDag): void {
  if (dag.needsAskReplan) {
    dag.status = "awaiting_replan";
    return;
  }
  if (dag.subtasks.some((s) => s.status === "paused") && !dag.subtasks.some((s) => s.status === "running")) {
    // Keep paused if a node is paused and nothing is running (unless all remaining are blocked by that pause).
    if (dag.status === "paused") return;
  }
  if (dag.subtasks.every((s) => s.status === "completed" || s.status === "cancelled")) {
    dag.status = "completed";
    return;
  }
  if (dag.subtasks.some((s) => s.status === "failed") && !dag.subtasks.some((s) => s.status === "running" || s.status === "ready")) {
    dag.status = "failed";
    return;
  }
  if (dag.subtasks.some((s) => s.status === "running")) {
    dag.status = "running";
    return;
  }
  if (dag.frontier.length > 0) {
    dag.status = "scheduling";
    return;
  }
  if (dag.subtasks.some((s) => s.status === "blocked") && dag.subtasks.some((s) => s.status === "failed" || s.status === "paused")) {
    dag.status = dag.subtasks.some((s) => s.status === "paused") ? "paused" : "failed";
    return;
  }
  dag.status = "idle";
}

function isDagFullyDone(dag: SubtaskDag): boolean {
  return dag.subtasks.every((s) => s.status === "completed" || s.status === "cancelled");
}

function requireSubtask(dag: SubtaskDag, subtaskId: string): Subtask {
  const subtask = dag.subtasks.find((entry) => entry.id === subtaskId);
  if (!subtask) throw new Error(`Subtask ${subtaskId} was not found for run ${dag.runId}.`);
  return subtask;
}

function defaultCapabilities(taskType?: TaskType): string[] {
  switch (taskType) {
    case "implementation":
    case "bug_fix":
      return ["workspace", "filesystem", "shell", "tests"];
    case "research":
    case "writing":
    case "analysis":
      return ["workspace", "documents"];
    case "automation":
      return ["workspace", "filesystem", "shell"];
    default:
      return ["workspace"];
  }
}

function clampParallel(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(3, Math.max(1, Math.floor(value)));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function cloneDag(dag: SubtaskDag): SubtaskDag {
  return JSON.parse(JSON.stringify(dag)) as SubtaskDag;
}

function cloneSubtask(subtask: Subtask): Subtask {
  return JSON.parse(JSON.stringify(subtask)) as Subtask;
}
