import { isTerminalRuntimeEvent } from "./contract.js";
import { persistEvent } from "./events.js";
import type { RuntimeAdapter } from "./adapter.js";
import type {
  PersistedRuntimeEvent,
  RuntimeEvent,
  RuntimeSendInput
} from "./types.js";

export interface RuntimeLogLine {
  level: "info" | "warn" | "error";
  message: string;
}

export interface RuntimeSendDrainResult {
  events: RuntimeEvent[];
  /** Concatenated text_delta payloads (secret-redacted at emission). */
  text: string;
  terminal?: RuntimeEvent;
  persisted: PersistedRuntimeEvent[];
}

/**
 * Map a unified RuntimeEvent into a secret-free Run log line.
 * Returns null for empty / uninteresting payloads.
 */
export function runtimeEventToLog(event: RuntimeEvent): RuntimeLogLine | null {
  switch (event.kind) {
    case "text_delta": {
      const text = event.text.trim();
      if (!text) return null;
      return { level: "info", message: `runtime:text_delta ${clip(text)}` };
    }
    case "tool_request":
      return {
        level: "info",
        message: `runtime:tool_request ${event.toolName} (${event.toolCallId})`
      };
    case "tool_result":
      return {
        level: event.ok ? "info" : "warn",
        message: `runtime:tool_result ${event.toolName} ${event.ok ? "ok" : "failed"}: ${clip(event.resultSummary)}`
      };
    case "ask_user":
      return { level: "info", message: `runtime:ask_user ${clip(event.prompt)}` };
    case "approval":
      return {
        level: "info",
        message: `runtime:approval ${event.approvalKind} ${event.status}: ${clip(event.summary)}`
      };
    case "artifact":
      return {
        level: "info",
        message: `runtime:artifact ${event.artifactKind} ${event.path}${event.summary ? ` — ${clip(event.summary)}` : ""}`
      };
    case "usage": {
      const parts = [
        event.promptTokens !== undefined ? `prompt=${event.promptTokens}` : "",
        event.completionTokens !== undefined ? `completion=${event.completionTokens}` : "",
        event.totalTokens !== undefined ? `total=${event.totalTokens}` : ""
      ].filter(Boolean);
      if (parts.length === 0) return null;
      return { level: "info", message: `runtime:usage ${parts.join(" ")}` };
    }
    case "complete":
      return { level: "info", message: `runtime:complete ${clip(event.summary)}` };
    case "fail":
      return {
        level: "error",
        message: `runtime:fail [${event.error.kind}] ${clip(event.error.message)}`
      };
    case "interrupt":
      return { level: "warn", message: `runtime:interrupt ${clip(event.reason)}` };
    default:
      return null;
  }
}

/**
 * Drain a RuntimeAdapter.send stream into ordered events + terminal outcome.
 * Orchestration should only inspect RuntimeEvent fields — never harness-private formats.
 */
export async function drainRuntimeSend(
  adapter: RuntimeAdapter,
  sessionId: string,
  input: RuntimeSendInput
): Promise<RuntimeSendDrainResult> {
  const events: RuntimeEvent[] = [];
  const persisted: PersistedRuntimeEvent[] = [];
  let text = "";
  let terminal: RuntimeEvent | undefined;

  for await (const event of adapter.send(sessionId, input)) {
    events.push(event);
    persisted.push(persistEvent(event));
    if (event.kind === "text_delta") text += event.text;
    if (isTerminalRuntimeEvent(event)) terminal = event;
  }

  return { events, text, terminal, persisted };
}

/**
 * Prefer an injected RuntimeAdapter when present; otherwise return undefined so
 * callers keep their legacy harness path (backward compatible).
 */
export function preferRuntimeAdapter(
  adapter: RuntimeAdapter | undefined | null
): RuntimeAdapter | undefined {
  return adapter ?? undefined;
}

function clip(value: string, max = 300): string {
  return value.replace(/\s+/g, " ").slice(0, max);
}
