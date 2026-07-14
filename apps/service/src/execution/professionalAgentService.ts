import { access } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { ConnectionService } from "../connections/connectionService.js";
import { ModelRuntime } from "../model/modelRuntime.js";
import { AgentWorkspace } from "../projects/agentWorkspace.js";
import type { ProjectService } from "../projects/projectService.js";
import type { AgentRole, RoleService } from "../roles/roleService.js";
import {
  captureWorkspaceFingerprint,
  type ExecutionApprovalKind,
  type ProfessionalAgentSelection,
  type Run,
  type RunService,
  type TaskType
} from "../runs/runService.js";
import type { TodoService } from "../todos/todoService.js";
import { leaseRequestFromRun, type RunQueueService } from "../queue/runQueueService.js";
import { ApiAgentAdapter } from "../runtime/apiAgentAdapter.js";
import {
  drainRuntimeSend,
  preferRuntimeAdapter,
  runtimeEventToLog
} from "../runtime/orchestration.js";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import { createControlledTools } from "./controlledTools.js";
import {
  DEFAULT_TOOL_LOOP_LIMITS,
  runToolLoop,
  type ToolLoopEvent,
  type ToolLoopLimits,
  type ToolLoopResult
} from "./toolLoop.js";

export interface ProfessionalAgentServiceOptions {
  projects: ProjectService;
  todos: TodoService;
  runs: RunService;
  roles: RoleService;
  connections: ConnectionService;
  queue?: RunQueueService;
  /**
   * Optional unified Runtime Adapter (API harness).
   * When set (or auto-created for role-based turns), model turns stream RuntimeEvents
   * instead of calling ConnectionService.chatCompletion directly.
   */
  runtimeAdapter?: RuntimeAdapter;
  /**
   * When true (default), construct an ApiAgentAdapter from roles/connections if none is injected.
   * Set false to force the legacy chatCompletion path (tests / rollback).
   */
  preferRuntimeAdapter?: boolean;
  /** Optional multi-turn tool-loop budget overrides (tests / host config). */
  toolLoopLimits?: Partial<ToolLoopLimits>;
  /**
   * Extra tools merged into the controlled tool loop (e.g. Firstmate self-management).
   * Called per turn so the host can decide based on selection / role.
   */
  extraTools?: (ctx: {
    runId: string;
    selection: ProfessionalAgentSelection;
    workspacePath: string;
  }) => import("./toolLoop.js").ToolDefinition[] | Promise<import("./toolLoop.js").ToolDefinition[]>;
  /**
   * Optional system-instruction composition (Agent Home / hard rules).
   * Return undefined to keep the selection systemInstruction unchanged.
   */
  composeSystemInstruction?: (ctx: {
    runId: string;
    selection: ProfessionalAgentSelection;
    baseInstruction: string;
  }) => string | Promise<string | undefined> | undefined;
  /**
   * Fired after a run's Professional Agent settles (success or failure).
   * Used by continuous DAG orchestration — must not throw into the agent path.
   */
  onExecutionSettled?: (event: {
    runId: string;
    outcome: "completed" | "failed";
    summary?: string;
  }) => void | Promise<void>;
}

export interface TemporaryProfessionalAgentInput {
  name: string;
  responsibility: string;
  systemInstruction: string;
  connectionId: string;
  modelId?: string;
  tools?: string[];
}

export interface StartProfessionalAgentInput {
  roleId?: string;
  temporaryAgent?: TemporaryProfessionalAgentInput;
  saveTemporaryRole?: boolean;
  confirmSaveTemporaryRole?: boolean;
}

export interface CorrectAndContinueResult {
  run: Run;
  requiresReapproval: boolean;
  continued: boolean;
}

interface FileAction {
  type: string;
  path?: string;
  content?: string;
  command?: string;
  destination?: string;
  skill?: string;
}

interface AgentOutput {
  summary: string;
  actions: FileAction[];
}

interface ActiveExecution {
  controller: AbortController;
  completion?: Promise<void>;
}

const maxActions = 10;
const maxFileBytes = 1024 * 1024;

/** Runs one API-backed Professional Agent through the approved local file boundary. */
export class ProfessionalAgentService {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly runtimeAdapter: RuntimeAdapter | undefined;

  constructor(private readonly options: ProfessionalAgentServiceOptions) {
    this.options.runs.onExecutionInterrupted((runId) => this.abort(runId));
    this.runtimeAdapter = this.resolveRuntimeAdapter(options);
  }

  private resolveRuntimeAdapter(options: ProfessionalAgentServiceOptions): RuntimeAdapter | undefined {
    const injected = preferRuntimeAdapter(options.runtimeAdapter);
    if (injected) return injected;
    if (options.preferRuntimeAdapter === false) return undefined;
    // Production default: orchestration prefers the unified Runtime Adapter for role-based turns.
    return new ApiAgentAdapter({
      modelRuntime: new ModelRuntime({
        roles: options.roles,
        connections: options.connections
      })
    });
  }

