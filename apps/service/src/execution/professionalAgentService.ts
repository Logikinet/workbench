import { access } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { ConnectionService } from "../connections/connectionService.js";
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

export interface ProfessionalAgentServiceOptions {
  projects: ProjectService;
  todos: TodoService;
  runs: RunService;
  roles: RoleService;
  connections: ConnectionService;
  queue?: RunQueueService;
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

  constructor(private readonly options: ProfessionalAgentServiceOptions) {
    this.options.runs.onExecutionInterrupted((runId) => this.abort(runId));
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
      const completion = this.perform(runId, selection, controller.signal).catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : "Professional Agent execution failed.";
        await this.options.runs.failProfessionalExecution(runId, message);
      });
      active.completion = completion;
      void completion.then(
        () => {
          this.clearActive(runId, active);
          this.releaseQueue(runId);
        },
        () => {
          this.clearActive(runId, active);
          this.releaseQueue(runId);
        }
      );
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
        ? `正在重建模型会话并调用 Professional Agent：${selection.name}。${recoveryNote}`
        : `正在调用 Professional Agent：${selection.name}。`
    });
    if (signal.aborted) return;
    const connectionId = selection.connectionId;
    if (!connectionId) throw new Error("The selected API-backed Professional Agent needs a model connection.");
    const response = await this.options.connections.chatCompletion(connectionId, {
      modelId: selection.modelId,
      signal,
      messages: [
        { role: "system", content: selection.systemInstruction },
        {
          role: "user",
          content: JSON.stringify({
            task: todo.title,
            description: todo.description,
            workspace: "approved-project-workspace",
            plan: {
              steps: latestPlan.steps,
              acceptanceCriteria: latestPlan.acceptanceCriteria,
              risks: latestPlan.risks,
              prohibitions: latestPlan.prohibitions
            },
            checkpoint: {
              completedSteps: [...completedSteps],
              interruptedStep,
              recoveryMode: "reconstruct_and_replay",
              note: recoveryNote ?? "Original model internal session is not restored."
            },
            corrections: run.messages.map((message) => message.content),
            outputContract: {
              summary: "short non-secret summary",
              actions: [{ type: "write_file", path: "relative/path.ext", content: "file content" }]
            },
            constraints: [
              "Return JSON only.",
              "Only request write_file actions with relative paths.",
              "Do not request shell commands, network requests, deletion, or external sending.",
              "Do not repeat completedSteps; only continue from interruptedStep or remaining work."
            ]
          })
        }
      ]
    });
    const output = parseAgentOutput(response);
    await this.options.runs.recordLog(runId, { level: "info", message: `模型输出摘要：${summarize(output.summary)}` });
    const workspace = new AgentWorkspace(this.options.projects, project.id, runId, this.options.runs);

    for (let index = 0; index < output.actions.length; index += 1) {
      const action = output.actions[index]!;
      if (signal.aborted) throw new Error("Professional Agent request was interrupted.");
      const approval = gateAction(selection, action, project.workspacePath);
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
      const targetPath = resolveProjectPath(project.workspacePath, action.path);
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
      const recovery = (await this.options.runs.get(runId)).checkpointRecovery;
      const matchesInterrupted = Boolean(
        interruptedStep
        && (interruptedStep === step || aliases.includes(interruptedStep))
      );
      // Dangerous ops (including overwrite) never auto-replay without explicit re-approval — even when replaying the interrupted step.
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
      const nextAction = output.actions[index + 1];
      const nextStep = nextAction ? stepKeyFor(nextAction) : undefined;
      await this.options.runs.beginExecutionStep(runId, step);
      await workspace.writeText(targetPath, action.content);
      const fingerprint = await captureWorkspaceFingerprint(
        project.workspacePath,
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
    await this.options.runs.finishProfessionalExecution(runId, `Professional Agent 已完成：${summarize(output.summary)}`);
  }

  private async captureRunFingerprint(run: Run) {
    const todo = await this.options.todos.get(run.todoId);
    if (!todo.projectId) return undefined;
    const project = await this.options.projects.get(todo.projectId);
    return captureWorkspaceFingerprint(project.workspacePath, run.artifacts.map((artifact) => artifact.path));
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
