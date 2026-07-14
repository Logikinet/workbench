import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "../model/modelRuntime.js";
import type { RuntimeAdapter } from "./adapter.js";
import {
  createComplete,
  createFail,
  createInterrupt,
  createTextDelta,
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

export interface ApiAgentAdapterOptions {
  modelRuntime: ModelRuntime;
  /** Optional role resolver for probe readiness when roleId is known at start only. */
  defaultRoleId?: string;
}

interface SessionState {
  session: RuntimeSession;
  sequencer: EventSequencer;
  controller?: AbortController;
  disposed: boolean;
}

const apiCapabilities: RuntimeCapabilities = {
  reasoning: true,
  images: false,
  tools: false,
  resume: true,
  workspace: false,
  network: true,
  structuredOutput: true
};

/**
 * API Agent harness adapter: model calls go through ModelRuntime (task 17).
 * Emits the same unified events as other harnesses so orchestration stays harness-agnostic.
 */
export class ApiAgentAdapter implements RuntimeAdapter {
  readonly harness = "api" as const;
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly options: ApiAgentAdapterOptions) {}

  capabilities(): RuntimeCapabilities {
    return { ...apiCapabilities };
  }

  async probe(): Promise<RuntimeProbeResult> {
    const roleId = this.options.defaultRoleId;
    if (!roleId) {
      return {
        ready: true,
        harness: this.harness,
        capabilities: this.capabilities(),
        reason: "API adapter is loaded; Role readiness is checked at start/send."
      };
    }
    try {
      const config = await this.options.modelRuntime.resolveConfig(roleId);
      if (!config.enabled) {
        return {
          ready: false,
          harness: this.harness,
          capabilities: this.capabilities(),
          reason: "Role 已停用。"
        };
      }
      if (!config.connectionId) {
        return {
          ready: false,
          harness: this.harness,
          capabilities: this.capabilities(),
          reason: "API Harness 需要模型连接。"
        };
      }
      return {
        ready: true,
        harness: this.harness,
        capabilities: this.capabilities(),
        details: {
          roleId: config.roleId,
          modelId: config.modelId,
          connectionId: config.connectionId
        }
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
      if (input.checkpointSummary) {
        existing.session.checkpointSummary = input.checkpointSummary;
      }
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
      disposed: false
    });
    return { ...session };
  }

  async *send(sessionId: string, input: RuntimeSendInput): AsyncIterable<RuntimeEvent> {
    const state = this.requireSession(sessionId);
    if (!state.session.roleId) {
      const fail = createFail(
        sessionId,
        state.sequencer.next(),
        normalizeRuntimeError(new Error("API Agent session requires a roleId."), "protocol_error")
      );
      state.session.status = "failed";
      yield fail;
      return;
    }

    const controller = new AbortController();
    state.controller = controller;
    const onOuterAbort = (): void => controller.abort();
    if (input.signal?.aborted) controller.abort();
    else input.signal?.addEventListener("abort", onOuterAbort, { once: true });

    state.session.status = "running";
    try {
      const messages = [];
      if (state.session.checkpointSummary) {
        messages.push({
          role: "user" as const,
          content: `Checkpoint summary for session rebuild:\n${state.session.checkpointSummary}`
        });
      }
      messages.push({ role: "user" as const, content: input.text });

      const result = await this.options.modelRuntime.invoke({
        roleId: state.session.roleId,
        messages,
        schema: input.jsonSchema,
        signal: controller.signal,
        timeoutMs: input.timeoutMs
      });

      if (controller.signal.aborted || input.signal?.aborted) {
        state.session.status = "cancelled";
        yield createInterrupt(sessionId, state.sequencer.next(), "用户取消了运行时会话。");
        return;
      }

      if (!result.ok) {
        const mapped = mapModelError(result.error.kind, result.error.message);
        state.session.status = result.error.kind === "cancelled" ? "cancelled" : "failed";
        if (result.error.kind === "cancelled") {
          yield createInterrupt(sessionId, state.sequencer.next(), mapped.message);
        } else {
          yield createFail(sessionId, state.sequencer.next(), mapped);
        }
        return;
      }

      const text = typeof result.parsed === "undefined" ? result.content : JSON.stringify(result.parsed);
      yield createTextDelta(sessionId, text, state.sequencer.next());
      if (result.usage) {
        yield createUsage(sessionId, state.sequencer.next(), result.usage);
      }
      state.session.status = "completed";
      yield createComplete(sessionId, state.sequencer.next(), "API Agent turn completed.");
    } catch (error) {
      if (controller.signal.aborted || input.signal?.aborted) {
        state.session.status = "cancelled";
        yield createInterrupt(sessionId, state.sequencer.next(), "用户取消了运行时会话。");
        return;
      }
      const normalized = normalizeRuntimeError(error);
      state.session.status = "failed";
      yield createFail(sessionId, state.sequencer.next(), normalized);
    } finally {
      input.signal?.removeEventListener("abort", onOuterAbort);
      if (state.controller === controller) state.controller = undefined;
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
    state.controller?.abort();
    state.session.status = "cancelled";
  }

  async dispose(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.controller?.abort();
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

function mapModelError(kind: string, message: string) {
  const map: Record<string, Parameters<typeof normalizeRuntimeError>[1]> = {
    authentication_failed: "authentication_failed",
    model_unavailable: "model_unavailable",
    network_failed: "network_failed",
    timeout: "timeout",
    cancelled: "user_cancel",
    format_error: "protocol_error",
    role_disabled: "protocol_error",
    connection_disabled: "authentication_failed",
    missing_connection: "protocol_error",
    harness_unsupported: "protocol_error",
    provider_error: "unknown"
  };
  return normalizeRuntimeError({ kind: map[kind] ?? "unknown", message }, map[kind] ?? "unknown");
}
