/**
 * Agent Session + structured Tool Cards (Task 41).
 *
 * Event shapes inspired by Agent Client Protocol (ACP) session/update + ToolCall
 * and the local RuntimeEvent protocol (Task 35) — not a wire-for-wire copy.
 *
 * Sessions upgrade the Todo/Run timeline into a searchable, filterable chat with
 * ordered cards (text, tool call/result, AskUser/Approval/Replan, acceptance).
 */

/** High-level session execution state (survives restart). */
export type SessionStatus =
  | "idle"
  | "streaming"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "cancelled";

/** Card kinds that make up an ordered agent turn timeline. */
export type SessionCardKind =
  | "user_message"
  | "agent_text"
  | "tool_call"
  | "ask_user"
  | "ask_approval"
  | "ask_replan"
  | "acceptance"
  | "artifact"
  | "system"
  | "queued_message";

/**
 * Tool-call lifecycle aligned with ACP ToolCallStatus
 * (pending → in_progress → completed | failed) plus local awaiting_approval.
 */
export type ToolCardStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "awaiting_approval";

/** Permission category shown on a Tool Card (mirrors Tool Registry). */
export type ToolCardPermission =
  | "readonly"
  | "write"
  | "shell"
  | "network"
  | "dangerous"
  | "unknown";

export interface ArtifactLink {
  path: string;
  kind: string;
  summary?: string;
}

export interface EvidenceLink {
  id: string;
  summary: string;
  path?: string;
}

/** Structured Tool Card payload (ACP-inspired: toolCallId, title, status, kind). */
export interface ToolCardPayload {
  toolCallId: string;
  toolName: string;
  /** Human-readable title for the call. */
  title: string;
  /** Redacted / truncated argument summary for list view. */
  argumentsSummary: string;
  /** Redacted arguments (full form when available). */
  arguments?: Record<string, unknown>;
  permission: ToolCardPermission;
  status: ToolCardStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Compact output for UI (secrets redacted). */
  outputSummary?: string;
  ok?: boolean;
  artifactLinks: ArtifactLink[];
  evidenceLinks: EvidenceLink[];
}

export interface AskCardPayload {
  requestId: string;
  prompt: string;
  reason?: string;
  options?: Array<{ id: string; label: string }>;
  status: "pending" | "answered" | "cancelled" | "superseded";
  recommendedAnswer?: string;
  answerSummary?: string;
  answeredAt?: string;
}

export interface AcceptanceCardPayload {
  status: "pending" | "accepted" | "rejected";
  summary: string;
  criteria?: string[];
  decidedAt?: string;
  decisionNote?: string;
}

export interface SessionCard {
  id: string;
  sessionId: string;
  /** Groups cards that belong to one agent turn. */
  turnId: string;
  kind: SessionCardKind;
  /** Monotonic per-session sequence for restore ordering. */
  sequence: number;
  createdAt: string;
  updatedAt: string;
  /** When true, UI should show only summary until expanded. */
  collapsed: boolean;
  /** Short searchable / virtualized list summary. */
  summary: string;
  /** Full text body (agent_text / user_message / system). */
  text?: string;
  tool?: ToolCardPayload;
  ask?: AskCardPayload;
  acceptance?: AcceptanceCardPayload;
  artifact?: ArtifactLink;
  /** Optional log bulk for long output (loaded on demand when present). */
  logBody?: string;
  /** True when logBody was truncated at write time. */
  logTruncated?: boolean;
}

export interface QueuedMessage {
  id: string;
  content: string;
  createdAt: string;
  /** "queue" waits until streaming ends; "correction" is tagged for mid-run steering. */
  mode: "queue" | "correction";
}

export interface AgentSession {
  id: string;
  title: string;
  projectId?: string;
  /** Preferred agent role for this session only — never mutates global Role config. */
  agentRoleId?: string;
  agentName?: string;
  /** Preferred model for this session only — never mutates global Role config. */
  preferredModelId?: string;
  tags: string[];
  status: SessionStatus;
  runId?: string;
  todoId?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  /** Concatenated searchable text (title, tags, card summaries). */
  searchText: string;
  /** Next sequence number for cards. */
  nextSequence: number;
  cards: SessionCard[];
  /** User input queued while status === streaming. */
  messageQueue: QueuedMessage[];
  /** Card ids still awaiting answer (ask_* / acceptance). */
  pendingInteractionCardIds: string[];
  activeTurnId?: string;
  cardCount: number;
}

export interface SessionStateFile {
  schemaVersion: 1;
  sessions: AgentSession[];
}

export interface CreateSessionInput {
  title?: string;
  projectId?: string;
  agentRoleId?: string;
  agentName?: string;
  preferredModelId?: string;
  tags?: string[];
  runId?: string;
  todoId?: string;
  initialMessage?: string;
}

