/**
 * Unified Agent Runtime Protocol types.
 * Orchestration consumes these events — never harness-private wire formats.
 */

export type RuntimeHarnessId = "api" | "codex-cli" | (string & {});

export interface RuntimeCapabilities {
  reasoning: boolean;
  images: boolean;
  tools: boolean;
  resume: boolean;
  workspace: boolean;
  network: boolean;
  structuredOutput: boolean;
}

export type NormalizedRuntimeErrorKind =
  | "authentication_failed"
  | "quota_exceeded"
  | "not_logged_in"
  | "timeout"
  | "process_exit"
  | "protocol_error"
  | "user_cancel"
  | "model_unavailable"
  | "network_failed"
  | "unknown";

export interface NormalizedRuntimeError {
  kind: NormalizedRuntimeErrorKind;
  /** Secret-free, user-facing message. */
  message: string;
  retryable: boolean;
  /** Optional exit code / HTTP status / harness code (never secrets). */
  code?: string | number;
}

export type RuntimeEventKind =
  | "text_delta"
  | "tool_request"
  | "tool_result"
  | "ask_user"
  | "approval"
  | "artifact"
  | "usage"
  | "complete"
  | "fail"
  | "interrupt";

interface RuntimeEventBase {
  id: string;
  sessionId: string;
  kind: RuntimeEventKind;
  timestamp: string;
  /** Opaque sequence for restore ordering. */
  sequence: number;
}

export interface TextDeltaEvent extends RuntimeEventBase {
  kind: "text_delta";
  text: string;
}

export interface ToolRequestEvent extends RuntimeEventBase {
  kind: "tool_request";
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultEvent extends RuntimeEventBase {
  kind: "tool_result";
  toolCallId: string;
  toolName: string;
  ok: boolean;
  resultSummary: string;
}

export interface AskUserEvent extends RuntimeEventBase {
  kind: "ask_user";
  prompt: string;
  options?: string[];
}

export interface ApprovalEvent extends RuntimeEventBase {
  kind: "approval";
  approvalKind: string;
  summary: string;
  status: "requested" | "approved" | "rejected";
}

export interface ArtifactEvent extends RuntimeEventBase {
  kind: "artifact";
  path: string;
  artifactKind: string;
  summary?: string;
}

export interface UsageEvent extends RuntimeEventBase {
  kind: "usage";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface CompleteEvent extends RuntimeEventBase {
  kind: "complete";
  summary: string;
}

export interface FailEvent extends RuntimeEventBase {
  kind: "fail";
  error: NormalizedRuntimeError;
}

export interface InterruptEvent extends RuntimeEventBase {
  kind: "interrupt";
  reason: string;
}

export type RuntimeEvent =
  | TextDeltaEvent
  | ToolRequestEvent
  | ToolResultEvent
  | AskUserEvent
  | ApprovalEvent
  | ArtifactEvent
  | UsageEvent
  | CompleteEvent
  | FailEvent
  | InterruptEvent;

export interface RuntimeSession {
  sessionId: string;
  harness: RuntimeHarnessId;
  roleId?: string;
  createdAt: string;
  /** Last checkpoint summary injected or produced for rebuild. */
  checkpointSummary?: string;
  status: "ready" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
}

export interface RuntimeProbeResult {
  ready: boolean;
  harness: RuntimeHarnessId;
  capabilities: RuntimeCapabilities;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeStartInput {
  roleId?: string;
  /** Stable session id to reuse; generated when omitted. */
  sessionId?: string;
  systemInstruction?: string;
  /** Optional workspace path when harness supports workspace. */
  workspacePath?: string;
  /** Checkpoint summary injected when rebuilding a session. */
  checkpointSummary?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSendInput {
  text: string;
  /** Structured output schema hint when capabilities.structuredOutput. */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RuntimeResumeInput {
  checkpointSummary?: string;
  metadata?: Record<string, unknown>;
}

/** Persistable, redacted event envelope for timeline restore. */
export interface PersistedRuntimeEvent {
  event: RuntimeEvent;
  redacted: true;
}
