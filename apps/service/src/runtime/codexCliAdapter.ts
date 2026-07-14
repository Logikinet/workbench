import { randomUUID } from "node:crypto";
import type { RuntimeAdapter } from "./adapter.js";
import {
  createComplete,
  createFail,
  createInterrupt,
  createTextDelta,
  EventSequencer
} from "./events.js";
import { normalizeRuntimeError } from "./errors.js";
import type {
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeProbeResult,
  RuntimeResumeInput,
  RuntimeSendInput,
  RuntimeSession,
  RuntimeStartInput
} from "./types.js";

export interface CodexCliProbeStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  reason?: string;
}

export interface CodexCliCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

/**
 * Narrow process/command surface so Codex adapter tests stay deterministic
 * without spawning a real CLI.
 */
export interface CodexCliHarnessPort {
  status(): Promise<CodexCliProbeStatus>;
  /**
   * Execute one prompt turn in the given workspace.
   * Implementations must not return secrets in stdout/stderr (caller still redacts).
   */
  runTurn(input: {
    prompt: string;
    workspacePath?: string;
    checkpointSummary?: string;
    signal?: AbortSignal;
  }): Promise<CodexCliCommandResult>;
  cancel?(sessionId: string): Promise<void>;
}

export interface CodexCliAdapterOptions {
  port: CodexCliHarnessPort;
}

interface SessionState {
  session: RuntimeSession;
  sequencer: EventSequencer;
  workspacePath?: string;
  systemInstruction?: string;
  active: boolean;
  disposed: boolean;
  cancelRequested: boolean;
}

const codexCapabilities: RuntimeCapabilities = {
  reasoning: true,
  images: false,
  tools: true,
  resume: true,
  workspace: true,
  network: true,
  structuredOutput: false
};

/**
 * Codex CLI harness adapter implementing the unified Runtime Adapter contract.
 * Private CLI stdout/stderr is normalized into RuntimeEvent stream events.
 */
