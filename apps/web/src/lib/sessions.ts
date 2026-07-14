/**
 * Client for Agent Session + Tool Cards API (Task 41).
 */

import { createJsonRequest } from "./apiClient.js";

export type SessionStatus =
  | "idle"
  | "streaming"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "cancelled";

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

export type ToolCardStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "awaiting_approval";

export interface ToolCardPayload {
  toolCallId: string;
  toolName: string;
  title: string;
  argumentsSummary: string;
  arguments?: Record<string, unknown>;
  permission: string;
  status: ToolCardStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  outputSummary?: string;
  ok?: boolean;
  artifactLinks: Array<{ path: string; kind: string; summary?: string }>;
  evidenceLinks: Array<{ id: string; summary: string; path?: string }>;
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

export interface SessionCardRecord {
  id: string;
  sessionId: string;
  turnId: string;
  kind: SessionCardKind;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  collapsed: boolean;
  summary: string;
  text?: string;
  tool?: ToolCardPayload;
  ask?: AskCardPayload;
  acceptance?: AcceptanceCardPayload;
  artifact?: { path: string; kind: string; summary?: string };
  logBody?: string;
  logTruncated?: boolean;
}

export interface QueuedMessageRecord {
  id: string;
  content: string;
  createdAt: string;
  mode: "queue" | "correction";
}

export interface AgentSessionRecord {
  id: string;
  title: string;
  projectId?: string;
  agentRoleId?: string;
  agentName?: string;
  preferredModelId?: string;
  tags: string[];
  status: SessionStatus;
  runId?: string;
  todoId?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  searchText: string;
  nextSequence: number;
  cards: SessionCardRecord[];
  messageQueue: QueuedMessageRecord[];
  pendingInteractionCardIds: string[];
  activeTurnId?: string;
  cardCount: number;
}

export interface CardsPageRecord {
  sessionId: string;
  cards: SessionCardRecord[];
  total: number;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  nextSequence: number;
}

export interface CreateSessionBody {
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

export interface SessionListQuery {
  q?: string;
  tag?: string;
  projectId?: string;
  agentRoleId?: string;
  status?: SessionStatus;
}

export function createSessionClient(serviceUrl: string) {
  const requestJson = createJsonRequest(serviceUrl);

  return {
    list(query: SessionListQuery = {}) {
      const params = new URLSearchParams();
      if (query.q) params.set("q", query.q);
      if (query.tag) params.set("tag", query.tag);
      if (query.projectId) params.set("projectId", query.projectId);
      if (query.agentRoleId) params.set("agentRoleId", query.agentRoleId);
      if (query.status) params.set("status", query.status);
      const qs = params.toString();
      return requestJson<{ sessions: AgentSessionRecord[] }>(`/api/sessions${qs ? `?${qs}` : ""}`).then(
        (body) => body.sessions
      );
    },
    create(body: CreateSessionBody) {
      return requestJson<AgentSessionRecord>("/api/sessions", {
        method: "POST",
        body: JSON.stringify(body)
      });
    },
    get(sessionId: string) {
      return requestJson<AgentSessionRecord>(`/api/sessions/${encodeURIComponent(sessionId)}`);
    },
    update(
      sessionId: string,
      body: {
        title?: string;
        tags?: string[];
        preferredModelId?: string | null;
        agentRoleId?: string | null;
        agentName?: string | null;
        projectId?: string | null;
        status?: SessionStatus;
      }
    ) {
      return requestJson<AgentSessionRecord>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      });
    },
    remove(sessionId: string) {
      return requestJson<{ deleted: true; id: string }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE"
      });
    },
    clear(sessionId: string) {
      return requestJson<AgentSessionRecord>(`/api/sessions/${encodeURIComponent(sessionId)}/clear`, {
        method: "POST",
        body: "{}"
      });
    },
    cards(
      sessionId: string,
      query: { afterSequence?: number; beforeSequence?: number; limit?: number; compact?: boolean } = {}
    ) {
      const params = new URLSearchParams();
      if (query.afterSequence !== undefined) params.set("afterSequence", String(query.afterSequence));
      if (query.beforeSequence !== undefined) params.set("beforeSequence", String(query.beforeSequence));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.compact) params.set("compact", "true");
      const qs = params.toString();
      return requestJson<CardsPageRecord>(
        `/api/sessions/${encodeURIComponent(sessionId)}/cards${qs ? `?${qs}` : ""}`
      );
    },
    appendMessage(sessionId: string, content: string, mode?: "queue" | "correction" | "force") {
      return requestJson<AgentSessionRecord>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, mode })
      });
    },
    ingestEvents(sessionId: string, events: unknown[]) {
      return requestJson<AgentSessionRecord>(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: "POST",
        body: JSON.stringify({ events })
      });
    },
    drainQueue(sessionId: string) {
      return requestJson<{ session: AgentSessionRecord; drained: QueuedMessageRecord[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/queue/drain`,
        { method: "POST", body: "{}" }
      );
    },
    collapseCard(sessionId: string, cardId: string, collapsed = true) {
      return requestJson<AgentSessionRecord>(
        `/api/sessions/${encodeURIComponent(sessionId)}/cards/${encodeURIComponent(cardId)}/collapse`,
        { method: "POST", body: JSON.stringify({ collapsed }) }
      );
    },
    collapseTurn(sessionId: string, turnId: string, collapsed = true) {
      return requestJson<AgentSessionRecord>(
        `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/collapse`,
        { method: "POST", body: JSON.stringify({ collapsed }) }
      );
    },
    answer(
      sessionId: string,
      cardId: string,
      body: {
        selectedOptionIds?: string[];
        freeText?: string;
        approved?: boolean;
        decisionNote?: string;
      }
    ) {
      return requestJson<AgentSessionRecord>(
        `/api/sessions/${encodeURIComponent(sessionId)}/cards/${encodeURIComponent(cardId)}/answer`,
        { method: "POST", body: JSON.stringify(body) }
      );
    }
  };
}