  async start(runId: string, input: StartProfessionalAgentInput): Promise<Run> {
    if (this.active.has(runId)) throw new Error("This Run already has an active Professional Agent.");
    const current = await this.options.runs.get(runId);
    // Fail-closed: even if Worktree DI was omitted at assembly, never let code tasks write the main workspace.
    if (isCodeTask(current.planning?.assessment.taskType)) {
      throw new Error("代码任务必须通过隔离 Git Worktree 的 Codex CLI Harness 执行；API Professional Agent 不会直接修改主工作区。");
    }
    const retryingInterruptedRun = !input.roleId
      && !input.temporaryAgent
      && (
        current.status === "paused"
        || current.status === "interrupted"
        || current.status === "queued"
        || current.status === "failed"
      )
      && current.execution.status === "failed"
      && current.execution.retryable
      && Boolean(current.execution.selectedAgent);
    const retrySelection = retryingInterruptedRun ? await this.resolveSelection(runId, input) : undefined;
    if (retryingInterruptedRun) {
      // Checkpoint-resume HTTP path may already have queued the Run after conflict/dangerous checks.
      const alreadyPrepared = current.status === "queued" && current.checkpointRecovery?.status === "ready";
      const hasRecoveryMetadata = Boolean(
        (current.checkpointRecovery && current.checkpointRecovery.status !== "none")
        || (current.checkpoints && current.checkpoints.length > 0)
      );
      if (!alreadyPrepared && hasRecoveryMetadata) {
        // Always gate retries through fingerprint + dangerous re-approval when checkpoints exist (including failed status).
        const fingerprint = await this.captureRunFingerprint(current);
        const resumed = await this.options.runs.resumeFromCheckpoint(runId, {
          currentFingerprint: fingerprint,
          approveDangerousReplay: current.checkpointRecovery?.dangerousReplayApproved === true
        });
        if (!resumed.canContinue) {
          return resumed.run;
        }
      } else if (!alreadyPrepared && (current.status === "paused" || current.status === "interrupted")) {
        await this.options.runs.resumeRetryableExecution(runId);
      }
      // status === "failed" without checkpoints: beginProfessionalExecution accepts failed+retryable directly.
    }
    await this.options.runs.assertExecutionAuthorized(runId, "Professional Agent execution");
    const selection = retrySelection ?? await this.resolveSelection(runId, input);
    const admission = await this.admitToQueue(runId, selection);
    if (admission.paused) return admission.run;
    const controller = new AbortController();
    const active: ActiveExecution = { controller };
    this.active.set(runId, active);
    let savedTemporaryRoleId: string | undefined;
    try {
      const started = await this.options.runs.beginProfessionalExecution(runId, selection, {
        maxConsecutiveFailures: this.options.queue?.configuredMaxRetries()
      });
      const current = await this.options.runs.get(runId);
      if (controller.signal.aborted || current.status !== "running" || current.execution.status !== "running") {
        this.clearActive(runId, active);
        this.releaseQueue(runId);
        return current;
      }
      const savedTemporaryRole = await this.saveConfirmedTemporaryRole(input, selection);
      savedTemporaryRoleId = savedTemporaryRole?.id;
      const afterSaving = await this.options.runs.get(runId);
      if (controller.signal.aborted || afterSaving.status !== "running" || afterSaving.execution.status !== "running") {
        if (savedTemporaryRoleId) await this.options.roles.remove(savedTemporaryRoleId);
        this.clearActive(runId, active);
        this.releaseQueue(runId);
        return afterSaving;
      }
      let settled: { outcome: "completed" | "failed"; summary?: string } | undefined;
      const completion = this.perform(runId, selection, controller.signal)
        .then(async () => {
          // perform calls finishProfessionalExecution on success; inspect final run status.
          const after = await this.options.runs.get(runId);
          if (after.execution.status === "succeeded" || after.status === "awaiting_review") {
            settled = {
              outcome: "completed",
              summary: after.timeline.at(-1)?.summary ?? "Professional Agent 已完成"
            };
          }
        })
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : "Professional Agent execution failed.";
          await this.options.runs.failProfessionalExecution(runId, message);
          settled = { outcome: "failed", summary: message };
        });
      active.completion = completion;
      void completion.finally(async () => {
        this.clearActive(runId, active);
        this.releaseQueue(runId);
        // Continue DAG only after this agent is fully released from the active map.
        if (settled) {
          await this.notifySettled(runId, settled.outcome, settled.summary);
        }
      });
      return started;
    } catch (error) {
      if (savedTemporaryRoleId) {
        try { await this.options.roles.remove(savedTemporaryRoleId); } catch { /* preserve the original startup failure */ }
      }
      this.clearActive(runId, active);
      this.releaseQueue(runId);
      const run = await this.options.runs.get(runId);
      if (run.status === "running" && run.execution.status === "running") {
        const message = error instanceof Error ? error.message : "Unable to start the Professional Agent.";
        await this.options.runs.failProfessionalExecution(runId, message);
      }
      throw error;
    }
  }

  private async admitToQueue(
    runId: string,
    selection: ProfessionalAgentSelection
  ): Promise<{ paused: true; run: Run } | { paused: false }> {
    const queue = this.options.queue;
    if (!queue) return { paused: false };
    const run = await this.options.runs.get(runId);
    const todo = await this.options.todos.get(run.todoId);
    const decision = await queue.admit(leaseRequestFromRun(run, {
      projectId: todo.projectId,
      readOnlyPermissions: selection.permissions?.workspace === "read_only",
      worktreeIsolated: false
    }));
    if (decision.allowed) return { paused: false };
    if (decision.code === "resource") {
      const paused = await this.options.runs.transition(runId, "paused", decision.reason);
      return { paused: true, run: paused };
    }
    throw new Error(decision.reason);
  }

  private releaseQueue(runId: string): void {
    this.options.queue?.release(runId);
  }

  async waitForCompletion(runId: string): Promise<void> {
    await this.active.get(runId)?.completion;
  }

  async correctAndContinue(runId: string, input: { instruction: string; changeKind?: "minor" | "goal" | "scope" | "acceptance" | "prohibition" }): Promise<CorrectAndContinueResult> {
    const correction = await this.options.runs.submitCorrection(runId, input);
    if (correction.requiresReapproval || !correction.run.execution.selectedAgent) {
      return { ...correction, continued: false };
    }
    await this.waitForCompletion(runId);
    const current = await this.options.runs.get(runId);
    if (!current.execution.retryable) return { run: current, requiresReapproval: false, continued: false };
    return { run: await this.start(runId, {}), requiresReapproval: false, continued: true };
  }

  private async perform(runId: string, selection: ProfessionalAgentSelection, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const run = await this.options.runs.get(runId);
    if (signal.aborted) return;
    const todo = await this.options.todos.get(run.todoId);
    if (!todo.projectId) throw new Error("Professional Agent execution requires a Project workspace.");
    const project = await this.options.projects.get(todo.projectId);
    const latestPlan = run.planVersions.at(-1);
    if (!latestPlan) throw new Error("A Secondmate plan is required before Professional Agent execution.");
    const completedSteps = new Set(run.execution.completedSteps);
    const interruptedStep = run.checkpointRecovery?.interruptedStep;
    const recoveryNote = run.checkpointRecovery?.recoveryNote;

    await this.options.runs.recordLog(runId, {
      level: "info",
      message: recoveryNote
        ? `正在重建模型会话并调用 Professional Agent：${selection.name}（多轮工具循环）。${recoveryNote}`
        : `正在调用 Professional Agent：${selection.name}（多轮工具循环）。`
    });
    if (signal.aborted) return;
    const connectionId = selection.connectionId;
    if (!connectionId) throw new Error("The selected API-backed Professional Agent needs a model connection.");

    const approvedCommands = resolveApprovedCommands(run, latestPlan);
    const pendingOverwriteApprovals = new Map<string, true>();
    const controlled = createControlledTools({
      workspacePath: project.workspacePath,
      authorizedTools: selection.tools,
      permissions: selection.permissions ?? {
        workspace: "project_only",
        network: false,
        shell: false,
        externalSend: false
      },
      approvedCommands,
      authorizedSkills: selection.skills ?? ["implement"],
      onDangerousWrite: async ({ path, kind }) => {
        if (kind !== "overwrite_file") return undefined;
        const recovery = (await this.options.runs.get(runId)).checkpointRecovery;
        if (recovery?.dangerousReplayApproved === true) return undefined;
        if (pendingOverwriteApprovals.has(path)) return undefined;
        pendingOverwriteApprovals.set(path, true);
        return {
          ok: false,
          summary: `Overwrite requires user confirmation: ${path}`,
          needsApproval: {
            kind: "delete_file",
            summary: `Professional Agent 请求覆盖已有文件，必须由用户确认：overwrite_file:${path}`
          }
        };
      }
    });
    const extra = this.options.extraTools
      ? await this.options.extraTools({ runId, selection, workspacePath: project.workspacePath })
      : [];
    const tools = [...controlled, ...extra];

    const toolNames = tools.map((tool) => tool.name).join("|") || "list_files|read_file|search_files|write_file|apply_patch|run_command";
    const taskPayload = JSON.stringify({
      task: todo.title,
      description: todo.description,
      workspace: "approved-project-workspace",
      plan: {
        steps: latestPlan.steps,
        acceptanceCriteria: latestPlan.acceptanceCriteria,
        risks: latestPlan.risks,
        prohibitions: latestPlan.prohibitions,
        verificationCommands: approvedCommands
      },
      checkpoint: {
        completedSteps: [...completedSteps],
        interruptedStep,
        recoveryMode: "reconstruct_and_replay",
        note: recoveryNote ?? "Original model internal session is not restored."
      },
      corrections: run.messages.map((message) => message.content),
      outputContract: {
        multiTurn: [
          { type: "tool_call", tool: toolNames, arguments: {} },
          { type: "final", summary: "short non-secret summary", actions: [{ type: "write_file", path: "relative/path.ext", content: "file content" }] },
          { type: "ask_user", prompt: "...", reason: "..." },
          { type: "ask_approval", kind: "...", summary: "..." },
          { type: "ask_replan", prompt: "...", reason: "..." }
        ],
        legacySingleShot: {
          summary: "short non-secret summary",
          actions: [{ type: "write_file", path: "relative/path.ext", content: "file content" }]
        }
      },
      constraints: [
        "Return JSON only for each turn.",
        "Use controlled tools; paths must be relative to the approved Project workspace.",
        "Shell/test/build commands must match plan verificationCommands exactly (argv).",
        "Do not request network, external send, or unapproved installs.",
        "Do not repeat completedSteps; only continue from interruptedStep or remaining work.",
        "Each turn receives only necessary context and prior tool result summaries — never dump the whole repo."
      ]
    });

    const checkpointSummary = recoveryNote
      ? `completedSteps=${[...completedSteps].join(",") || "none"}; interruptedStep=${interruptedStep ?? "none"}; ${recoveryNote}`
      : completedSteps.size > 0 || interruptedStep
        ? `completedSteps=${[...completedSteps].join(",") || "none"}; interruptedStep=${interruptedStep ?? "none"}`
        : undefined;

    const priorToolSummaries = run.logs
      .filter((entry) => /工具活动：|tool_result|工具结果/.test(entry.message))
      .slice(-12)
      .map((entry) => entry.message);

    const limits = { ...DEFAULT_TOOL_LOOP_LIMITS, ...this.options.toolLoopLimits };
    const loopResult = await runToolLoop(
      {
        runId,
        workspacePath: project.workspacePath,
        tools,
        limits,
        signal,
        invokeModel: async (messages, turnSignal) => {
          // Compact multi-turn: host sends only the latest user-facing payload built from
          // system+history. Prefer a single user blob so Runtime Adapter path stays simple.
          const userPayload = messages
            .filter((message) => message.role !== "system")
            .map((message) => `${message.role}: ${message.content}`)
            .join("\n\n");
          const systemFromMessages = messages.find((message) => message.role === "system")?.content;
          const content = await this.invokeModelTurn({
            runId,
            selection,
            signal: turnSignal,
            userPayload: userPayload || taskPayload,
            checkpointSummary,
            systemOverride: systemFromMessages
          });
          return { content };
        },
        onEvent: async (event) => {
          await this.recordToolLoopEvent(runId, event);
        }
      },
      {
        systemInstruction: await this.resolveSystemInstruction(runId, selection),
        taskPayload,
        priorToolSummaries: priorToolSummaries.length > 0 ? priorToolSummaries : undefined
      }
    );

    await this.applyToolLoopResult(runId, selection, project.workspacePath, project.id, completedSteps, interruptedStep, loopResult, signal);
  }

  private async resolveSystemInstruction(runId: string, selection: ProfessionalAgentSelection): Promise<string> {
    const base = selection.systemInstruction;
    if (!this.options.composeSystemInstruction) return base;
    try {
      const composed = await this.options.composeSystemInstruction({
        runId,
        selection,
        baseInstruction: base
      });
      return composed?.trim() || base;
    } catch {
      return base;
    }
  }

  private async notifySettled(
    runId: string,
    outcome: "completed" | "failed",
    summary?: string
  ): Promise<void> {
    if (!this.options.onExecutionSettled) return;
    try {
      await this.options.onExecutionSettled({ runId, outcome, summary });
    } catch {
      // Continuous orchestration must never break agent completion cleanup.
    }
  }

  private async recordToolLoopEvent(runId: string, event: ToolLoopEvent): Promise<void> {
    try {
      switch (event.kind) {
        case "turn_start":
          await this.options.runs.recordLog(runId, {
            level: "info",
            message: `工具循环：第 ${event.turn} 轮模型调用`
          });
          break;
        case "model_response":
          await this.options.runs.recordLog(runId, {
            level: "info",
            message: `模型输出摘要：${summarize(event.contentSummary)}`
          });
          break;
        case "tool_request":
          await this.options.runs.recordLog(runId, {
            level: "info",
            message: `工具请求：${event.toolName} (${event.toolCallId})`
          });
          break;
        case "tool_result":
          await this.options.runs.recordLog(runId, {
            level: event.ok ? "info" : "warn",
            message: `工具结果：${event.toolName} ${event.ok ? "ok" : "failed"} — ${summarize(event.summary)}`
          });
          await this.options.runs.recordLog(runId, {
            level: "info",
            message: `工具活动：${event.toolName} ${summarize(event.summary).slice(0, 120)}`
          });
          break;
        case "artifact":
          await this.options.runs.recordArtifact(runId, {
            path: event.path,
            kind: event.artifactKind
          }).catch(() => undefined);
          break;
        case "limit":
          await this.options.runs.recordLog(runId, {
            level: "warn",
            message: `工具循环上限：${event.limit} — ${event.message}`
          });
          break;
        case "paused":
          await this.options.runs.recordLog(runId, {
            level: "info",
            message: `工具循环暂停（${event.reason}）：${summarize(event.detail)}`
          });
          break;
        default:
          break;
      }
    } catch {
      // Observability must not break the loop.
    }
  }

  private async applyToolLoopResult(
    runId: string,
    selection: ProfessionalAgentSelection,
    workspacePath: string,
    projectId: string,
    completedSteps: Set<string>,
    interruptedStep: string | undefined,
    loopResult: ToolLoopResult,
    signal: AbortSignal
  ): Promise<void> {
    // Register any remaining artifacts that onEvent may have missed under race conditions.
    for (const artifact of loopResult.artifacts) {
      try {
        await this.options.runs.recordArtifact(runId, { path: artifact.path, kind: artifact.kind });
      } catch {
        // ignore duplicate / auth edge cases mid-pause
      }
    }

    if (loopResult.status === "interrupted") {
      throw new Error(loopResult.error ?? "Professional Agent request was interrupted.");
    }

    if (loopResult.status === "failed" || loopResult.status === "failed_limit") {
      throw new Error(loopResult.error ?? loopResult.summary);
    }

    if (loopResult.status === "paused_approval" && loopResult.approval) {
      const kind = mapApprovalKind(loopResult.approval.kind);
      await this.options.runs.requestExecutionApproval(runId, {
        kind,
        summary: loopResult.approval.summary
      });
      return;
    }

    if (loopResult.status === "paused_ask_user" && loopResult.askUser) {
      await this.options.runs.failProfessionalExecution(runId, summarize(loopResult.askUser.prompt));
      await this.options.runs.requestAskUser(runId, {
        kind: "ask_user",
        prompt: loopResult.askUser.prompt,
        reason: loopResult.askUser.reason,
        inputMode: loopResult.askUser.options?.length ? "single_select" : "free_text",
        options: loopResult.askUser.options,
        required: true,
        source: {
          agent: "professional_agent",
          stepKey: "tool_loop_ask_user",
          roleId: selection.roleId,
          label: selection.name
        }
      });
      return;
    }

    if (loopResult.status === "paused_ask_replan" && loopResult.askUser) {
      await this.options.runs.failProfessionalExecution(runId, summarize(loopResult.askUser.prompt));
      await this.options.runs.requestAskUser(runId, {
        kind: "ask_replan",
        prompt: loopResult.askUser.prompt,
        reason: loopResult.askUser.reason,
        inputMode: "free_text",
        required: true,
        source: {
          agent: "professional_agent",
          stepKey: "tool_loop_ask_replan",
          roleId: selection.roleId,
          label: selection.name
        }
      });
      return;
    }

    // completed — apply any legacy final actions that were not already written via tools
    const summary = loopResult.finalSummary ?? loopResult.summary;
    await this.options.runs.recordLog(runId, {
      level: "info",
      message: `模型输出摘要：${summarize(summary)}（工具轮次 ${loopResult.turns}，约 ${loopResult.totalTokens} tokens）`
    });

    const actions = (loopResult.finalActions ?? []).map((action) => normalizeFileAction(action));
    if (actions.length > 0) {
      const workspace = new AgentWorkspace(this.options.projects, projectId, runId, this.options.runs);
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index]!;
        if (signal.aborted) throw new Error("Professional Agent request was interrupted.");
        const approval = gateAction(selection, action, workspacePath);
        if (approval) {
          await this.options.runs.requestExecutionApproval(runId, approval);
          return;
        }
        if (action.type !== "write_file" || !action.path || action.content === undefined) {
          await this.options.runs.requestExecutionApproval(runId, {
            kind: "unsupported_operation",
            summary: `Professional Agent 请求了当前执行器不支持的操作：${describeAction(action)}。`
          });
          return;
        }
        const targetPath = resolveProjectPath(workspacePath, action.path);
        const alreadyExists = await fileExists(targetPath);
        const actionKind = alreadyExists ? "overwrite_file" as const : "write_file" as const;
        const step = `${actionKind}:${action.path}`;
        const aliases = [`write_file:${action.path}`, `overwrite_file:${action.path}`];
        if (aliases.some((key) => completedSteps.has(key))) {
          await this.options.runs.recordLog(runId, {
            level: "info",
            message: `跳过已完成检查点步骤：write_file:${action.path}`
          });
          continue;
        }
        // Skip if the multi-turn tool already wrote this path.
        if (loopResult.artifacts.some((artifact) => artifact.path === action.path && artifact.kind === "file")) {
          await this.options.runs.recordLog(runId, {
            level: "info",
            message: `跳过工具循环已写入的文件：${action.path}`
          });
          completedSteps.add(step);
          completedSteps.add(`write_file:${action.path}`);
          continue;
        }
        const recovery = (await this.options.runs.get(runId)).checkpointRecovery;
        const matchesInterrupted = Boolean(
          interruptedStep
          && (interruptedStep === step || aliases.includes(interruptedStep))
        );
        if (actionKind === "overwrite_file" || isDangerousStepKey(step) || (matchesInterrupted && interruptedStep && isDangerousStepKey(interruptedStep))) {
          if (recovery?.dangerousReplayApproved !== true) {
            await this.options.runs.requestExecutionApproval(runId, {
              kind: dangerousKindFromStepKey(step),
              summary: actionKind === "overwrite_file"
                ? `Professional Agent 请求覆盖已有文件，必须由用户确认：${step}`
                : `中断的危险步骤不会自动重放，需用户确认：${step}`
            });
            return;
          }
        }
        const nextAction = actions[index + 1];
        const nextStep = nextAction ? stepKeyFor(nextAction) : undefined;
        await this.options.runs.beginExecutionStep(runId, step);
        await workspace.writeText(targetPath, action.content);
        const fingerprint = await captureWorkspaceFingerprint(
          workspacePath,
          [...(await this.options.runs.get(runId)).artifacts.map((artifact) => artifact.path), action.path]
        );
        await this.options.runs.recordExecutionStep(runId, step, {
          summary: `已写入 ${action.path}`,
          nextStep,
          workspaceFingerprint: fingerprint,
          actionKind,
          dangerous: actionKind === "overwrite_file"
        });
        await this.options.runs.recordArtifact(runId, { path: action.path, kind: "file" });
        completedSteps.add(step);
        completedSteps.add(`write_file:${action.path}`);
        if (actionKind === "overwrite_file") completedSteps.add(`overwrite_file:${action.path}`);
      }
    } else if (loopResult.toolTrace.some((entry) => entry.toolName === "write_file" || entry.toolName === "apply_patch")) {
      // Tools already produced files — record completed steps for checkpoint continuity.
      for (const artifact of loopResult.artifacts.filter((entry) => entry.kind === "file")) {
        const step = `write_file:${artifact.path}`;
        if (completedSteps.has(step)) continue;
        try {
          await this.options.runs.beginExecutionStep(runId, step);
          const fingerprint = await captureWorkspaceFingerprint(
            workspacePath,
            [...(await this.options.runs.get(runId)).artifacts.map((entry) => entry.path), artifact.path]
          );
          await this.options.runs.recordExecutionStep(runId, step, {
            summary: `工具循环已写入 ${artifact.path}`,
            workspaceFingerprint: fingerprint,
            actionKind: "write_file",
            dangerous: false
          });
          completedSteps.add(step);
        } catch {
          // Step recording is best-effort when artifacts already exist.
        }
      }
    } else if ((loopResult.finalActions?.length ?? 0) === 0 && loopResult.toolTrace.length === 0) {
      // Pure final with no actions and no tools — still valid completion if summary present.
    }

    const finishSummary = `Professional Agent 已完成：${summarize(summary)}`;
    await this.options.runs.finishProfessionalExecution(runId, finishSummary);
    // Continuous DAG is notified from start()'s completion.finally after clearActive.
  }

  private async captureRunFingerprint(run: Run) {
    const todo = await this.options.todos.get(run.todoId);
    if (!todo.projectId) return undefined;
    const project = await this.options.projects.get(todo.projectId);
    return captureWorkspaceFingerprint(project.workspacePath, run.artifacts.map((artifact) => artifact.path));
  }

  /**
   * Prefer unified Runtime Adapter stream events when available (role-based turns).
   * Temporary agents without a Role stay on the legacy chatCompletion path.
   */
  private async invokeModelTurn(input: {
    runId: string;
    selection: ProfessionalAgentSelection;
    signal: AbortSignal;
    userPayload: string;
    checkpointSummary?: string;
    /** Optional multi-turn system text (tool catalog); falls back to Role instruction. */
    systemOverride?: string;
  }): Promise<string> {
    const adapter = this.runtimeAdapter;
    const roleId = input.selection.roleId;
    const systemInstruction = input.systemOverride?.trim() || input.selection.systemInstruction;
    if (adapter && roleId) {
      // Fresh session id per model turn so multi-turn reconstruction stays checkpoint-friendly.
      const sessionId = `${input.runId}:turn:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const session = await adapter.start({
        roleId,
        sessionId,
        systemInstruction,
        checkpointSummary: input.checkpointSummary
      });
      const onAbort = (): void => {
        void adapter.cancel(session.sessionId).catch(() => undefined);
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const drained = await drainRuntimeSend(adapter, session.sessionId, {
          text: input.userPayload,
          signal: input.signal
        });
        for (const event of drained.events) {
          const line = runtimeEventToLog(event);
          if (line) {
            await this.options.runs.recordLog(input.runId, line).catch(() => undefined);
          }
        }
        if (drained.terminal?.kind === "fail") {
          throw new Error(drained.terminal.error.message);
        }
        if (drained.terminal?.kind === "interrupt") {
          throw new Error(drained.terminal.reason || "Professional Agent request was interrupted.");
        }
        if (!drained.text.trim()) {
          throw new Error("Professional Agent output must be valid JSON.");
        }
        return drained.text;
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        await adapter.dispose(session.sessionId).catch(() => undefined);
      }
    }

    // Legacy path — temporary agents and explicit preferRuntimeAdapter: false.
    const connectionId = input.selection.connectionId;
    if (!connectionId) throw new Error("The selected API-backed Professional Agent needs a model connection.");
    return this.options.connections.chatCompletion(connectionId, {
      modelId: input.selection.modelId,
      signal: input.signal,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: input.userPayload }
      ]
    });
  }

  private abort(runId: string): void {
    this.active.get(runId)?.controller.abort();
  }

  private clearActive(runId: string, active: ActiveExecution): void {
    if (this.active.get(runId) === active) this.active.delete(runId);
  }

  private async resolveSelection(runId: string, input: StartProfessionalAgentInput): Promise<ProfessionalAgentSelection> {
    if (input.roleId && input.temporaryAgent) throw new Error("Choose either an existing Role or a temporary Professional Agent.");
    if (input.roleId) return this.fromRole(await this.options.roles.get(input.roleId));
    if (input.temporaryAgent) return this.fromTemporary(input);
    const run = await this.options.runs.get(runId);
    if (run.execution.selectedAgent && run.execution.retryable) {
      if (run.execution.selectedAgent.harness === "codex-cli") {
        throw new Error("Retry this Run through the Codex CLI Harness.");
      }
      if (run.execution.selectedAgent.source === "role") {
        if (!run.execution.selectedAgent.roleId) throw new Error("The stored Professional Agent Role is missing its Role ID.");
        return this.fromRole(await this.options.roles.get(run.execution.selectedAgent.roleId));
      }
      return run.execution.selectedAgent;
    }
    throw new Error("Choose an existing Role or configure a temporary Professional Agent.");
  }

  private async fromRole(role: AgentRole): Promise<ProfessionalAgentSelection> {
    if (!role.enabled) throw new Error("The selected Agent Role is disabled.");
    if (role.harness !== "api") throw new Error("Task 08 requires an API-backed Agent Role.");
    if (!role.connectionId) throw new Error("The selected Agent Role needs a model connection.");
    if (role.permissions.workspace !== "project_only") throw new Error("The selected Agent Role does not permit Project workspace writes.");
    return this.withConnection({
      source: "role",
      roleId: role.id,
      name: role.name,
      responsibility: role.responsibility,
      systemInstruction: role.systemInstruction,
      harness: "api",
      connectionId: role.connectionId,
      modelId: role.modelId,
      skills: role.skills,
      tools: role.tools,
      permissions: role.permissions
    });
  }

  private async fromTemporary(input: StartProfessionalAgentInput): Promise<ProfessionalAgentSelection> {
    const temporary = input.temporaryAgent!;
    const candidate: ProfessionalAgentSelection = {
      source: "temporary",
      name: required(temporary.name, "A temporary Agent name is required."),
      responsibility: required(temporary.responsibility, "A temporary Agent responsibility is required."),
      systemInstruction: required(temporary.systemInstruction, "A temporary Agent system instruction is required."),
      harness: "api",
      connectionId: required(temporary.connectionId, "A temporary Agent model connection is required."),
      modelId: temporary.modelId?.trim() || undefined,
      skills: ["implement"],
      tools: normalizeTools(temporary.tools),
      permissions: { workspace: "project_only", network: false, shell: false, externalSend: false }
    };
    const ready = await this.withConnection(candidate);
    if (input.saveTemporaryRole && !input.confirmSaveTemporaryRole) {
      throw new Error("Confirm before saving a temporary Professional Agent as a long-term Role.");
    }
    return ready;
  }

  private async saveConfirmedTemporaryRole(
    input: StartProfessionalAgentInput,
    selection: ProfessionalAgentSelection
  ): Promise<AgentRole | undefined> {
    if (selection.source !== "temporary" || !input.saveTemporaryRole) return undefined;
    if (!selection.connectionId) throw new Error("A temporary Professional Agent model connection is required.");
    return this.options.roles.create({
      name: selection.name,
      responsibility: selection.responsibility,
      systemInstruction: selection.systemInstruction,
      connectionId: selection.connectionId,
      modelId: selection.modelId,
      harness: "api",
      reasoningEffort: "medium",
      skills: selection.skills ?? ["implement"],
      tools: selection.tools,
      permissions: selection.permissions ?? { workspace: "project_only", network: false, shell: false, externalSend: false },
      allowFirstmateAutoInvoke: false
    });
  }

  private async withConnection(selection: ProfessionalAgentSelection): Promise<ProfessionalAgentSelection> {
    if (!selection.connectionId) throw new Error("The selected API-backed Professional Agent needs a model connection.");
    const connection = await this.options.connections.get(selection.connectionId);
    if (!connection.enabled) throw new Error("The selected model connection is disabled.");
    if (!selection.tools.includes("filesystem")) throw new Error("The selected Professional Agent must authorize the filesystem tool.");
    return selection;
  }
}

function isCodeTask(taskType: TaskType | undefined): boolean {
  return taskType === "implementation" || taskType === "bug_fix" || taskType === "automation";
}

function resolveApprovedCommands(
  run: Run,
  latestPlan: { verificationCommands?: string[][] }
): string[][] {
  const fromPlanning = run.planning?.verificationCommands;
  if (Array.isArray(fromPlanning) && fromPlanning.length > 0) return fromPlanning.map((entry) => [...entry]);
  if (Array.isArray(latestPlan.verificationCommands) && latestPlan.verificationCommands.length > 0) {
    return latestPlan.verificationCommands.map((entry) => [...entry]);
  }
  return [];
}

function mapApprovalKind(kind: string): ExecutionApprovalKind {
  const normalized = kind.trim();
  if (
    normalized === "outside_workspace"
    || normalized === "delete_file"
    || normalized === "system_install"
    || normalized === "external_send"
    || normalized === "unapproved_skill"
    || normalized === "unapproved_tool"
    || normalized === "unsupported_operation"
  ) {
    return normalized;
  }
  return "unsupported_operation";
}

function normalizeFileAction(value: Record<string, unknown>): FileAction {
  if (typeof value.type !== "string" || !value.type.trim()) {
    throw new Error("Professional Agent action type is required.");
  }
  const parsed: FileAction = { type: value.type.trim() };
  for (const field of ["path", "content", "command", "destination", "skill"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`Professional Agent action ${field} must be text.`);
    }
    if (typeof value[field] === "string") {
      parsed[field] = field === "content" ? value[field] : value[field].trim();
    }
  }
  if (parsed.type === "write_file") {
    if (!parsed.path || parsed.content === undefined) {
      throw new Error("Professional Agent write_file actions need a path and content.");
    }
    if (Buffer.byteLength(parsed.content, "utf8") > maxFileBytes) {
      throw new Error("Professional Agent file content is too large.");
    }
  }
  return parsed;
}

function parseAgentOutput(value: string): AgentOutput {
  const candidate = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("Professional Agent output must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Professional Agent output must be a JSON object.");
  const output = parsed as Record<string, unknown>;
  if (typeof output.summary !== "string" || !output.summary.trim()) throw new Error("Professional Agent output needs a summary.");
  if (!Array.isArray(output.actions) || output.actions.length === 0 || output.actions.length > maxActions) {
    throw new Error("Professional Agent output needs between one and ten actions.");
  }
  const actions = output.actions.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Professional Agent action is invalid.");
    const action = value as Record<string, unknown>;
    if (typeof action.type !== "string" || !action.type.trim()) {
      throw new Error("Professional Agent action type is required.");
    }
    const parsed: FileAction = { type: action.type.trim() };
    for (const field of ["path", "content", "command", "destination", "skill"] as const) {
      if (action[field] !== undefined && typeof action[field] !== "string") {
        throw new Error(`Professional Agent action ${field} must be text.`);
      }
      if (typeof action[field] === "string") parsed[field] = field === "content" ? action[field] : action[field].trim();
    }
    if (parsed.type === "write_file") {
      if (!parsed.path || parsed.content === undefined) throw new Error("Professional Agent write_file actions need a path and content.");
      if (Buffer.byteLength(parsed.content, "utf8") > maxFileBytes) throw new Error("Professional Agent file content is too large.");
    }
    return parsed;
  });
  return { summary: output.summary.trim(), actions };
}

function gateAction(
  selection: ProfessionalAgentSelection,
  action: FileAction,
  workspacePath: string
): { kind: ExecutionApprovalKind; summary: string } | undefined {
  const requestedSkill = action.skill || "implement";
  const authorizedSkills = selection.skills ?? ["implement"];
  if (!authorizedSkills.includes(requestedSkill)) {
    return approval("unapproved_skill", `Professional Agent 请求未获角色授权的 Skill：${requestedSkill}（${describeAction(action)}）。`);
  }
  const permissions = selection.permissions ?? { workspace: "project_only" as const, network: false, shell: false, externalSend: false };
  const hasFilesystem = selection.tools.includes("filesystem") && permissions.workspace === "project_only";

  if (action.type === "write_file") {
    if (!hasFilesystem) return approval("unapproved_tool", `Professional Agent 未获文件系统/项目工作区权限：${describeAction(action)}。`);
    if (!action.path || !isApprovedWorkspacePath(workspacePath, action.path)) {
      return approval("outside_workspace", `Professional Agent 请求访问 Project 工作区外路径：${describeAction(action)}。`);
    }
    return undefined;
  }

  if (action.type === "delete_file") {
    if (!hasFilesystem) return approval("unapproved_tool", `Professional Agent 未获删除文件所需的文件系统权限：${describeAction(action)}。`);
    if (!action.path || !isApprovedWorkspacePath(workspacePath, action.path)) {
      return approval("outside_workspace", `Professional Agent 请求删除 Project 工作区外内容：${describeAction(action)}。`);
    }
    return approval("delete_file", `Professional Agent 请求删除内容，必须由用户确认：${describeAction(action)}。`);
  }

  if (action.type === "system_install" || (action.type === "run_command" && /\b(?:npm|pnpm|yarn|pip|brew|winget|choco)\s+(?:install|add)\b/i.test(action.command ?? ""))) {
    if (!selection.tools.includes("shell") || !permissions.shell) {
      return approval("unapproved_tool", `Professional Agent 未获 Shell/系统安装权限：${describeAction(action)}。`);
    }
    return approval("system_install", `Professional Agent 请求系统级安装，必须由用户确认：${describeAction(action)}。`);
  }

  if (action.type === "external_send") {
    if (!selection.tools.includes("web") || !permissions.network || !permissions.externalSend) {
      return approval("unapproved_tool", `Professional Agent 未获网络或对外发送权限：${describeAction(action)}。`);
    }
    return approval("external_send", `Professional Agent 请求向外部地址发送内容，必须由用户确认：${describeAction(action)}。`);
  }

  return approval("unsupported_operation", `Professional Agent 请求当前执行器不支持的操作：${describeAction(action)}。`);
}

function approval(kind: ExecutionApprovalKind, summary: string): { kind: ExecutionApprovalKind; summary: string } {
  return { kind, summary: summarize(summary) };
}

function isApprovedWorkspacePath(workspacePath: string, actionPath: string): boolean {
  try {
    resolveProjectPath(workspacePath, actionPath);
    return true;
  } catch {
    return false;
  }
}

function describeAction(action: FileAction): string {
  const subject = action.path ?? action.destination ?? action.command;
  return subject ? `${action.type} ${summarize(subject)}` : action.type;
}

function resolveProjectPath(workspacePath: string, actionPath: string): string {
  const trimmed = actionPath.trim();
  if (!trimmed || isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error("Professional Agent file paths must be relative to the approved Project workspace.");
  }
  const normalized = normalize(trimmed);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error("Professional Agent file paths must be relative to the approved Project workspace.");
  }
  return join(workspacePath, normalized);
}

function required(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function normalizeTools(values: string[] | undefined): string[] {
  return [...new Set((values ?? ["filesystem"]).map((value) => value.trim()).filter(Boolean))];
}

function summarize(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 300);
}

function stepKeyFor(action: FileAction): string | undefined {
  if (action.type === "write_file" && action.path) return `write_file:${action.path}`;
  if (action.type === "delete_file" && action.path) return `delete_file:${action.path}`;
  if (action.type === "system_install") return `system_install:${action.command ?? "install"}`;
  if (action.type === "external_send") return `external_send:${action.destination ?? "outbound"}`;
  if (action.type === "run_command" && action.command) return `run_command:${action.command}`;
  return action.type ? `${action.type}:${action.path ?? action.command ?? action.destination ?? "op"}` : undefined;
}

function isDangerousStepKey(step: string): boolean {
  return step.startsWith("delete_file:")
    || step.startsWith("overwrite_file:")
    || step.startsWith("system_install:")
    || step.startsWith("external_send:");
}

function dangerousKindFromStepKey(step: string): ExecutionApprovalKind {
  if (step.startsWith("system_install:")) return "system_install";
  if (step.startsWith("external_send:")) return "external_send";
  return "delete_file";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
