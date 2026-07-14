import { spawn as launchProcess, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { ProjectService } from "../projects/projectService.js";
import type { AgentRole, RoleService } from "../roles/roleService.js";
import {
  captureWorkspaceFingerprint,
  type ProfessionalAgentSelection,
  type Run,
  type RunService
} from "../runs/runService.js";
import type { TodoService } from "../todos/todoService.js";
import { leaseRequestFromRun, type RunQueueService } from "../queue/runQueueService.js";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import {
  CodexCliAdapter,
  createCodexCliPortFromRunner,
  normalizeCodexCliFailure,
  type CodexCliHarnessPort
} from "../runtime/codexCliAdapter.js";
import {
  createComplete,
  createFail,
  createInterrupt,
  EventSequencer
} from "../runtime/events.js";
import { runtimeEventToLog } from "../runtime/orchestration.js";
import type { RuntimeEvent } from "../runtime/types.js";
import {
  indexCodexWorktreeArtifacts,
  type CodexArtifactOutcome,
  type CodexWorktreeDependency
} from "./codexArtifactIndex.js";

export interface CodexCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

/** A narrow process contract keeps the Codex Harness deterministic in tests. */
export interface CodexCliProcess {
  stdout?: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  on(event: "close" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CodexCliRuntime {
  run(args: string[]): Promise<CodexCommandResult>;
  spawn(args: string[], cwd: string): CodexCliProcess;
  terminate(process: CodexCliProcess): Promise<void>;
}

export interface CodexCliStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  reason?: string;
}

export interface StartCodexCliInput {
  roleId?: string;
}

export interface CorrectCodexRunResult {
  run: Run;
  requiresReapproval: boolean;
  continued: boolean;
}

export interface CodexCliServiceOptions {
  projects: ProjectService;
  todos: TodoService;
  runs: RunService;
  roles: RoleService;
  runtime?: CodexCliRuntime;
  /** prepare returns created=true only for this attempt; get/captureDiff index artifacts after completion. */
  worktrees?: CodexWorktreeDependency;
  queue?: RunQueueService;
  /**
   * Optional unified Runtime Adapter (codex-cli harness).
   * When omitted, a CodexCliAdapter is built over the process runtime port so
   * probe / terminal events share the unified RuntimeEvent surface.
   */
  runtimeAdapter?: RuntimeAdapter;
  /** Optional injected Codex harness port (defaults to createCodexCliPortFromRunner). */
  harnessPort?: CodexCliHarnessPort;
  /**
   * Fired after Codex CLI settles (success or failure/pause).
   * Used by continuous DAG orchestration — errors are swallowed.
   */
  onExecutionSettled?: (event: {
    runId: string;
    outcome: "completed" | "failed";
    summary?: string;
  }) => void | Promise<void>;
}

interface ActiveCodexExecution {
  process?: CodexCliProcess;
  outputTail: Promise<void>;
  completion?: Promise<void>;
  terminating: boolean;
  termination?: Promise<void>;
  diagnosticTail: string[];
  /** Per-run sequence allocator for unified Runtime events. */
  sequencer: EventSequencer;
}

interface ExecutionContext {
  role: AgentRole;
  selection: ProfessionalAgentSelection;
  workspacePath: string;
  prompt: string;
  approvedPlanVersion: number;
}

const maxLogLineLength = 4_000;

/**
 * Runs the locally authenticated Codex CLI in an approved Project directory.
 * The CLI is deliberately invoked without a shell, so Project paths and user
 * instructions are arguments rather than executable shell text.
 */
export class CodexCliService {
  private readonly active = new Map<string, ActiveCodexExecution>();
  private readonly completions = new Map<string, Promise<void>>();
  private readonly completionOrder: string[] = [];
  /** Outcome recorded by observeCompletion; flushed after clearActive. */
  private readonly pendingSettled = new Map<string, { outcome: "completed" | "failed"; summary?: string }>();
  private readonly runtime: CodexCliRuntime;
  private readonly harnessPort: CodexCliHarnessPort;
  private readonly runtimeAdapter: RuntimeAdapter;

  constructor(private readonly options: CodexCliServiceOptions) {
    this.runtime = options.runtime ?? new NodeCodexCliRuntime();
    this.harnessPort = options.harnessPort ?? createCodexCliPortFromRunner({
      run: (args) => this.runtime.run(args),
      buildTurnArgs: (input) => this.commandArguments(input.workspacePath ?? process.cwd(), input.prompt)
    });
    this.runtimeAdapter = options.runtimeAdapter ?? new CodexCliAdapter({ port: this.harnessPort });
    this.options.runs.onExecutionInterrupted((runId) => this.abort(runId));
  }

  /** Probe via the unified Codex Runtime Adapter port (same taxonomy as contract suite). */
  async status(): Promise<CodexCliStatus> {
    return this.harnessPort.status();
  }

  /** Expose the Runtime Adapter for orchestration that wants unified stream events. */
  getRuntimeAdapter(): RuntimeAdapter {
    return this.runtimeAdapter;
  }

  async start(runId: string, input: StartCodexCliInput = {}): Promise<Run> {
    if (this.active.has(runId)) throw new Error("This Run already has an active Codex CLI process.");
    const current = await this.options.runs.get(runId);
    this.assertApprovedRun(current);

    const readiness = await this.status();
    if (!readiness.installed || !readiness.authenticated) {
      return this.pauseForReadiness(runId, readiness.reason ?? "Codex CLI is unavailable.");
    }

    let context = await this.resolveExecutionContext(input, current);
    // Fail-closed: never spawn Codex against the main workspace when Worktree DI is missing.
    const worktrees = this.options.worktrees;
    if (!worktrees) {
      return this.pauseForReadiness(
        runId,
        "代码 Run 需要隔离 Git Worktree 服务；主工作区未被修改。"
      );
    }
    const useWorktree = await worktrees.isGitWorkspace(context.workspacePath);
    if (!useWorktree) {
      return this.pauseForReadiness(
        runId,
        "代码 Run 需要可识别的 Git Project 才能创建隔离 Worktree；主工作区未被修改。"
      );
    }
    const prepared = await this.prepareRunForStart(runId, current);
    if (
      prepared.status === "paused"
      || prepared.checkpointRecovery?.status === "conflict"
      || prepared.checkpointRecovery?.status === "awaiting_dangerous_reapproval"
      || prepared.execution.pendingApproval?.status === "awaiting_confirmation"
    ) {
      // Checkpoint gate or readiness pause — do not begin execution.
      if (prepared.execution.status === "failed" || prepared.status === "paused") {
        return prepared;
      }
    }
    const afterPrepare = await this.options.runs.get(runId);
    const writeSessionFingerprint = writeSessionFingerprintFor(context, afterPrepare);
    const writeApprovalGranted = afterPrepare.execution.pendingApproval?.kind === "delete_file"
      && afterPrepare.execution.pendingApproval.status === "approved"
      && afterPrepare.execution.pendingApproval.authorizationFingerprint === writeSessionFingerprint;
    await this.options.runs.assertExecutionAuthorized(runId, "Codex CLI execution");

    const queueDecision = await this.admitToQueue(runId, context, true);
    if (queueDecision.paused) return queueDecision.run;

    const active: ActiveCodexExecution = {
      outputTail: Promise.resolve(),
      terminating: false,
      diagnosticTail: [],
      sequencer: new EventSequencer()
    };
    this.active.set(runId, active);
    this.forgetCompletion(runId);
    let spawning = false;
    try {
      const started = await this.options.runs.beginProfessionalExecution(runId, context.selection, {
        maxConsecutiveFailures: this.options.queue?.configuredMaxRetries()
      });
      const afterBegin = await this.options.runs.get(runId);
      if (afterBegin.planning?.approvedPlanVersion !== context.approvedPlanVersion) {
        await this.options.runs.failProfessionalExecution(runId, "批准计划已在启动期间变更；Run 已暂停，需按新计划重新启动。");
        this.clearActive(runId, active);
        this.releaseQueue(runId);
        return this.options.runs.get(runId);
      }
      if (active.terminating) {
        this.clearActive(runId, active);
        this.releaseQueue(runId);
        return this.options.runs.get(runId);
      }
      if (!writeApprovalGranted) {
        const paused = await this.options.runs.requestExecutionApproval(runId, {
          kind: "delete_file",
          summary: "Codex CLI 的非交互写入会修改或删除 Project 文件；确认后才会启动本次受限写入会话。",
          authorizationFingerprint: writeSessionFingerprint
        });
        this.clearActive(runId, active);
        this.releaseQueue(runId);
        return paused;
      }
      try {
        const session = await worktrees.prepare(runId, context.workspacePath);
        context = { ...context, workspacePath: session.workspacePath };
        const afterPreparation = await this.options.runs.get(runId);
        if (active.terminating || afterPreparation.status !== "running" || afterPreparation.execution.status !== "running") {
          // Only tear down a Worktree created in THIS attempt; never delete an existing undiscarded session.
          if (session.created) {
            try { await worktrees.discard(runId); } catch { /* preserve the stopped Run state */ }
          }
          this.clearActive(runId, active);
          this.releaseQueue(runId);
          return afterPreparation;
        }
      } catch (error) {
        this.clearActive(runId, active);
        this.releaseQueue(runId);
        return this.pauseAfterFailure(
          runId,
          error instanceof Error ? error.message : "无法创建隔离 Git Worktree；Run 已暂停。"
        );
      }
      spawning = true;
      await this.options.runs.beginExecutionStep(runId, "codex:session");
      const process = this.runtime.spawn(
        this.commandArguments(context.workspacePath, context.prompt),
        context.workspacePath
      );
      active.process = process;
      this.forwardOutput(runId, active, process.stdout, "stdout");
      this.forwardOutput(runId, active, process.stderr, "stderr");
      active.completion = this.observeCompletion(runId, active);
      this.rememberCompletion(runId, active.completion);
      void active.completion.finally(async () => {
        this.clearActive(runId, active);
        this.releaseQueue(runId);
        const settled = this.pendingSettled.get(runId);
        this.pendingSettled.delete(runId);
        if (settled) {
          await this.notifySettled(runId, settled.outcome, settled.summary);
        }
      });
      if (active.terminating) await this.abort(runId);
      return started;
    } catch (error) {
      this.clearActive(runId, active);
      this.releaseQueue(runId);
      const run = await this.options.runs.get(runId);
      if (active.terminating || run.status !== "running" || run.execution.status !== "running") return run;
      if (!spawning) throw error;
      return this.pauseAfterFailure(runId, this.runtimeFailureMessage(error));
    }
  }

  private async admitToQueue(
    runId: string,
    context: ExecutionContext,
    worktreeIsolated: boolean
  ): Promise<{ paused: true; run: Run } | { paused: false }> {
    const queue = this.options.queue;
    if (!queue) return { paused: false };
    const run = await this.options.runs.get(runId);
    const todo = await this.options.todos.get(run.todoId);
    const decision = await queue.admit(leaseRequestFromRun(run, {
      projectId: todo.projectId,
      readOnlyPermissions: context.selection.permissions?.workspace === "read_only",
      worktreeIsolated
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
    const completion = this.active.get(runId)?.completion ?? this.completions.get(runId);
    if (completion) await completion;
  }

  async correctAndContinue(
    runId: string,
    input: { instruction: string; changeKind?: "minor" | "goal" | "scope" | "acceptance" | "prohibition" }
  ): Promise<CorrectCodexRunResult> {
    const correction = await this.options.runs.submitCorrection(runId, input);
    if (correction.requiresReapproval || correction.run.execution.selectedAgent?.harness !== "codex-cli") {
      return { ...correction, continued: false };
    }
    await this.waitForCompletion(runId);
    const current = await this.options.runs.get(runId);
    if (!current.execution.retryable) return { run: current, requiresReapproval: false, continued: false };
    return { run: await this.start(runId), requiresReapproval: false, continued: true };
  }

  private async prepareRunForStart(runId: string, run: Run): Promise<Run> {
    const retrying =
      (run.status === "paused" || run.status === "interrupted" || run.status === "queued" || run.status === "failed")
      && run.execution.status === "failed"
      && run.execution.retryable
      && run.execution.selectedAgent?.harness === "codex-cli";
    if (retrying) {
      const alreadyPrepared = run.status === "queued" && run.checkpointRecovery?.status === "ready";
      const hasRecoveryMetadata = Boolean(
        (run.checkpointRecovery && run.checkpointRecovery.status !== "none")
        || (run.checkpoints && run.checkpoints.length > 0)
      );
      if (!alreadyPrepared && hasRecoveryMetadata) {
        const fingerprint = await this.captureRunFingerprint(run);
        const resumed = await this.options.runs.resumeFromCheckpoint(runId, {
          currentFingerprint: fingerprint,
          approveDangerousReplay: run.checkpointRecovery?.dangerousReplayApproved === true
        });
        if (!resumed.canContinue) return resumed.run;
        return resumed.run;
      }
      if (!alreadyPrepared && (run.status === "paused" || run.status === "interrupted")) {
        return this.options.runs.resumeRetryableExecution(runId);
      }
      return this.options.runs.get(runId);
    }
    if (run.status === "paused" && run.execution.status === "idle") {
      return this.options.runs.transition(runId, "queued", "Codex CLI 已就绪；Firstmate 将继续启动已选 Role。" );
    }
    return run;
  }

  private async captureRunFingerprint(run: Run) {
    const todo = await this.options.todos.get(run.todoId);
    if (!todo.projectId) return undefined;
    const project = await this.options.projects.get(todo.projectId);
    return captureWorkspaceFingerprint(project.workspacePath, run.artifacts.map((artifact) => artifact.path));
  }

  /** Coarse Codex session checkpoint — step-level tool events are not available from the CLI harness. */
  private async recordCodexCheckpoint(
    runId: string,
    workspacePath: string,
    step: string,
    stepStatus: "completed" | "interrupted" | "failed",
    summary: string
  ): Promise<void> {
    const run = await this.options.runs.get(runId);
    const fingerprint = await captureWorkspaceFingerprint(
      workspacePath,
      run.artifacts.map((artifact) => artifact.path)
    );
    if (stepStatus === "completed") {
      await this.options.runs.beginExecutionStep(runId, step);
      await this.options.runs.recordExecutionStep(runId, step, {
        summary,
        workspaceFingerprint: fingerprint,
        actionKind: "other",
        dangerous: false
      });
      return;
    }
    await this.options.runs.recordStepCheckpoint(runId, {
      step,
      stepStatus,
      summary,
      workspaceFingerprint: fingerprint,
      actionKind: "other",
      dangerous: false
    });
  }

  private async resolveExecutionContext(input: StartCodexCliInput, run: Run): Promise<ExecutionContext> {
    const role = await this.resolveRole(input, run);
    const selection = this.selectionFromRole(role);
    const todo = await this.options.todos.get(run.todoId);
    if (!todo.projectId) throw new Error("Codex CLI execution requires a Project workspace.");
    const project = await this.options.projects.get(todo.projectId);
    const plan = run.planVersions.find((entry) => entry.version === run.planning?.approvedPlanVersion);
    if (!plan) throw new Error("A Secondmate plan is required before Codex CLI execution.");
    return {
      role,
      selection,
      workspacePath: project.workspacePath,
      approvedPlanVersion: plan.version,
      prompt: buildPrompt({
        role,
        todo: { title: todo.title, description: todo.description },
        plan,
        corrections: run.messages.map((message) => message.content)
      })
    };
  }

  private async resolveRole(input: StartCodexCliInput, run: Run): Promise<AgentRole> {
    if (input.roleId) return this.options.roles.get(input.roleId);
    const selection = run.execution.selectedAgent;
    if (
      selection?.harness === "codex-cli"
      && selection.source === "role"
      && selection.roleId
      && run.execution.retryable
    ) {
      return this.options.roles.get(selection.roleId);
    }
    throw new Error("Choose a Codex CLI Agent Role before starting this Run.");
  }

  private selectionFromRole(role: AgentRole): ProfessionalAgentSelection {
    if (!role.enabled) throw new Error("The selected Codex CLI Role is disabled.");
    if (role.harness !== "codex-cli") throw new Error("The selected Role must use the Codex CLI Harness.");
    if (role.connectionId) throw new Error("A Codex CLI Role uses the local Codex login and cannot use an API model connection.");
    if (role.permissions.workspace !== "project_only") {
      throw new Error("The selected Codex CLI Role must be limited to the Project workspace.");
    }
    if (!role.permissions.shell || !role.tools.includes("shell")) {
      throw new Error("The selected Codex CLI Role must authorize its Shell tool.");
    }
    if (!role.tools.includes("filesystem") || !role.tools.includes("codex-cli")) {
      throw new Error("The selected Codex CLI Role must authorize the codex-cli and filesystem tools.");
    }
    if (!role.skills.includes("implement")) {
      throw new Error("The selected Codex CLI Role must authorize the implement Skill.");
    }
    if (role.permissions.network || role.permissions.externalSend) {
      throw new Error("The selected Codex CLI Role must disable network and external send because this non-interactive Harness fails closed.");
    }
    return {
      source: "role",
      roleId: role.id,
      name: role.name,
      responsibility: role.responsibility,
      systemInstruction: role.systemInstruction,
      harness: "codex-cli",
      modelId: role.modelId,
      skills: role.skills,
      tools: role.tools,
      permissions: role.permissions
    };
  }

  private commandArguments(workspacePath: string, prompt: string): string[] {
    return [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--skip-git-repo-check",
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      "-c",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c",
      "sandbox_workspace_write.writable_roots=[]",
      "--cd",
      workspacePath,
      prompt
    ];
  }

  private observeCompletion(runId: string, active: ActiveCodexExecution): Promise<void> {
    const process = active.process;
    if (!process) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: { exitCode?: number | null; error?: unknown }) => {
        if (settled) return;
        settled = true;
        void this.completeProcess(runId, active, result).finally(resolve);
      };
      process.on("close", (...args) => settle({ exitCode: typeof args[0] === "number" ? args[0] : null }));
      process.on("error", (...args) => settle({ error: args[0] }));
    });
  }

  private async completeProcess(
    runId: string,
    active: ActiveCodexExecution,
    result: { exitCode?: number | null; error?: unknown }
  ): Promise<void> {
    await active.outputTail;
    const run = await this.options.runs.get(runId);
    const interrupted = active.terminating || run.status !== "running" || run.execution.status !== "running";
    if (interrupted) {
      await this.emitRuntimeEvent(
        runId,
        active,
        createInterrupt(runId, active.sequencer.next(), active.terminating ? "用户停止了 Codex CLI 会话。" : "Codex CLI 会话已中断。")
      );
      // Still refresh Worktree → Artifact index after stop/pause so Reviewer keeps Diff history.
      await this.indexArtifactsAfterCodex(runId, active.terminating ? "interrupted" : "paused");
      return;
    }
    if (!result.error && result.exitCode === 0) {
      try {
        const todo = await this.options.todos.get(run.todoId);
        if (todo.projectId) {
          const project = await this.options.projects.get(todo.projectId);
          // Prefer isolated worktree path when available via active execution context is not stored;
          // fingerprint the project workspace artifacts for coarse recovery baseline.
          await this.recordCodexCheckpoint(runId, project.workspacePath, "codex:session", "completed", "Codex CLI 会话已完成。");
        }
      } catch {
        /* coarse checkpoint is best-effort; completion must still advance */
      }
      await this.emitRuntimeEvent(
        runId,
        active,
        createComplete(runId, active.sequencer.next(), "Codex CLI turn completed.")
      );
      // Index Diff/evidence while execution is still authorized, then finish for review.
      await this.indexArtifactsAfterCodex(runId, "success");
      const completeSummary = "Codex CLI 已完成执行，等待审查。";
      await this.options.runs.finishProfessionalExecution(runId, completeSummary);
      this.pendingSettled.set(runId, { outcome: "completed", summary: completeSummary });
      return;
    }
    const message = await this.completionFailureMessage(result, active.diagnosticTail);
    const normalized = normalizeCodexCliFailure(
      [result.error instanceof Error ? result.error.message : "", ...active.diagnosticTail, message].filter(Boolean).join("\n"),
      result.exitCode
    );
    await this.emitRuntimeEvent(
      runId,
      active,
      createFail(runId, active.sequencer.next(), {
        ...normalized,
        // Keep the existing user-facing Chinese guidance as the fail message.
        message
      })
    );
    await this.indexArtifactsAfterCodex(runId, "failure");
    await this.pauseAfterFailure(runId, message);
    this.pendingSettled.set(runId, { outcome: "failed", summary: message });
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
      // Continuous orchestration must never break Codex cleanup.
    }
  }

  /** Persist a unified RuntimeEvent onto the Run timeline (secret-free). */
  private async emitRuntimeEvent(
    runId: string,
    active: ActiveCodexExecution,
    event: RuntimeEvent
  ): Promise<void> {
    const line = runtimeEventToLog(event);
    if (!line) return;
    active.outputTail = active.outputTail
      .then(async () => {
        await this.options.runs.recordLog(runId, line);
      })
      .catch(() => undefined);
    await active.outputTail;
  }

  /**
   * Captures Worktree changed files + full Diff + verification and registers normalized Run evidence.
   * Best-effort: indexing failures must not block Codex terminal state transitions.
   */
  private async indexArtifactsAfterCodex(runId: string, outcome: CodexArtifactOutcome): Promise<void> {
    const worktrees = this.options.worktrees;
    if (!worktrees?.get || !worktrees.captureDiff) return;
    try {
      const run = await this.options.runs.get(runId);
      const plan = run.planVersions.find((entry) => entry.version === run.planning?.approvedPlanVersion);
      await indexCodexWorktreeArtifacts({
        runId,
        outcome,
        worktrees,
        runs: this.options.runs,
        autoVerify: outcome === "success",
        verificationCommands: plan?.verificationCommands
      });
    } catch {
      /* indexing is best-effort; terminal Run transition remains authoritative */
    }
  }

  private forwardOutput(
    runId: string,
    active: ActiveCodexExecution,
    stream: NodeJS.ReadableStream | undefined,
    source: "stdout" | "stderr"
  ): void {
    if (!stream) return;
    let remainder = "";
    let redactingPemBlock = false;
    const forwardLine = (line: string) => {
      if (redactingPemBlock) {
        if (/-----END [^-]+-----/i.test(line)) redactingPemBlock = false;
        return;
      }
      if (/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE|OPENSSH|PGP)[^-]*-----/i.test(line)) {
        redactingPemBlock = !/-----END [^-]+-----/i.test(line);
        this.queueOutput(runId, active, source, "[REDACTED PEM BLOCK]");
        return;
      }
      this.queueOutput(runId, active, source, line);
    };
    stream.on("data", (chunk: Buffer | string) => {
      const lines = `${remainder}${chunk.toString()}`.split(/\r?\n/);
      remainder = lines.pop() ?? "";
      for (const line of lines) forwardLine(line);
    });
    stream.on("end", () => {
      if (remainder) forwardLine(remainder);
      remainder = "";
    });
  }

  private queueOutput(runId: string, active: ActiveCodexExecution, source: "stdout" | "stderr", line: string): void {
    const output = redactOutput(line).trim();
    if (!output) return;
    active.diagnosticTail.push(output.slice(0, maxLogLineLength));
    while (active.diagnosticTail.length > 12) active.diagnosticTail.shift();
    const message = `Codex CLI ${source}: ${output.slice(0, maxLogLineLength)}`;
    active.outputTail = active.outputTail
      .then(async () => { await this.options.runs.recordLog(runId, { level: source === "stderr" ? "warn" : "info", message }); })
      .catch(() => undefined);
  }

  private async pauseForReadiness(runId: string, reason: string): Promise<Run> {
    const run = await this.options.runs.get(runId);
    if (run.status === "cancelled") throw new Error("A cancelled Run cannot start Codex CLI.");
    if (run.status === "paused" && run.execution.status === "idle") return run;
    return this.options.runs.transition(runId, "paused", reason);
  }

  private async pauseAfterFailure(runId: string, message: string): Promise<Run> {
    const run = await this.options.runs.get(runId);
    if (run.status === "cancelled") return run;
    if (run.status === "running" && run.execution.status === "running") {
      await this.options.runs.failProfessionalExecution(runId, message);
    }
    const failed = await this.options.runs.get(runId);
    if (failed.status === "cancelled" || failed.status === "paused") return failed;
    return this.options.runs.transition(runId, "paused", `${message} 已暂停，修复后可重试。`);
  }

  private async completionFailureMessage(
    result: { exitCode?: number | null; error?: unknown },
    diagnostics: string[]
  ): Promise<string> {
    const errorText = [result.error instanceof Error ? result.error.message : "", ...diagnostics].join("\n");
    // Classify through the shared Codex Runtime error normalizer, then map to stable Chinese guidance.
    const normalized = normalizeCodexCliFailure(errorText || "Codex CLI process failed.", result.exitCode);
    if (normalized.kind === "not_logged_in") {
      if (/ENOENT|not found|not recognized|未安装|不可用/i.test(errorText)) {
        return "Codex CLI 不可用。请确认已安装后重试。";
      }
      return "Codex CLI 登录已失效。请在本机运行 codex login 后重试。";
    }
    if (normalized.kind === "timeout") {
      return "Codex CLI 调用超时。请检查本机状态后重试。";
    }
    const readiness = await this.status();
    if (!readiness.installed || !readiness.authenticated) {
      return readiness.reason ?? "Codex CLI 不可用。请检查本机安装和登录状态后重试。";
    }
    if (typeof result.exitCode === "number") return `Codex CLI 以退出码 ${result.exitCode} 结束。`;
    return "Codex CLI 在完成前中断。";
  }

  private runtimeFailureMessage(error: unknown): string {
    const text = error instanceof Error ? error.message : "";
    const normalized = normalizeCodexCliFailure(text || "Codex CLI failed to start.");
    if (normalized.kind === "not_logged_in" || /ENOENT|not found|not recognized/i.test(text)) {
      return "Codex CLI 未安装或不可用。请安装后重试。";
    }
    return "Codex CLI 无法启动。请检查本机登录和安装状态后重试。";
  }

  private assertApprovedRun(run: Run): void {
    if (run.planning?.approvalStatus !== "approved" || !run.planning.approvedPlanVersion) {
      throw new Error("Codex CLI execution requires an approved plan.");
    }
  }

  private async abort(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (!active) return;
    if (active.termination) return active.termination;
    active.terminating = true;
    if (!active.process) return;
    active.termination = this.runtime.terminate(active.process);
    await active.termination;
  }

  private clearActive(runId: string, active: ActiveCodexExecution): void {
    if (this.active.get(runId) === active) this.active.delete(runId);
  }

  private rememberCompletion(runId: string, completion: Promise<void>): void {
    this.forgetCompletion(runId);
    this.completions.set(runId, completion);
    this.completionOrder.push(runId);
    while (this.completionOrder.length > 32) {
      const oldest = this.completionOrder.shift();
      if (oldest) this.completions.delete(oldest);
    }
  }

  private forgetCompletion(runId: string): void {
    this.completions.delete(runId);
    const index = this.completionOrder.indexOf(runId);
    if (index >= 0) this.completionOrder.splice(index, 1);
  }
}

