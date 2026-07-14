/**
 * Durable Agent Session management + structured Tool Cards (Task 41).
 *
 * - Search / tags / Project / Agent / status filters
 * - Ordered turn cards (text, tool, ask_*, acceptance)
 * - Message queue while streaming (queue | correction)
 * - Session-level preferred model + tags (never mutates global Role)
 * - Paginated / compact card pages for PWA virtualization
 * - Full restore of card order, pending asks, and execution status after restart
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { redactSecrets } from "../model/redact.js";
import {
  applyToolResult,
  applyToolUpdate,
  compactCard,
  createToolCardPayload,
  maybeTruncateLogBody,
  toolCardSummary
} from "./toolCards.js";
import {
  DEFAULT_CARDS_PAGE_LIMIT,
  MAX_CARDS_PAGE_LIMIT,
  SESSION_STATUSES,
  type AgentSession,
  type AnswerInteractionInput,
  type AppendMessageInput,
  type CardsPage,
  type CardsPageQuery,
  type CreateSessionInput,
  type QueuedMessage,
  type SessionCard,
  type SessionIngestEvent,
  type SessionListFilter,
  type SessionStateFile,
  type SessionStatus,
  type UpdateSessionInput
} from "./sessionTypes.js";

export interface SessionServiceOptions {
  now?: () => Date;
}

function emptyState(): SessionStateFile {
  return { schemaVersion: 1, sessions: [] };
}

function isStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

export class SessionService {
  private readonly now: () => Date;

  private constructor(
    private readonly statePath: string | undefined,
    private state: SessionStateFile,
    options: SessionServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  static async open(statePath: string, options: SessionServiceOptions = {}): Promise<SessionService> {
    try {
      const decoded = JSON.parse(await readFile(statePath, "utf8")) as Partial<SessionStateFile>;
      if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.sessions)) {
        throw new Error("Session state is not compatible with this service version.");
      }
      return new SessionService(
        statePath,
        { schemaVersion: 1, sessions: decoded.sessions.map(normalizeSession) },
        options
      );
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return new SessionService(statePath, emptyState(), options);
      }
      throw error;
    }
  }

  /** In-memory factory for unit tests. */
  static async createMemory(options: SessionServiceOptions = {}): Promise<SessionService> {
    return new SessionService(undefined, emptyState(), options);
  }

  list(filter: SessionListFilter = {}): AgentSession[] {
    const q = filter.q?.trim().toLowerCase();
    const tag = filter.tag?.trim().toLowerCase();
    return this.state.sessions
      .filter((session) => {
        if (filter.projectId && session.projectId !== filter.projectId) return false;
        if (filter.agentRoleId && session.agentRoleId !== filter.agentRoleId) return false;
        if (filter.status && session.status !== filter.status) return false;
        if (tag && !session.tags.some((entry) => entry.toLowerCase() === tag)) return false;
        if (q) {
          const hay = session.searchText.toLowerCase();
          if (!hay.includes(q) && !session.title.toLowerCase().includes(q)) return false;
        }
        return true;
      })
      .slice()
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map((session) => this.toPublic(session));
  }

  get(sessionId: string): AgentSession {
    return this.toPublic(this.require(sessionId));
  }

  async create(input: CreateSessionInput = {}): Promise<AgentSession> {
    const timestamp = this.iso();
    const id = randomUUID();
    const tags = normalizeTags(input.tags);
    const session: AgentSession = {
      id,
      title: input.title?.trim() || "新会话",
      projectId: trimOrUndefined(input.projectId),
      agentRoleId: trimOrUndefined(input.agentRoleId),
      agentName: trimOrUndefined(input.agentName),
      preferredModelId: trimOrUndefined(input.preferredModelId),
      tags,
      status: "idle",
      runId: trimOrUndefined(input.runId),
      todoId: trimOrUndefined(input.todoId),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      searchText: "",
      nextSequence: 1,
      cards: [],
      messageQueue: [],
      pendingInteractionCardIds: [],
      cardCount: 0
    };

    if (input.initialMessage?.trim()) {
      this.appendUserMessageUnsafe(session, input.initialMessage.trim(), timestamp);
    }
    this.rebuildSearchText(session);
    this.state.sessions.unshift(session);
    await this.persist();
    return this.toPublic(session);
  }

  async update(sessionId: string, input: UpdateSessionInput): Promise<AgentSession> {
    const session = this.require(sessionId);
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new Error("Session title cannot be empty.");
      session.title = title;
    }
    if (input.tags !== undefined) session.tags = normalizeTags(input.tags);
    if (input.projectId !== undefined) {
      session.projectId = input.projectId === null ? undefined : trimOrUndefined(input.projectId);
    }
    if (input.agentRoleId !== undefined) {
      session.agentRoleId = input.agentRoleId === null ? undefined : trimOrUndefined(input.agentRoleId);
    }
    if (input.agentName !== undefined) {
      session.agentName = input.agentName === null ? undefined : trimOrUndefined(input.agentName);
    }
    if (input.preferredModelId !== undefined) {
      session.preferredModelId =
        input.preferredModelId === null ? undefined : trimOrUndefined(input.preferredModelId);
    }
    if (input.runId !== undefined) {
      session.runId = input.runId === null ? undefined : trimOrUndefined(input.runId);
    }
    if (input.todoId !== undefined) {
      session.todoId = input.todoId === null ? undefined : trimOrUndefined(input.todoId);
    }
    if (input.status !== undefined) {
      if (!isStatus(input.status)) throw new Error("Invalid session status.");
      session.status = input.status;
    }
    this.touch(session);
    this.rebuildSearchText(session);
    await this.persist();
    return this.toPublic(session);
  }

  async delete(sessionId: string): Promise<{ deleted: true; id: string }> {
    const index = this.state.sessions.findIndex((entry) => entry.id === sessionId);
    if (index < 0) throw notFound(sessionId);
    this.state.sessions.splice(index, 1);
    await this.persist();
    return { deleted: true, id: sessionId };
  }

  /** Clear all cards / queue / pending interactions; keep metadata. */
  async clear(sessionId: string): Promise<AgentSession> {
    const session = this.require(sessionId);
    session.cards = [];
    session.messageQueue = [];
    session.pendingInteractionCardIds = [];
    session.activeTurnId = undefined;
    session.nextSequence = 1;
    session.cardCount = 0;
    session.status = "idle";
    this.touch(session);
    this.rebuildSearchText(session);
    await this.persist();
    return this.toPublic(session);
  }

  /** Paginated cards for virtualized timeline. */
  getCards(sessionId: string, query: CardsPageQuery = {}): CardsPage {
    const session = this.require(sessionId);
    const limit = clampLimit(query.limit);
    let cards = session.cards.slice();

    if (query.afterSequence !== undefined) {
      cards = cards.filter((card) => card.sequence > query.afterSequence!);
    }
    if (query.beforeSequence !== undefined) {
      cards = cards.filter((card) => card.sequence < query.beforeSequence!);
    }

    // Prefer newest page when loading from the end without bounds.
    const fromEnd = query.afterSequence === undefined && query.beforeSequence === undefined;
    if (fromEnd && cards.length > limit) {
      cards = cards.slice(cards.length - limit);
    } else if (query.beforeSequence !== undefined && cards.length > limit) {
      // Load older: take the highest sequences still below beforeSequence, limited.
      cards = cards.slice(Math.max(0, cards.length - limit));
    } else if (query.afterSequence !== undefined && cards.length > limit) {
      cards = cards.slice(0, limit);
    }

    const firstSeq = cards[0]?.sequence;
    const lastSeq = cards[cards.length - 1]?.sequence;
    const hasMoreOlder =
      firstSeq !== undefined && session.cards.some((card) => card.sequence < firstSeq);
    const hasMoreNewer =
      lastSeq !== undefined && session.cards.some((card) => card.sequence > lastSeq);

    const mapped = query.compact ? cards.map(compactCard) : cards.map((card) => structuredClone(card));
    return {
      sessionId: session.id,
      cards: mapped,
      total: session.cards.length,
      hasMoreOlder,
      hasMoreNewer,
      nextSequence: session.nextSequence
    };
  }

  async appendMessage(sessionId: string, input: AppendMessageInput): Promise<AgentSession> {
    const content = input.content?.trim();
    if (!content) throw new Error("Message content is required.");
    const session = this.require(sessionId);
    const timestamp = this.iso();
    const mode = input.mode ?? "queue";

    if (session.status === "streaming" && mode !== "force") {
      const queued: QueuedMessage = {
        id: randomUUID(),
        content: redactSecrets(content),
        createdAt: timestamp,
        mode: mode === "correction" ? "correction" : "queue"
      };
      session.messageQueue.push(queued);
      // Surface a lightweight queued_message card so the timeline shows pending input.
      this.pushCard(session, {
        kind: "queued_message",
        turnId: session.activeTurnId ?? this.ensureTurn(session, timestamp),
        summary: mode === "correction" ? `纠偏排队：${truncate(content, 120)}` : `排队：${truncate(content, 120)}`,
        text: redactSecrets(content),
        collapsed: false,
        timestamp
      });
      this.touch(session);
      this.rebuildSearchText(session);
      await this.persist();
      return this.toPublic(session);
    }

    this.appendUserMessageUnsafe(session, content, timestamp);
    this.touch(session);
    this.rebuildSearchText(session);
    await this.persist();
    return this.toPublic(session);
  }

  /**
   * Drain the message queue into user_message cards (call after stream ends).
   * Returns drained messages for orchestration hosts.
   */
  async drainMessageQueue(sessionId: string): Promise<{ session: AgentSession; drained: QueuedMessage[] }> {
    const session = this.require(sessionId);
    const drained = session.messageQueue.slice();
    session.messageQueue = [];
    // Remove queued_message placeholder cards matching drained ids by content/time is fragile;
    // leave history as-is and append real user messages.
    const timestamp = this.iso();
    for (const item of drained) {
      this.appendUserMessageUnsafe(session, item.content, timestamp, item.mode === "correction");
    }
    this.touch(session);
    this.rebuildSearchText(session);
    await this.persist();
    return { session: this.toPublic(session), drained };
  }

  /** Ingest runtime / ACP-inspired events into ordered cards. */
  async ingestEvents(sessionId: string, events: SessionIngestEvent[]): Promise<AgentSession> {
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error("At least one event is required.");
    }
    const session = this.require(sessionId);
    for (const event of events) {
      this.ingestOne(session, event);
    }
    this.touch(session);
    this.rebuildSearchText(session);
    await this.persist();
    return this.toPublic(session);
  }

  async setCardCollapsed(sessionId: string, cardId: string, collapsed: boolean): Promise<AgentSession> {
    const session = this.require(sessionId);
    const card = session.cards.find((entry) => entry.id === cardId);
    if (!card) throw new Error(`Card not found: ${cardId}`);
    card.collapsed = collapsed;
    card.updatedAt = this.iso();
    this.touch(session);
    await this.persist();
    return this.toPublic(session);
  }

  async collapseTurn(sessionId: string, turnId: string, collapsed: boolean): Promise<AgentSession> {
    const session = this.require(sessionId);
    const timestamp = this.iso();
    let found = false;
    for (const card of session.cards) {
      if (card.turnId === turnId) {
        card.collapsed = collapsed;
        card.updatedAt = timestamp;
        found = true;
      }
    }
    if (!found) throw new Error(`Turn not found: ${turnId}`);
    this.touch(session);
    await this.persist();
    return this.toPublic(session);
  }

  /** Answer AskUser / AskApproval / AskReplan / acceptance embedded in the timeline. */
  async answerInteraction(
    sessionId: string,
    cardId: string,
    input: AnswerInteractionInput
  ): Promise<AgentSession> {
    const session = this.require(sessionId);
    const card = session.cards.find((entry) => entry.id === cardId);
    if (!card) throw new Error(`Card not found: ${cardId}`);
    const timestamp = this.iso();

    if (card.kind === "acceptance" && card.acceptance) {
      if (card.acceptance.status !== "pending") {
        throw new Error("Acceptance card is not pending.");
      }
      const approved = input.approved === true;
      card.acceptance = {
        ...card.acceptance,
        status: approved ? "accepted" : "rejected",
        decidedAt: timestamp,
        decisionNote: input.decisionNote ? redactSecrets(input.decisionNote) : undefined
      };
      card.summary = approved ? `已验收：${card.acceptance.summary}` : `已拒绝验收：${card.acceptance.summary}`;
      card.updatedAt = timestamp;
    } else if (card.ask && (card.kind === "ask_user" || card.kind === "ask_approval" || card.kind === "ask_replan")) {
      if (card.ask.status !== "pending") {
        throw new Error("Interaction card is not pending.");
      }
      const parts: string[] = [];
      if (input.approved !== undefined) parts.push(input.approved ? "批准" : "拒绝");
      if (input.selectedOptionIds?.length) parts.push(`选项 ${input.selectedOptionIds.join(", ")}`);
      if (input.freeText?.trim()) parts.push(redactSecrets(input.freeText.trim()));
      if (input.decisionNote?.trim()) parts.push(redactSecrets(input.decisionNote.trim()));
      card.ask = {
        ...card.ask,
        status: "answered",
        answeredAt: timestamp,
        answerSummary: parts.join(" · ") || "已回答"
      };
      card.summary = `${card.kind}: ${card.ask.answerSummary}`;
      card.updatedAt = timestamp;
    } else {
      throw new Error("Card does not accept an interaction answer.");
    }

    session.pendingInteractionCardIds = session.pendingInteractionCardIds.filter((id) => id !== cardId);
    if (session.pendingInteractionCardIds.length === 0 && session.status === "waiting_for_user") {
      session.status = "idle";
    }
    this.touch(session);
    this.rebuildSearchText(session);
    await this.persist();
    return this.toPublic(session);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private ingestOne(session: AgentSession, event: SessionIngestEvent): void {
    const timestamp = this.iso();
    const turnId = event.turnId?.trim() || this.ensureTurn(session, timestamp);

    switch (event.kind) {
      case "stream_start": {
        session.status = "streaming";
        session.activeTurnId = turnId;
        return;
      }
      case "stream_end": {
        if (session.pendingInteractionCardIds.length > 0) {
          session.status = "waiting_for_user";
        } else if (session.status === "streaming") {
          session.status = "idle";
        }
        return;
      }
      case "text_delta": {
        const text = redactSecrets(event.text ?? "");
        if (!text) return;
        const last = [...session.cards].reverse().find(
          (card) => card.kind === "agent_text" && card.turnId === turnId
        );
        if (last) {
          last.text = `${last.text ?? ""}${text}`;
          last.summary = truncate(last.text, 160);
          last.updatedAt = timestamp;
          const log = maybeTruncateLogBody(last.text);
          if (log.collapsed) {
            last.collapsed = true;
            last.logBody = log.body;
            last.logTruncated = log.truncated;
          }
        } else {
          const log = maybeTruncateLogBody(text);
          this.pushCard(session, {
            kind: "agent_text",
            turnId,
            summary: truncate(text, 160),
            text,
            collapsed: log.collapsed,
            logBody: log.collapsed ? log.body : undefined,
            logTruncated: log.truncated,
            timestamp
          });
        }
        if (session.status === "idle" || session.status === "completed") {
          session.status = "streaming";
        }
        session.activeTurnId = turnId;
        return;
      }
      case "tool_request": {
        const payload = createToolCardPayload({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.arguments,
          permission: event.permission,
          title: event.title,
          status: "in_progress",
          startedAt: timestamp
        });
        this.pushCard(session, {
          kind: "tool_call",
          turnId,
          summary: toolCardSummary(payload),
          tool: payload,
          collapsed: false,
          timestamp
        });
        session.status = "streaming";
        session.activeTurnId = turnId;
        return;
      }
      case "tool_result": {
        const existing = this.findToolCard(session, event.toolCallId);
        if (existing?.tool) {
          existing.tool = applyToolResult(existing.tool, {
            ok: event.ok,
            resultSummary: event.resultSummary,
            durationMs: event.durationMs,
            completedAt: timestamp,
            artifacts: event.artifacts,
            evidence: event.evidence
          });
          existing.summary = toolCardSummary(existing.tool);
          existing.updatedAt = timestamp;
        } else {
          const payload = applyToolResult(
            createToolCardPayload({
              toolCallId: event.toolCallId,
              toolName: event.toolName ?? "unknown",
              startedAt: timestamp
            }),
            {
              ok: event.ok,
              resultSummary: event.resultSummary,
              durationMs: event.durationMs,
              completedAt: timestamp,
              artifacts: event.artifacts,
              evidence: event.evidence
            }
          );
          this.pushCard(session, {
            kind: "tool_call",
            turnId,
            summary: toolCardSummary(payload),
            tool: payload,
            collapsed: false,
            timestamp
          });
        }
        return;
      }
      case "tool_update": {
        const existing = this.findToolCard(session, event.toolCallId);
        if (!existing?.tool) return;
        existing.tool = applyToolUpdate(existing.tool, {
          status: event.status,
          outputSummary: event.outputSummary,
          title: event.title
        });
        existing.summary = toolCardSummary(existing.tool);
        existing.updatedAt = timestamp;
        return;
      }
      case "ask_user": {
        this.pushAsk(session, {
          kind: "ask_user",
          turnId,
          prompt: event.prompt,
          reason: event.reason,
          options: event.options,
          requestId: event.requestId,
          timestamp
        });
        return;
      }
      case "ask_approval": {
        this.pushAsk(session, {
          kind: "ask_approval",
          turnId,
          prompt: event.summary,
          reason: event.approvalKind,
          requestId: event.requestId,
          timestamp
        });
        return;
      }
      case "ask_replan": {
        this.pushAsk(session, {
          kind: "ask_replan",
          turnId,
          prompt: event.prompt,
          reason: event.reason,
          requestId: event.requestId,
          timestamp
        });
        return;
      }
      case "artifact": {
        const artifact = {
          path: event.path,
          kind: event.artifactKind,
          summary: event.summary ? redactSecrets(event.summary) : undefined
        };
        this.pushCard(session, {
          kind: "artifact",
          turnId,
          summary: `Artifact: ${artifact.path}`,
          artifact,
          collapsed: false,
          timestamp
        });
        // Attach to last tool card in turn when possible.
        const lastTool = [...session.cards]
          .reverse()
          .find((card) => card.kind === "tool_call" && card.turnId === turnId && card.tool);
        if (lastTool?.tool) {
          lastTool.tool.artifactLinks = [
            ...lastTool.tool.artifactLinks.filter((entry) => entry.path !== artifact.path),
            artifact
          ];
          lastTool.summary = toolCardSummary(lastTool.tool);
          lastTool.updatedAt = timestamp;
        }
        return;
      }
      case "acceptance": {
        const card = this.pushCard(session, {
          kind: "acceptance",
          turnId,
          summary: `待验收：${redactSecrets(event.summary)}`,
          acceptance: {
            status: "pending",
            summary: redactSecrets(event.summary),
            criteria: event.criteria?.map((entry) => redactSecrets(entry))
          },
          collapsed: false,
          timestamp
        });
        session.pendingInteractionCardIds.push(card.id);
        session.status = "waiting_for_user";
        return;
      }
      case "complete": {
        this.pushCard(session, {
          kind: "system",
          turnId,
          summary: redactSecrets(event.summary),
          text: redactSecrets(event.summary),
          collapsed: false,
          timestamp
        });
        if (session.pendingInteractionCardIds.length === 0) {
          session.status = "completed";
        }
        return;
      }
      case "fail": {
        this.pushCard(session, {
          kind: "system",
          turnId,
          summary: `失败：${redactSecrets(event.message)}`,
          text: redactSecrets(event.message),
          collapsed: false,
          timestamp
        });
        session.status = "failed";
        return;
      }
      case "interrupt": {
        this.pushCard(session, {
          kind: "system",
          turnId,
          summary: `中断：${redactSecrets(event.reason)}`,
          text: redactSecrets(event.reason),
          collapsed: false,
          timestamp
        });
        session.status = "cancelled";
        return;
      }
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }

  private pushAsk(
    session: AgentSession,
    input: {
      kind: "ask_user" | "ask_approval" | "ask_replan";
      turnId: string;
      prompt: string;
      reason?: string;
      options?: Array<{ id?: string; label: string }>;
      requestId?: string;
      timestamp: string;
    }
  ): SessionCard {
    const options = input.options
      ?.filter((entry) => entry && typeof entry.label === "string")
      .map((entry, index) => ({
        id: entry.id?.trim() || `opt-${index + 1}`,
        label: redactSecrets(entry.label)
      }));
    const card = this.pushCard(session, {
      kind: input.kind,
      turnId: input.turnId,
      summary: `${input.kind}: ${truncate(input.prompt, 120)}`,
      ask: {
        requestId: input.requestId?.trim() || randomUUID(),
        prompt: redactSecrets(input.prompt),
        reason: input.reason ? redactSecrets(input.reason) : undefined,
        options,
        status: "pending"
      },
      collapsed: false,
      timestamp: input.timestamp
    });
    session.pendingInteractionCardIds.push(card.id);
    session.status = "waiting_for_user";
    return card;
  }

  private appendUserMessageUnsafe(
    session: AgentSession,
    content: string,
    timestamp: string,
    correction = false
  ): void {
    const turnId = randomUUID();
    session.activeTurnId = turnId;
    const text = redactSecrets(content);
    this.pushCard(session, {
      kind: "user_message",
      turnId,
      summary: correction ? `纠偏：${truncate(text, 120)}` : truncate(text, 120),
      text,
      collapsed: false,
      timestamp
    });
    if (!session.title || session.title === "新会话") {
      session.title = truncate(text, 48) || session.title;
    }
  }

  private pushCard(
    session: AgentSession,
    input: {
      kind: SessionCard["kind"];
      turnId: string;
      summary: string;
      text?: string;
      tool?: SessionCard["tool"];
      ask?: SessionCard["ask"];
      acceptance?: SessionCard["acceptance"];
      artifact?: SessionCard["artifact"];
      collapsed: boolean;
      logBody?: string;
      logTruncated?: boolean;
      timestamp: string;
    }
  ): SessionCard {
    const card: SessionCard = {
      id: randomUUID(),
      sessionId: session.id,
      turnId: input.turnId,
      kind: input.kind,
      sequence: session.nextSequence,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
      collapsed: input.collapsed,
      summary: input.summary,
      text: input.text,
      tool: input.tool,
      ask: input.ask,
      acceptance: input.acceptance,
      artifact: input.artifact,
      logBody: input.logBody,
      logTruncated: input.logTruncated
    };
    session.nextSequence += 1;
    session.cards.push(card);
    session.cardCount = session.cards.length;
    return card;
  }

  private findToolCard(session: AgentSession, toolCallId: string): SessionCard | undefined {
    return [...session.cards]
      .reverse()
      .find((card) => card.kind === "tool_call" && card.tool?.toolCallId === toolCallId);
  }

  private ensureTurn(session: AgentSession, _timestamp: string): string {
    if (session.activeTurnId) return session.activeTurnId;
    const turnId = randomUUID();
    session.activeTurnId = turnId;
    return turnId;
  }

  private rebuildSearchText(session: AgentSession): void {
    const parts = [
      session.title,
      session.agentName ?? "",
      session.preferredModelId ?? "",
      ...session.tags,
      ...session.cards.map((card) => card.summary),
      ...session.cards.map((card) => card.text ?? "").filter(Boolean)
    ];
    session.searchText = parts.join("\n").slice(0, 20_000);
    session.cardCount = session.cards.length;
  }

  private touch(session: AgentSession): void {
    const timestamp = this.iso();
    session.updatedAt = timestamp;
    session.lastActivityAt = timestamp;
  }

  private require(sessionId: string): AgentSession {
    const session = this.state.sessions.find((entry) => entry.id === sessionId);
    if (!session) throw notFound(sessionId);
    return session;
  }

  private toPublic(session: AgentSession): AgentSession {
    return structuredClone(session);
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify({ schemaVersion: 1, sessions: this.state.sessions }, null, 2)}\n`;
    await writeFile(temporaryPath, payload, {
      encoding: "utf8",
      mode: constants.S_IRUSR | constants.S_IWUSR
    });
    await rename(temporaryPath, this.statePath);
  }
}

function normalizeSession(raw: AgentSession): AgentSession {
  return {
    ...raw,
    tags: Array.isArray(raw.tags) ? normalizeTags(raw.tags) : [],
    cards: Array.isArray(raw.cards) ? raw.cards : [],
    messageQueue: Array.isArray(raw.messageQueue) ? raw.messageQueue : [],
    pendingInteractionCardIds: Array.isArray(raw.pendingInteractionCardIds)
      ? raw.pendingInteractionCardIds
      : [],
    nextSequence: typeof raw.nextSequence === "number" ? raw.nextSequence : 1,
    cardCount: Array.isArray(raw.cards) ? raw.cards.length : 0,
    searchText: typeof raw.searchText === "string" ? raw.searchText : "",
    status: isStatus(raw.status) ? raw.status : "idle"
  };
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags?.length) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const value = tag.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_CARDS_PAGE_LIMIT;
  return Math.min(MAX_CARDS_PAGE_LIMIT, Math.max(1, Math.floor(limit)));
}

function notFound(sessionId: string): Error {
  const error = new Error(`Session not found: ${sessionId}`);
  (error as Error & { statusCode?: number }).statusCode = 404;
  return error;
}
