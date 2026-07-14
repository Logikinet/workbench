import { randomUUID } from "node:crypto";
import { redactJsonValue, redactSecrets } from "../model/redact.js";
import type {
  ApprovalEvent,
  ArtifactEvent,
  AskUserEvent,
  CompleteEvent,
  FailEvent,
  InterruptEvent,
  NormalizedRuntimeError,
  PersistedRuntimeEvent,
  RuntimeEvent,
  TextDeltaEvent,
  ToolRequestEvent,
  ToolResultEvent,
  UsageEvent
} from "./types.js";

/** Per-session monotonic sequence allocator. */
export class EventSequencer {
  private sequence = 0;

  next(): number {
    this.sequence += 1;
    return this.sequence;
  }

  peek(): number {
    return this.sequence;
  }
}

export function createTextDelta(sessionId: string, text: string, sequence: number): TextDeltaEvent {
  return base(sessionId, sequence, {
    kind: "text_delta",
    text: redactSecrets(text)
  });
}

export function createToolRequest(
  sessionId: string,
  sequence: number,
  input: { toolCallId: string; toolName: string; arguments: Record<string, unknown> }
): ToolRequestEvent {
  return base(sessionId, sequence, {
    kind: "tool_request",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    arguments: redactJsonValue(input.arguments)
  });
}

export function createToolResult(
  sessionId: string,
  sequence: number,
  input: { toolCallId: string; toolName: string; ok: boolean; resultSummary: string }
): ToolResultEvent {
  return base(sessionId, sequence, {
    kind: "tool_result",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ok: input.ok,
    resultSummary: redactSecrets(input.resultSummary)
  });
}

export function createAskUser(
  sessionId: string,
  sequence: number,
  input: { prompt: string; options?: string[] }
): AskUserEvent {
  return base(sessionId, sequence, {
    kind: "ask_user",
    prompt: redactSecrets(input.prompt),
    options: input.options?.map((option) => redactSecrets(option))
  });
}

export function createApproval(
  sessionId: string,
  sequence: number,
  input: { approvalKind: string; summary: string; status: ApprovalEvent["status"] }
): ApprovalEvent {
  return base(sessionId, sequence, {
    kind: "approval",
    approvalKind: input.approvalKind,
    summary: redactSecrets(input.summary),
    status: input.status
  });
}

export function createArtifact(
  sessionId: string,
  sequence: number,
  input: { path: string; artifactKind: string; summary?: string }
): ArtifactEvent {
  return base(sessionId, sequence, {
    kind: "artifact",
    path: input.path,
    artifactKind: input.artifactKind,
    summary: input.summary ? redactSecrets(input.summary) : undefined
  });
}

export function createUsage(
  sessionId: string,
  sequence: number,
  input: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
): UsageEvent {
  return base(sessionId, sequence, {
    kind: "usage",
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens: input.totalTokens
  });
}

export function createComplete(sessionId: string, sequence: number, summary: string): CompleteEvent {
  return base(sessionId, sequence, {
    kind: "complete",
    summary: redactSecrets(summary)
  });
}

export function createFail(sessionId: string, sequence: number, error: NormalizedRuntimeError): FailEvent {
  return base(sessionId, sequence, {
    kind: "fail",
    error: {
      ...error,
      message: redactSecrets(error.message)
    }
  });
}

export function createInterrupt(sessionId: string, sequence: number, reason: string): InterruptEvent {
  return base(sessionId, sequence, {
    kind: "interrupt",
    reason: redactSecrets(reason)
  });
}

/** Deep-redact an event for durable timeline / backup storage. */
export function persistEvent(event: RuntimeEvent): PersistedRuntimeEvent {
  return {
    event: redactJsonValue(event),
    redacted: true
  };
}

/** Restore a previously persisted event for UI display. */
export function restoreEvent(persisted: PersistedRuntimeEvent): RuntimeEvent {
  if (!persisted?.redacted || !persisted.event?.kind || !persisted.event.sessionId) {
    throw new Error("Persisted runtime event is not restorable.");
  }
  return structuredClone(persisted.event);
}

function base<T extends Omit<RuntimeEvent, "id" | "sessionId" | "timestamp" | "sequence">>(
  sessionId: string,
  sequence: number,
  partial: T
): T & { id: string; sessionId: string; timestamp: string; sequence: number } {
  return {
    id: randomUUID(),
    sessionId,
    timestamp: new Date().toISOString(),
    sequence,
    ...partial
  };
}