export class CodexCliAdapter implements RuntimeAdapter {
  readonly harness = "codex-cli" as const;
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly options: CodexCliAdapterOptions) {}

  capabilities(): RuntimeCapabilities {
    return { ...codexCapabilities };
  }

  async probe(): Promise<RuntimeProbeResult> {
    try {
      const status = await this.options.port.status();
      if (!status.installed) {
        return {
          ready: false,
          harness: this.harness,
          capabilities: this.capabilities(),
          reason: status.reason ?? "Codex CLI 未安装。"
        };
      }
      if (!status.authenticated) {
        return {
          ready: false,
          harness: this.harness,
          capabilities: this.capabilities(),
          reason: status.reason ?? "Codex CLI 尚未登录。"
        };
      }
      return {
        ready: true,
        harness: this.harness,
        capabilities: this.capabilities(),
        details: { version: status.version }
      };
    } catch (error) {
      return {
        ready: false,
        harness: this.harness,
        capabilities: this.capabilities(),
        reason: normalizeRuntimeError(error).message
      };
    }
  }

  async start(input: RuntimeStartInput): Promise<RuntimeSession> {
    const sessionId = input.sessionId?.trim() || randomUUID();
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.disposed) {
      if (input.checkpointSummary) existing.session.checkpointSummary = input.checkpointSummary;
      if (input.workspacePath) existing.workspacePath = input.workspacePath;
      existing.session.status = "ready";
      return { ...existing.session };
    }

    const session: RuntimeSession = {
      sessionId,
      harness: this.harness,
      roleId: input.roleId,
      createdAt: new Date().toISOString(),
      checkpointSummary: input.checkpointSummary,
      status: "ready"
    };
    this.sessions.set(sessionId, {
      session,
      sequencer: new EventSequencer(),
      workspacePath: input.workspacePath,
      systemInstruction: input.systemInstruction,
      active: false,
      disposed: false,
      cancelRequested: false
    });
    return { ...session };
  }

  async *send(sessionId: string, input: RuntimeSendInput): AsyncIterable<RuntimeEvent> {
    const state = this.requireSession(sessionId);
    state.cancelRequested = false;
    state.active = true;
    state.session.status = "running";

    const readiness = await this.probe();
    if (!readiness.ready) {
      const kind = /登录|login|auth/i.test(readiness.reason ?? "") ? "not_logged_in" : "protocol_error";
      const error = normalizeRuntimeError({ kind, message: readiness.reason ?? "Codex CLI unavailable." }, kind);
      state.session.status = "failed";
      state.active = false;
      yield createFail(sessionId, state.sequencer.next(), error);
      return;
    }

    try {
      const promptParts = [
        state.systemInstruction ? `Role instructions:\n${state.systemInstruction}` : "",
        state.session.checkpointSummary
          ? `Checkpoint summary for session rebuild:\n${state.session.checkpointSummary}`
          : "",
        input.text
      ].filter(Boolean);

      const result = await this.options.port.runTurn({
        prompt: promptParts.join("\n\n"),
        workspacePath: state.workspacePath,
        checkpointSummary: state.session.checkpointSummary,
        signal: input.signal
      });

      if (state.cancelRequested || input.signal?.aborted) {
        state.session.status = "cancelled";
        state.active = false;
        yield createInterrupt(sessionId, state.sequencer.next(), "用户取消了运行时会话。");
        return;
      }

      if (result.errorCode === "ENOENT") {
        state.session.status = "failed";
        state.active = false;
        yield createFail(
          sessionId,
          state.sequencer.next(),
          normalizeRuntimeError({ kind: "not_logged_in", message: "Codex CLI 未安装。" }, "not_logged_in")
        );
        return;
      }

      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (result.exitCode !== 0 && result.exitCode !== null) {
        const error = normalizeCodexCliFailure(
          combined || `Codex CLI exited with code ${result.exitCode}.`,
          result.exitCode
        );
        state.session.status = "failed";
        state.active = false;
        yield createFail(sessionId, state.sequencer.next(), error);
        return;
      }

      if (combined) {
        yield createTextDelta(sessionId, combined, state.sequencer.next());
      }
      state.session.status = "completed";
      state.active = false;
      yield createComplete(sessionId, state.sequencer.next(), "Codex CLI turn completed.");
    } catch (error) {
      if (state.cancelRequested || input.signal?.aborted || (error as { name?: string })?.name === "AbortError") {
        state.session.status = "cancelled";
        state.active = false;
        yield createInterrupt(sessionId, state.sequencer.next(), "用户取消了运行时会话。");
        return;
      }
      state.session.status = "failed";
      state.active = false;
      yield createFail(sessionId, state.sequencer.next(), normalizeRuntimeError(error));
    }
  }

  async resume(sessionId: string, input: RuntimeResumeInput = {}): Promise<RuntimeSession> {
    const state = this.requireSession(sessionId);
    if (input.checkpointSummary) {
      state.session.checkpointSummary = input.checkpointSummary;
    }
    state.session.status = "ready";
    return { ...state.session };
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.disposed) return;
    state.cancelRequested = true;
    state.session.status = "cancelled";
    await this.options.port.cancel?.(sessionId);
  }

  async dispose(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.cancelRequested = true;
    state.disposed = true;
    await this.options.port.cancel?.(sessionId);
    this.sessions.delete(sessionId);
  }

  private requireSession(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state || state.disposed) {
      throw Object.assign(new Error(`Runtime session ${sessionId} was not found.`), {
        kind: "protocol_error"
      });
    }
    return state;
  }
}

/** Normalize Codex CLI process failure text into the unified runtime error taxonomy. */
export function normalizeCodexCliFailure(message: string, exitCode?: number | null) {
  const lower = message.toLowerCase();
  const code = exitCode ?? undefined;
  if (/login|auth|credential|unauthori[sz]ed|not logged in|尚未登录|登录已失效/i.test(message)) {
    return normalizeRuntimeError({ kind: "not_logged_in", message, code }, "not_logged_in");
  }
  if (/quota|rate limit/i.test(lower)) {
    return normalizeRuntimeError({ kind: "quota_exceeded", message, code }, "quota_exceeded");
  }
  if (/timed out|timeout/i.test(lower)) {
    return normalizeRuntimeError({ kind: "timeout", message, code }, "timeout");
  }
  if (/ENOENT|not found|not recognized|未安装|不可用/i.test(message)) {
    return normalizeRuntimeError({ kind: "not_logged_in", message, code }, "not_logged_in");
  }
  if (typeof exitCode === "number" && exitCode !== 0) {
    return normalizeRuntimeError({ kind: "process_exit", message, code: exitCode }, "process_exit");
  }
  return normalizeRuntimeError({ kind: "process_exit", message, code }, "process_exit");
}

