import { persistEvent, restoreEvent } from "./events.js";
import type { RuntimeCapabilities, RuntimeEvent, RuntimeEventKind, NormalizedRuntimeErrorKind } from "./types.js";

/** Capability flags every adapter must declare (ticket 35). */
export const RUNTIME_CAPABILITY_KEYS = [
  "reasoning",
  "images",
  "tools",
  "resume",
  "workspace",
  "network",
  "structuredOutput"
] as const satisfies ReadonlyArray<keyof RuntimeCapabilities>;

/** Unified stream event kinds — orchestration must only consume these. */
export const RUNTIME_EVENT_KINDS = [
  "text_delta",
  "tool_request",
  "tool_result",
  "ask_user",
  "approval",
  "artifact",
  "usage",
  "complete",
  "fail",
  "interrupt"
] as const satisfies ReadonlyArray<RuntimeEventKind>;

export const RUNTIME_TERMINAL_EVENT_KINDS = ["complete", "fail", "interrupt"] as const satisfies ReadonlyArray<RuntimeEventKind>;

/** Normalized failure taxonomy every harness must map into. */
export const RUNTIME_ERROR_KINDS = [
  "authentication_failed",
  "quota_exceeded",
  "not_logged_in",
  "timeout",
  "process_exit",
  "protocol_error",
  "user_cancel",
  "model_unavailable",
  "network_failed",
  "unknown"
] as const satisfies ReadonlyArray<NormalizedRuntimeErrorKind>;

export function isTerminalRuntimeEvent(event: RuntimeEvent): boolean {
  return (RUNTIME_TERMINAL_EVENT_KINDS as readonly string[]).includes(event.kind);
}

export function isKnownRuntimeEventKind(kind: string): kind is RuntimeEventKind {
  return (RUNTIME_EVENT_KINDS as readonly string[]).includes(kind);
}

/**
 * Structural checks shared by the contract suite and future harness tests.
 * Throws when an event is not safe for orchestration consumption.
 */
export function assertRuntimeEventShape(event: RuntimeEvent): void {
  if (!event || typeof event !== "object") {
    throw new Error("RuntimeEvent must be an object.");
  }
  if (typeof event.id !== "string" || !event.id.trim()) {
    throw new Error("RuntimeEvent.id must be a non-empty string.");
  }
  if (typeof event.sessionId !== "string" || !event.sessionId.trim()) {
    throw new Error("RuntimeEvent.sessionId must be a non-empty string.");
  }
  if (!isKnownRuntimeEventKind(event.kind)) {
    throw new Error(`RuntimeEvent.kind is not a unified kind: ${String((event as { kind?: string }).kind)}`);
  }
  if (typeof event.timestamp !== "string" || Number.isNaN(Date.parse(event.timestamp))) {
    throw new Error("RuntimeEvent.timestamp must be an ISO date string.");
  }
  if (typeof event.sequence !== "number" || !Number.isFinite(event.sequence) || event.sequence < 1) {
    throw new Error("RuntimeEvent.sequence must be a finite number >= 1.");
  }
  if (event.kind === "fail") {
    if (!event.error || !(RUNTIME_ERROR_KINDS as readonly string[]).includes(event.error.kind)) {
      throw new Error("fail events must carry a normalized error kind.");
    }
    if (typeof event.error.message !== "string") {
      throw new Error("fail events must carry a string message.");
    }
  }
}

/** Sequences within one turn must be strictly increasing (restore ordering). */
export function assertMonotonicSequences(events: RuntimeEvent[]): void {
  for (let i = 1; i < events.length; i += 1) {
    if (events[i]!.sequence <= events[i - 1]!.sequence) {
      throw new Error(
        `RuntimeEvent sequences must be strictly increasing; saw ${events[i - 1]!.sequence} then ${events[i]!.sequence}.`
      );
    }
  }
}

/** Every event must survive redacted persist → restore for timeline display. */
export function assertEventsPersistable(events: RuntimeEvent[]): void {
  for (const event of events) {
    const persisted = persistEvent(event);
    if (persisted.redacted !== true) {
      throw new Error("persistEvent must mark redacted: true.");
    }
    const restored = restoreEvent(persisted);
    if (restored.kind !== event.kind || restored.sessionId !== event.sessionId || restored.sequence !== event.sequence) {
      throw new Error(`restoreEvent lost identity for kind=${event.kind}.`);
    }
  }
}

export function assertCapabilitiesShape(capabilities: RuntimeCapabilities): void {
  for (const key of RUNTIME_CAPABILITY_KEYS) {
    if (typeof capabilities[key] !== "boolean") {
      throw new Error(`RuntimeCapabilities.${key} must be a boolean.`);
    }
  }
}
