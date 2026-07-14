/**
 * Local automation triggers (Task 43).
 * Cron / one-shot / manual / webhook — fully local, never bypasses
 * plan approval, dangerous-action approval, or final human acceptance.
 */

/** How to handle slots missed while the service was offline. Default: skip (never batch-fire). */
export const missedRunPolicies = ["skip", "catch_up_one"] as const;
export type MissedRunPolicy = (typeof missedRunPolicies)[number];

export const scheduleKinds = ["once", "every", "cron", "manual"] as const;
export type ScheduleKind = (typeof scheduleKinds)[number];

export interface AutomationSchedule {
  kind: ScheduleKind;
  /** ISO-8601 absolute time for `once`. */
  at?: string;
  /** Interval in milliseconds for `every` (min 1000). */
  everyMs?: number;
  /** Standard 5-field cron expression (minute hour dom month dow) for `cron`. */
  expr?: string;
}

export const automationActionTypes = [
  "create_todo",
  "append_run_message",
  "create_run",
  "trigger_flow"
] as const;
export type AutomationActionType = (typeof automationActionTypes)[number];

export type AutomationAction =
  | {
      type: "create_todo";
      title: string;
      description?: string;
      projectId?: string;
      /** When true, also create a Run for the new Todo (still awaits plan approval). */
      startRun?: boolean;
      initialMessage?: string;
    }
  | {
      type: "append_run_message";
      runId: string;
      message: string;
    }
  | {
      type: "create_run";
      todoId: string;
      message?: string;
    }
  | {
      type: "trigger_flow";
      flowId: string;
      input?: Record<string, unknown>;
    };

export type ExecutionStatus = "ok" | "error" | "skipped" | "deduped" | "rejected";

export interface AutomationJobState {
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastStatus?: ExecutionStatus | null;
  lastError?: string | null;
  /** ISO of the last scheduled slot that was executed/skipped (idempotency anchor). */
  lastScheduledSlot?: string | null;
}

export interface AutomationJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  action: AutomationAction;
  missedRunPolicy: MissedRunPolicy;
  state: AutomationJobState;
  /** Delete the job after a successful one-shot execution. */
  deleteAfterRun: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAutomationJobInput {
  name: string;
  schedule: AutomationSchedule;
  action: AutomationAction;
  missedRunPolicy?: MissedRunPolicy;
  enabled?: boolean;
  deleteAfterRun?: boolean;
}

export interface UpdateAutomationJobInput {
  name?: string;
  schedule?: AutomationSchedule;
  action?: AutomationAction;
  missedRunPolicy?: MissedRunPolicy;
  deleteAfterRun?: boolean;
}

/** Webhook event types (structured schema; unknown types are rejected). */
export const webhookEventTypes = [
  "create_todo",
  "append_run_message",
  "create_run",
  "trigger_flow"
] as const;
export type WebhookEventType = (typeof webhookEventTypes)[number];

export interface WebhookEndpoint {
  id: string;
  name: string;
  enabled: boolean;
  /** SHA-256 hex of the bearer token (plaintext only returned on create/rotate). */
  tokenHash: string;
  /** Loopback-only by default; additional source addresses may be allowed. */
  allowedSources: string[];
  allowedEventTypes: WebhookEventType[];
  createdAt: string;
  updatedAt: string;
}

/** Public webhook view — never includes the raw token. */
export interface PublicWebhookEndpoint {
  id: string;
  name: string;
  enabled: boolean;
  allowedSources: string[];
  allowedEventTypes: WebhookEventType[];
  createdAt: string;
  updatedAt: string;
  /** Relative path for local tools to POST events. */
  path: string;
}

export interface CreateWebhookInput {
  name: string;
  allowedSources?: string[];
  allowedEventTypes?: WebhookEventType[];
  enabled?: boolean;
}

export interface CreateWebhookResult {
  webhook: PublicWebhookEndpoint;
  /** Plaintext token — shown once; store securely on the client. */
  token: string;
}

export type AuditSource = "cron" | "manual" | "webhook" | "system";

export type AuditKind =
  | "job_created"
  | "job_updated"
  | "job_enabled"
  | "job_disabled"
  | "job_deleted"
  | "job_executed"
  | "job_skipped"
  | "job_error"
  | "job_deduped"
  | "webhook_created"
  | "webhook_deleted"
  | "webhook_enabled"
  | "webhook_disabled"
  | "webhook_token_rotated"
  | "webhook_received"
  | "webhook_rejected"
  | "webhook_executed"
  | "webhook_deduped"
  | "scheduler_started"
  | "scheduler_stopped";

export interface AutomationAuditEvent {
  id: string;
  kind: AuditKind;
  summary: string;
  source: AuditSource;
  jobId?: string;
  webhookId?: string;
  idempotencyKey?: string;
  result?: {
    status: ExecutionStatus;
    todoId?: string;
    runId?: string;
    flowId?: string;
    error?: string;
    /** Explicit: automated triggers never auto-approve plans / danger / acceptance. */
    requiresHumanGates: true;
  };
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ActionExecutionResult {
  status: ExecutionStatus;
  todoId?: string;
  runId?: string;
  flowId?: string;
  error?: string;
  requiresHumanGates: true;
  summary: string;
}

export interface WebhookEventPayload {
  type: WebhookEventType;
  /** Client-supplied key for idempotent delivery. */
  idempotencyKey?: string;
  eventId?: string;
  title?: string;
  description?: string;
  projectId?: string;
  startRun?: boolean;
  initialMessage?: string;
  runId?: string;
  message?: string;
  todoId?: string;
  flowId?: string;
  input?: Record<string, unknown>;
}

export interface ProcessWebhookInput {
  webhookId: string;
  token: string;
  sourceAddress?: string;
  body: WebhookEventPayload;
}

export interface AutomationState {
  schemaVersion: 1;
  jobs: AutomationJob[];
  webhooks: WebhookEndpoint[];
  history: AutomationAuditEvent[];
  /** Recent idempotency keys → audit event id (bounded). */
  idempotency: Array<{ key: string; eventId: string; createdAt: string }>;
}

export const DEFAULT_ALLOWED_SOURCES = ["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"] as const;

export const MAX_HISTORY = 500;
export const MAX_IDEMPOTENCY = 200;
/** Minimum interval between `every` ticks. */
export const MIN_EVERY_MS = 1000;