export class NodeCodexCliRuntime implements CodexCliRuntime {
  async run(args: string[]): Promise<CodexCommandResult> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = launchProcess("codex", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolve({ exitCode: null, stdout: "", stderr: "", errorCode: errorCode(error) });
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: CodexCommandResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
      child.once("error", (error) => finish({ exitCode: null, stdout, stderr, errorCode: errorCode(error) }));
      child.once("close", (exitCode) => finish({ exitCode, stdout, stderr }));
    });
  }

  spawn(args: string[], cwd: string): CodexCliProcess {
    return launchProcess("codex", args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  async terminate(child: CodexCliProcess): Promise<void> {
    const closed = waitForClose(child);
    if (process.platform === "win32") {
      await terminateWindowsProcessTree(child, closed);
      return;
    }
    signalProcessTree(child, "SIGTERM");
    if (await settlesWithin(closed, 3_000)) return;
    signalProcessTree(child, "SIGKILL");
    if (await settlesWithin(closed, 2_000)) return;
    throw new Error("Codex CLI process did not exit after termination escalation.");
  }
}

async function terminateWindowsProcessTree(child: CodexCliProcess, closed: Promise<void>): Promise<void> {
  const taskkillExitCode = child.pid ? await runTaskkill(child.pid) : null;
  if (taskkillExitCode !== 0) {
    try { child.kill("SIGTERM"); } catch { /* process already exited */ }
  }
  if (await settlesWithin(closed, 5_000)) return;
  throw new Error("Codex CLI Windows process tree could not be terminated.");
}

async function runTaskkill(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    let killer: ChildProcess;
    try {
      killer = launchProcess("taskkill", ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
    } catch {
      resolve(null);
      return;
    }
    killer.once("error", () => resolve(null));
    killer.once("close", (exitCode) => resolve(exitCode));
  });
}