/**
 * Production Codex CLI port over a narrow `run(args)` command surface.
 * Used by CodexCliAdapter.probe/send and by CodexCliService for unified status.
 */
export function createCodexCliPortFromRunner(runner: {
  run(args: string[]): Promise<CodexCliCommandResult>;
  /**
   * Optional custom argv for a prompt turn. Defaults to a non-interactive
   * workspace-write exec similar to the production Codex harness.
   */
  buildTurnArgs?: (input: {
    prompt: string;
    workspacePath?: string;
  }) => string[];
}): CodexCliHarnessPort {
  return {
    async status(): Promise<CodexCliProbeStatus> {
      let versionCheck: CodexCliCommandResult;
      try {
        versionCheck = await runner.run(["--version"]);
      } catch {
        return {
          installed: false,
          authenticated: false,
          reason: "无法检测 Codex CLI。请检查本机安装和登录状态后重试。"
        };
      }
      if (versionCheck.errorCode === "ENOENT") {
        return {
          installed: false,
          authenticated: false,
          reason: "Codex CLI 未安装。请安装 Codex CLI 后重新执行此 Run。"
        };
      }
      if (versionCheck.exitCode !== 0) {
        return {
          installed: true,
          authenticated: false,
          reason: "Codex CLI 无法正常启动。请检查本机安装后重试。"
        };
      }

      const version = firstNonEmptyLine(versionCheck.stdout) || undefined;
      let loginCheck: CodexCliCommandResult;
      try {
        loginCheck = await runner.run(["login", "status"]);
      } catch {
        return {
          installed: true,
          authenticated: false,
          version,
          reason: "无法验证 Codex CLI 登录状态。请在本机运行 codex login 后重试。"
        };
      }
      if (loginCheck.exitCode !== 0) {
        return {
          installed: true,
          authenticated: false,
          version,
          reason: "Codex CLI 尚未登录或登录已失效。请在本机运行 codex login 后重试。"
        };
      }
      return { installed: true, authenticated: true, version };
    },

    async runTurn(input: {
      prompt: string;
      workspacePath?: string;
      checkpointSummary?: string;
      signal?: AbortSignal;
    }): Promise<CodexCliCommandResult> {
      if (input.signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      const args = runner.buildTurnArgs
        ? runner.buildTurnArgs({ prompt: input.prompt, workspacePath: input.workspacePath })
        : defaultCodexTurnArgs(input.prompt, input.workspacePath);
      const result = await runner.run(args);
      if (input.signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return result;
    }
  };
}

function defaultCodexTurnArgs(prompt: string, workspacePath?: string): string[] {
  const args = [
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
    "sandbox_workspace_write.writable_roots=[]"
  ];
  if (workspacePath) {
    args.push("--cd", workspacePath);
  }
  args.push(prompt);
  return args;
}

function firstNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/** In-memory Codex port for contract tests. */
export class FakeCodexCliPort implements CodexCliHarnessPort {
  statusResult: CodexCliProbeStatus = { installed: true, authenticated: true, version: "fake-1.0" };
  turnResult: CodexCliCommandResult = { exitCode: 0, stdout: "codex ok", stderr: "" };
  turnError?: Error;
  delayMs = 0;
  readonly turns: Array<{ prompt: string; workspacePath?: string; checkpointSummary?: string }> = [];
  cancelled: string[] = [];

  async status(): Promise<CodexCliProbeStatus> {
    return { ...this.statusResult };
  }

  async runTurn(input: {
    prompt: string;
    workspacePath?: string;
    checkpointSummary?: string;
    signal?: AbortSignal;
  }): Promise<CodexCliCommandResult> {
    this.turns.push({
      prompt: input.prompt,
      workspacePath: input.workspacePath,
      checkpointSummary: input.checkpointSummary
    });
    if (input.signal?.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        input.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true }
        );
      });
    }
    if (this.turnError) throw this.turnError;
    return { ...this.turnResult };
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
  }
}