export interface UpdateSessionInput {
  title?: string;
  tags?: string[];
  projectId?: string | null;
  agentRoleId?: string | null;
  agentName?: string | null;
  preferredModelId?: string | null;
  runId?: string | null;
  todoId?: string | null;
  status?: SessionStatus;
}

export interface SessionListFilter {
  q?: string;
  tag?: string;
  projectId?: string;
  agentRoleId?: string;
  status?: SessionStatus;
}

export interface CardsPageQuery {
  /** Exclusive lower bound on sequence (for "load newer"). */
  afterSequence?: number;
  /** Exclusive upper bound on sequence (for "load older" virtualization). */
  beforeSequence?: number;
  /** Max cards to return (default 50, max 200). */
  limit?: number;
  /**
   * When true, strip logBody / full text from oversized cards and mark collapsed
   * for virtualized PWA views.
   */
  compact?: boolean;
}

export interface CardsPage {
  sessionId: string;
  cards: SessionCard[];
  total: number;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  nextSequence: number;
}

export interface AppendMessageInput {
  content: string;
  /**
   * When session is streaming:
   * - queue (default): hold until stream ends
   * - correction: enqueue as mid-run steering note
   * - force: append as active user_message even while streaming
   */
  mode?: "queue" | "correction" | "force";
}

export interface AnswerInteractionInput {
  selectedOptionIds?: string[];
  freeText?: string;
  approved?: boolean;
  decisionNote?: string;
}

/**
 * Runtime / ACP-inspired events the session service can fold into cards.
 * Aligns with RuntimeEventKind + ACP sessionUpdate tool_call / tool_call_update.
 */
export type SessionIngestEvent =
  | {
      kind: "text_delta";
      text: string;
      turnId?: string;
    }
  | {
      kind: "tool_request";
      toolCallId: string;
      toolName: string;
      arguments?: Record<string, unknown>;
      permission?: ToolCardPermission;
      title?: string;
      turnId?: string;
    }
  | {
      kind: "tool_result";
      toolCallId: string;
      toolName?: string;
      ok: boolean;
      resultSummary: string;
      durationMs?: number;
      artifacts?: ArtifactLink[];
      evidence?: EvidenceLink[];
      turnId?: string;
    }
  | {
      kind: "tool_update";
      toolCallId: string;
      status?: ToolCardStatus;
      outputSummary?: string;
      title?: string;
      turnId?: string;
    }
  | {
      kind: "ask_user";
      prompt: string;
      reason?: string;
      options?: Array<{ id?: string; label: string }>;
      requestId?: string;
      turnId?: string;
    }
  | {
      kind: "ask_approval";
      summary: string;
      approvalKind?: string;
      requestId?: string;
      turnId?: string;
    }
  | {
      kind: "ask_replan";
      prompt: string;
      reason?: string;
      requestId?: string;
      turnId?: string;
    }
  | {
      kind: "artifact";
      path: string;
      artifactKind: string;
      summary?: string;
      turnId?: string;
    }
  | {
      kind: "acceptance";
      summary: string;
      criteria?: string[];
      turnId?: string;
    }
  | {
      kind: "complete";
      summary: string;
      turnId?: string;
    }
  | {
      kind: "fail";
      message: string;
      turnId?: string;
    }
  | {
      kind: "interrupt";
      reason: string;
      turnId?: string;
    }
  | {
      kind: "stream_start";
      turnId?: string;
    }
  | {
      kind: "stream_end";
      turnId?: string;
    };

export const SESSION_STATUSES: readonly SessionStatus[] = [
  "idle",
  "streaming",
  "waiting_for_user",
  "completed",
  "failed",
  "cancelled"
] as const;

export const SESSION_CARD_KINDS: readonly SessionCardKind[] = [
  "user_message",
  "agent_text",
  "tool_call",
  "ask_user",
  "ask_approval",
  "ask_replan",
  "acceptance",
  "artifact",
  "system",
  "queued_message"
] as const;

/** Default page size for virtualized card loading. */
export const DEFAULT_CARDS_PAGE_LIMIT = 50;
export const MAX_CARDS_PAGE_LIMIT = 200;
/** Collapse / compact threshold for long log bodies (chars). */
export const LONG_LOG_COLLAPSE_CHARS = 2_000;
/** Hard cap stored on a single log body (chars). */
export const MAX_LOG_BODY_CHARS = 32_000;
/** Max argument summary length on tool cards. */
export const MAX_ARGS_SUMMARY_CHARS = 240;
/** Max output summary length on tool cards. */
export const MAX_OUTPUT_SUMMARY_CHARS = 480;