function signalProcessTree(child: CodexCliProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    try { child.kill(signal); } catch { /* process already exited */ }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (errorCode(error) === "ESRCH") return;
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

function waitForClose(child: CodexCliProcess): Promise<void> {
  if ((child.exitCode !== undefined && child.exitCode !== null) || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.on("close", finish);
    child.on("error", finish);
  });
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(
      () => { clearTimeout(timeout); resolve(true); },
      () => { clearTimeout(timeout); resolve(false); }
    );
  });
}

function buildPrompt(input: {
  role: AgentRole;
  todo: { title: string; description?: string };
  plan: NonNullable<Run["planVersions"]>[number];
  corrections: string[];
}): string {
  return [
    `你是 ${input.role.name}，职责：${input.role.responsibility}。`,
    input.role.systemInstruction,
    "只在当前已批准的 Project 工作目录中执行。不得访问工作目录外路径、发送外部内容，且不得尝试请求沙箱升级。",
    `任务：${input.todo.title}`,
    input.todo.description ? `任务说明：${input.todo.description}` : "",
    "已批准的 Secondmate 计划：",
    `步骤：${(input.plan.steps ?? []).join("；") || input.plan.summary}`,
    `验收标准：${(input.plan.acceptanceCriteria ?? []).join("；") || "遵循计划摘要。"}`,
    `风险：${(input.plan.risks ?? []).join("；") || "无额外风险。"}`,
    `禁止项：${(input.plan.prohibitions ?? []).join("；") || "不得超出已批准范围。"}`,
    input.corrections.length > 0 ? `用户补充/纠偏：${input.corrections.join("；")}` : "",
    "执行完成后运行与变更相关的验证，并在最终消息中简要说明改动和验证结果。"
  ].filter(Boolean).join("\n\n");
}

function writeSessionFingerprintFor(context: ExecutionContext, run: Run): string {
  return createHash("sha256")
    .update(JSON.stringify({
      approvedPlanVersion: run.planning?.approvedPlanVersion,
      roleId: context.role.id,
      roleInstruction: context.role.systemInstruction,
      roleSkills: context.role.skills,
      roleTools: context.role.tools,
      rolePermissions: context.role.permissions,
      prompt: context.prompt
    }))
    .digest("hex");
}

function redactOutput(value: string): string {
  return value
    .replace(/-----BEGIN [\s\S]*?-----END [\s\S]*?-----/g, "[REDACTED PEM BLOCK]")
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+[a-z0-9]+)?|redis|amqps?):\/\/[^\s'"`]+/gi, "[REDACTED CONNECTION URI]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*.+$/gi, "$1: [REDACTED]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|credential|private[_-]?key|database[_-]?url|connection(?:[_-]?string)?|key))\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
      "$1: [REDACTED]"
    );
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
