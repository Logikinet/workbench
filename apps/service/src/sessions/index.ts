/**
 * Session management + structured Tool Cards (Task 41).
 */

export {
  SessionService,
  type SessionServiceOptions
} from "./sessionService.js";

export {
  createSessionRouter,
  createSessionRouteApp,
  type SessionRouteDeps
} from "./sessionRoutes.js";

export {
  applyToolResult,
  applyToolUpdate,
  compactCard,
  createToolCardPayload,
  formatDuration,
  inferToolPermission,
  maybeTruncateLogBody,
  summarizeArguments,
  summarizeOutput,
  toolCardSummary
} from "./toolCards.js";

export {
  DEFAULT_CARDS_PAGE_LIMIT,
  LONG_LOG_COLLAPSE_CHARS,
  MAX_ARGS_SUMMARY_CHARS,
  MAX_CARDS_PAGE_LIMIT,
  MAX_LOG_BODY_CHARS,
  MAX_OUTPUT_SUMMARY_CHARS,
  SESSION_CARD_KINDS,
  SESSION_STATUSES,
  type AcceptanceCardPayload,
  type AgentSession,
  type AnswerInteractionInput,
  type AppendMessageInput,
  type ArtifactLink,
  type AskCardPayload,
  type CardsPage,
  type CardsPageQuery,
  type CreateSessionInput,
  type EvidenceLink,
  type QueuedMessage,
  type SessionCard,
  type SessionCardKind,
  type SessionIngestEvent,
  type SessionListFilter,
  type SessionStateFile,
  type SessionStatus,
  type ToolCardPayload,
  type ToolCardPermission,
  type ToolCardStatus,
  type UpdateSessionInput
} from "./sessionTypes.js";
