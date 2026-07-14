import { randomUUID } from "node:crypto";
import type { RuntimeAdapter } from "./adapter.js";
import {
  createApproval,
  createArtifact,
  createAskUser,
  createComplete,
  createFail,
  createInterrupt,
  createTextDelta,
  createToolRequest,
  createToolResult,
  createUsage,
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

export type StubSendScenario =
  | "success"
  | "tools"
  | "ask_user"
  | "approval_artifact"
  | "fail"
  | "cancel";

export interface StubRuntimeAdapterOptions {
  /** Future harness id, e.g. "claude-code". Defaults to "stub-harness". */
  harness?: string;
  capabilities?: Partial<RuntimeCapabilities>;
  probeReady?: boolean;
  probeReason?: string;
  /** Default send scenario when not overridden per call. */
  scenario?: StubSendScenario;
  failMessage?: string;
}

interface SessionState {
  session: RuntimeSession;
  sequencer: EventSequencer;
  disposed: boolean;
  cancelRequested: boolean;
  systemInstruction?: string;
  scenario: StubSendScenario;
}

const defaultCapabilities: RuntimeCapabilities = {
  reasoning: true,
  images: true,
  tools: true,
  resume: true,
  workspace: true,
  network: true,
  structuredOutput: true
};

/**
 * Minimal in-memory harness used by the contract suite and as a template for
 * future adapters (Claude Code, etc.). Emits only unified RuntimeEvent kinds.
 */
export class StubRuntimeAdapter implements RuntimeAdapter {
  readonly harness: string;
  private readonly sessions = new Map<string, SessionState>();
  private readonly caps: RuntimeCapabilities;
  private readonly probeReady: boolean;
  private readonly probeReason?: string;
  private readonly defaultScenario: StubSendScenario;
  private readonly failMessage: string;

  /** Per-session scenario override for targeted tests. */
  readonly scenarioBySession = new Map<string, StubSendScenario>();

  constructor(options: StubRuntimeAdapterOptions = {}) {
    this.harness = options.harness?.trim() || "stub-harness";
    this.caps = { ...defaultCapabilities, ...options.capabilities };
    this.probeReady = options.probeReady ?? true;
    this.probeReason = options.probeReason;
    this.defaultScenario = options.scenario ?? "success";
    this.failMessage = options.failMessage ?? "stub harness forced failure";
  }

  capabilities(): RuntimeCapabilities {
    return { ...this.caps };
  }

  async probe(): Promise<RuntimeProbeResult> {
    return {
      ready: this.probeReady,
      harness: this.harness,
      capabilities: this.capabilities(),
      reason: this.probeReady ? undefined : (this.probeReason ?? "Stub harness not ready.")
    };
  }

  async start(input: RuntimeStartInput): Promise<RuntimeSession> {
    const sessionId = input.sessionId?.trim() || randomUUID();
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.disposed) {
      if (input.checkpointSummary) existing.session.checkpointSummary = input.checkpointSummary;
      if (input.systemInstruction) existing.systemInstruction = input.systemInstruction;
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
      disposed: false,
      cancelRequested: false,
      systemInstruction: input.systemInstruction,
      scenario: this.scenarioBySession.get(sessionId) ?? this.defaultScenario
    });
    return { ...session };
  }

  async *send(sessionId: string, input: RuntimeSendInput): AsyncIterable<RuntimeEvent> {
    const state = this.requireSession(sessionId);
    state.cancelRequested = false;
    state.session.status = "running";
    const scenario = this.scenarioBySession.get(sessionId) ?? state.scenario;

    if (input.signal?.aborted || state.cancelRequested) {
      state.session.status = "cancelled";
      yield createInterrupt(sessionId, state.sequencer.next(), "用户取消了运行时会话。");
      return;
    }

    if (scenario === "fail") {
      state.session.status = "failed";
      yield createFail(
        sessionId,
        state.sequencer.next(),
        normalizeRuntimeError({ kind: "protocol_error", message: this.failMessage }, "protocol_error")
      );
      return;
    }

    if (scenario === "cancel") {
      state.session.status = "cancelled";
      yield createInterrupt(sessionId, state.sequencer.next(), "用户取消了运行时会话。");
      return;
    }

    const preface = [
      state.systemInstruction ? `instructions:${state.systemInstruction}` : "",
      state.session.checkpointSummary ? `checkpoint:${state.session.checkpointSummary}` : "",
      input.text
    ]
      .filter(Boolean)
      .join("\n");

    yield createTextDelta(sessionId, preface, state.sequencer.next());

    if (scenario === "tools") {
      const toolCallId = `tool-${state.sequencer.peek() + 1}`;
      yield createToolRequest(sessionId, state.sequencer.next(), {
        toolCallId,
        toolName: "read_file",
        arguments: { path: "src/main.ts" }
      });
      yield createToolResult(sessionId, state.sequencer.next(), {
        toolCallId,
        toolName: "read_file",
        ok: true,
        resultSummary: "file contents ok"
      });
    }

    if (scenario === "ask_user") {
      yield createAskUser(sessionId, state.sequencer.next(), {
        prompt: "Continue with the plan?",
        options: ["yes", "no"]
      });
    }

    if (scenario === "approval_artifact") {
      yield createApproval(sessionId, state.sequencer.next(), {
        approvalKind: "shell",
        summary: "Run npm test",
        status: "requested"
      });
      yield createArtifact(sessionId, state.sequencer.next(), {
        path: "dist/out.js",
        artifactKind: "file",
        summary: "build output"
      });
    }

    yield createUsage(sessionId, state.sequencer.next(), {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30
    });

    if (input.signal?.aborted || state.cancelRequested) {
      state.session.status = "cancelled";
      yield createInterrupt(sessionId, state.sequencer.next(), "用户取消了运行时会话。");
      return;
    }

    state.session.status = "completed";
    yield createComplete(sessionId, state.sequencer.next(), "Stub harness turn completed.");
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
  }

  async dispose(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.cancelRequested = true;
    state.disposed = true;
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
