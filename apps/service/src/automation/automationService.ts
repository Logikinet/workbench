/**
 * Local Automation Service (Task 43).
 *
 * Supports one-shot, interval, cron, and manual jobs plus token-authenticated
 * local webhooks. Triggers create Todos / Runs / messages through injected
 * collaborators — they never auto-approve plans, dangerous actions, or accept work.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  automationActionTypes,
  DEFAULT_ALLOWED_SOURCES,
  MAX_HISTORY,
  MAX_IDEMPOTENCY,
  missedRunPolicies,
  scheduleKinds,
  webhookEventTypes,
  type ActionExecutionResult,
  type AutomationAction,
  type AutomationAuditEvent,
  type AutomationJob,
  type AutomationSchedule,
  type AutomationState,
  type CreateAutomationJobInput,
  type CreateWebhookInput,
  type CreateWebhookResult,
  type MissedRunPolicy,
  type ProcessWebhookInput,
  type PublicWebhookEndpoint,
  type UpdateAutomationJobInput,
  type WebhookEndpoint,
  type WebhookEventPayload,
  type WebhookEventType
} from "./automationTypes.js";
import {
  computeNextRunAtMs,
  scheduledSlotKey,
  ScheduleValidationError,
  toIso,
  validateSchedule
} from "./cronSchedule.js";

/** Narrow collaborators — only create/message APIs, never approval/accept. */
export interface AutomationTodoPort {
  create(input: {
    title: string;
    description?: string;
    projectId?: string;
  }): Promise<{ id: string; title: string }>;
}

export interface AutomationRunPort {
  create(todoId: string, initialMessage?: string): Promise<{ id: string; status: string }>;
  addUserMessage(runId: string, content: string): Promise<{ id: string }>;
}

export interface AutomationFlowPort {
  /**
   * Trigger a preset flow. Implementations must still route through normal
   * planning / approval / acceptance gates — this port only accepts work.
   */
  trigger(
    flowId: string,
    input: Record<string, unknown> | undefined,
    meta: { source: "cron" | "manual" | "webhook"; jobId?: string; webhookId?: string }
  ): Promise<{ accepted: boolean; todoId?: string; runId?: string; summary?: string }>;
}

export interface AutomationServiceOptions {
  statePath?: string;
  todos?: AutomationTodoPort;
  runs?: AutomationRunPort;
  flows?: AutomationFlowPort;
  /** Injectable clock (ms). */
  now?: () => number;
  /** Max history events retained. */
  maxHistory?: number;
}

function emptyState(): AutomationState {
  return {
    schemaVersion: 1,
    jobs: [],
    webhooks: [],
    history: [],
    idempotency: []
  };
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

function normalizeSource(address: string | undefined): string {
  if (!address) return "";
  return address.replace(/^::ffff:/i, "").toLowerCase();
}

function isLoopbackSource(address: string | undefined): boolean {
  const n = normalizeSource(address);
  return n === "127.0.0.1" || n === "::1" || n === "localhost" || n === "";
}

export class AutomationService {
  private state: AutomationState = emptyState();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => number;
  private readonly maxHistory: number;
  private tickInFlight = false;

  private constructor(
    private readonly statePath: string | undefined,
    state: AutomationState,
    private readonly todos: AutomationTodoPort | undefined,
    private readonly runs: AutomationRunPort | undefined,
    private readonly flows: AutomationFlowPort | undefined,
    now: (() => number) | undefined,
    maxHistory: number | undefined
  ) {
    this.state = state;
    this.now = now ?? (() => Date.now());
    this.maxHistory = maxHistory ?? MAX_HISTORY;
  }

  static async open(options: AutomationServiceOptions = {}): Promise<AutomationService> {
    let state = emptyState();
    if (options.statePath) {
      try {
        const decoded = JSON.parse(await readFile(options.statePath, "utf8")) as Partial<AutomationState>;
        if (decoded.schemaVersion !== 1) {
          throw new Error("Automation state is not compatible with this service version.");
        }
        state = {
          schemaVersion: 1,
          jobs: Array.isArray(decoded.jobs) ? (decoded.jobs as AutomationJob[]) : [],
          webhooks: Array.isArray(decoded.webhooks) ? (decoded.webhooks as WebhookEndpoint[]) : [],
          history: Array.isArray(decoded.history) ? (decoded.history as AutomationAuditEvent[]) : [],
          idempotency: Array.isArray(decoded.idempotency)
            ? (decoded.idempotency as AutomationState["idempotency"])
            : []
        };
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
          throw error;
        }
      }
    }
    return new AutomationService(
      options.statePath,
      state,
      options.todos,
      options.runs,
      options.flows,
      options.now,
      options.maxHistory
    );
  }

  static async createMemory(options: Omit<AutomationServiceOptions, "statePath"> = {}): Promise<AutomationService> {
    return AutomationService.open(options);
  }

  /** Start background scheduler (local only). Applies missed-run policy once. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.reconcileMissedOnStart();
    this.pushAudit({
      kind: "scheduler_started",
      source: "system",
      summary: "Automation scheduler started (local)."
    });
    await this.persist();
    this.armTimer();
  }

  /** Stop the background timer. Does not write disk (avoids teardown races); call flush() if needed. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pushAudit({
      kind: "scheduler_stopped",
      source: "system",
      summary: "Automation scheduler stopped."
    });
  }

  /** Persist current state (including any audit events buffered since last write). */
  async flush(): Promise<void> {
    await this.persist();
  }

  isRunning(): boolean {
    return this.running;
  }

  status(): {
    running: boolean;
    jobCount: number;
    enabledJobCount: number;
    webhookCount: number;
    nextWakeAt: string | null;
  } {
    return {
      running: this.running,
      jobCount: this.state.jobs.length,
      enabledJobCount: this.state.jobs.filter((j) => j.enabled).length,
      webhookCount: this.state.webhooks.length,
      nextWakeAt: toIso(this.getNextWakeMs())
    };
  }

  listJobs(includeDisabled = true): AutomationJob[] {
    const jobs = includeDisabled ? this.state.jobs : this.state.jobs.filter((j) => j.enabled);
    return jobs.map(cloneJob).sort((a, b) => {
      const an = a.state.nextRunAt ?? "\uffff";
      const bn = b.state.nextRunAt ?? "\uffff";
      return an.localeCompare(bn);
    });
  }

  getJob(jobId: string): AutomationJob {
    const job = this.findJob(jobId);
    if (!job) throw new Error(`Automation job ${jobId} was not found.`);
    return cloneJob(job);
  }

  async createJob(input: CreateAutomationJobInput): Promise<AutomationJob> {
    const name = required(input.name, "A job name is required.");
    validateSchedule(input.schedule);
    validateAction(input.action);
    const missed = normalizeMissedPolicy(input.missedRunPolicy);
    const now = this.now();
    const schedule = normalizeSchedule(input.schedule);
    // once keeps its absolute `at` even if already past so missed-run policy can act on start.
    const nextRunAt = initialNextRunAt(schedule, now);
    const job: AutomationJob = {
      id: randomUUID(),
      name,
      enabled: input.enabled !== false && schedule.kind !== "manual" ? true : input.enabled === true,
      schedule,
      action: structuredClone(input.action),
      missedRunPolicy: missed,
      state: {
        nextRunAt,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        lastScheduledSlot: null
      },
      deleteAfterRun: input.deleteAfterRun === true || schedule.kind === "once",
      createdAt: nowIso(now),
      updatedAt: nowIso(now)
    };
    // manual jobs default disabled unless explicitly enabled (still no nextRunAt)
    if (schedule.kind === "manual") {
      job.enabled = input.enabled === true;
      job.state.nextRunAt = null;
      job.deleteAfterRun = input.deleteAfterRun === true;
    }
    this.state.jobs.push(job);
    this.pushAudit({
      kind: "job_created",
      source: "system",
      jobId: job.id,
      summary: `Created automation job "${job.name}" (${job.schedule.kind}).`
    });
    await this.persist();
    this.armTimer();
    return cloneJob(job);
  }

  async updateJob(jobId: string, input: UpdateAutomationJobInput): Promise<AutomationJob> {
    const job = this.requireJob(jobId);
    const now = this.now();
    if (input.name !== undefined) job.name = required(input.name, "A job name is required.");
    if (input.schedule !== undefined) {
      validateSchedule(input.schedule);
      job.schedule = normalizeSchedule(input.schedule);
      if (job.enabled && job.schedule.kind !== "manual") {
        job.state.nextRunAt = initialNextRunAt(job.schedule, now);
      } else {
        job.state.nextRunAt = null;
      }
    }
    if (input.action !== undefined) {
      validateAction(input.action);
      job.action = structuredClone(input.action);
    }
    if (input.missedRunPolicy !== undefined) {
      job.missedRunPolicy = normalizeMissedPolicy(input.missedRunPolicy);
    }
    if (input.deleteAfterRun !== undefined) job.deleteAfterRun = input.deleteAfterRun;
    job.updatedAt = nowIso(now);
    this.pushAudit({
      kind: "job_updated",
      source: "system",
      jobId: job.id,
      summary: `Updated automation job "${job.name}".`
    });
    await this.persist();
    this.armTimer();
    return cloneJob(job);
  }

  async deleteJob(jobId: string): Promise<void> {
    const before = this.state.jobs.length;
    const job = this.findJob(jobId);
    this.state.jobs = this.state.jobs.filter((j) => j.id !== jobId);
    if (this.state.jobs.length === before) {
      throw new Error(`Automation job ${jobId} was not found.`);
    }
    this.pushAudit({
      kind: "job_deleted",
      source: "system",
      jobId,
      summary: `Deleted automation job "${job?.name ?? jobId}".`
    });
    await this.persist();
    this.armTimer();
  }

  async setJobEnabled(jobId: string, enabled: boolean): Promise<AutomationJob> {
    const job = this.requireJob(jobId);
    const now = this.now();
    job.enabled = enabled;
    job.updatedAt = nowIso(now);
    if (enabled && job.schedule.kind !== "manual") {
      job.state.nextRunAt = initialNextRunAt(job.schedule, now);
    } else if (!enabled) {
      job.state.nextRunAt = null;
    }
    this.pushAudit({
      kind: enabled ? "job_enabled" : "job_disabled",
      source: "system",
      jobId: job.id,
      summary: `${enabled ? "Enabled" : "Disabled"} automation job "${job.name}".`
    });
    await this.persist();
    this.armTimer();
    return cloneJob(job);
  }

  /**
   * Manual immediate execution. Does not require the job to be enabled when force=true.
   * Still never bypasses plan/danger/accept gates.
   */
  async runJobNow(jobId: string, options: { force?: boolean } = {}): Promise<ActionExecutionResult> {
    const job = this.requireJob(jobId);
    if (!job.enabled && !options.force) {
      throw new Error(`Automation job ${jobId} is disabled (pass force to run anyway).`);
    }
    return this.executeJob(job, {
      source: "manual",
      idempotencyKey: `manual:${job.id}:${this.now()}:${randomUUID()}`,
      scheduledSlotMs: null
    });
  }

  listHistory(filter: { jobId?: string; webhookId?: string; limit?: number } = {}): AutomationAuditEvent[] {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), MAX_HISTORY);
    return this.state.history
      .filter((e) => (filter.jobId ? e.jobId === filter.jobId : true))
      .filter((e) => (filter.webhookId ? e.webhookId === filter.webhookId : true))
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }

  // --- Webhooks ---

  listWebhooks(): PublicWebhookEndpoint[] {
    return this.state.webhooks.map(toPublicWebhook);
  }

  getWebhook(webhookId: string): PublicWebhookEndpoint {
    return toPublicWebhook(this.requireWebhook(webhookId));
  }

  async createWebhook(input: CreateWebhookInput): Promise<CreateWebhookResult> {
    const name = required(input.name, "A webhook name is required.");
    const now = this.now();
    const token = generateToken();
    const allowedEventTypes = normalizeEventTypes(input.allowedEventTypes);
    const webhook: WebhookEndpoint = {
      id: randomUUID(),
      name,
      enabled: input.enabled !== false,
      tokenHash: hashToken(token),
      allowedSources: normalizeSources(input.allowedSources),
      allowedEventTypes,
      createdAt: nowIso(now),
      updatedAt: nowIso(now)
    };
    this.state.webhooks.push(webhook);
    this.pushAudit({
      kind: "webhook_created",
      source: "system",
      webhookId: webhook.id,
      summary: `Created local webhook "${webhook.name}".`
    });
    await this.persist();
    return { webhook: toPublicWebhook(webhook), token };
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    const before = this.state.webhooks.length;
    const wh = this.findWebhook(webhookId);
    this.state.webhooks = this.state.webhooks.filter((w) => w.id !== webhookId);
    if (this.state.webhooks.length === before) {
      throw new Error(`Webhook ${webhookId} was not found.`);
    }
    this.pushAudit({
      kind: "webhook_deleted",
      source: "system",
      webhookId,
      summary: `Deleted webhook "${wh?.name ?? webhookId}".`
    });
    await this.persist();
  }

  async setWebhookEnabled(webhookId: string, enabled: boolean): Promise<PublicWebhookEndpoint> {
    const webhook = this.requireWebhook(webhookId);
    webhook.enabled = enabled;
    webhook.updatedAt = nowIso(this.now());
    this.pushAudit({
      kind: enabled ? "webhook_enabled" : "webhook_disabled",
      source: "system",
      webhookId: webhook.id,
      summary: `${enabled ? "Enabled" : "Disabled"} webhook "${webhook.name}".`
    });
    await this.persist();
    return toPublicWebhook(webhook);
  }

  async rotateWebhookToken(webhookId: string): Promise<CreateWebhookResult> {
    const webhook = this.requireWebhook(webhookId);
    const token = generateToken();
    webhook.tokenHash = hashToken(token);
    webhook.updatedAt = nowIso(this.now());
    this.pushAudit({
      kind: "webhook_token_rotated",
      source: "system",
      webhookId: webhook.id,
      summary: `Rotated token for webhook "${webhook.name}".`
    });
    await this.persist();
    return { webhook: toPublicWebhook(webhook), token };
  }

  /**
   * Process an inbound local webhook event.
   * Enforces token, source allow-list, structured event schema, and idempotency.
   */
  async processWebhook(input: ProcessWebhookInput): Promise<ActionExecutionResult> {
    const webhook = this.findWebhook(input.webhookId);
    if (!webhook) {
      const result = rejected("Webhook was not found.");
      this.pushAudit({
        kind: "webhook_rejected",
        source: "webhook",
        webhookId: input.webhookId,
        summary: result.summary,
        result: toResultMeta(result)
      });
      await this.persist();
      throw Object.assign(new Error(result.error!), { statusCode: 404 });
    }

    if (!webhook.enabled) {
      const result = rejected("Webhook is disabled.");
      this.pushAudit({
        kind: "webhook_rejected",
        source: "webhook",
        webhookId: webhook.id,
        summary: result.summary,
        result: toResultMeta(result)
      });
      await this.persist();
      throw Object.assign(new Error(result.error!), { statusCode: 403 });
    }

    if (hashToken(input.token) !== webhook.tokenHash) {
      const result = rejected("Invalid webhook token.");
      this.pushAudit({
        kind: "webhook_rejected",
        source: "webhook",
        webhookId: webhook.id,
        summary: result.summary,
        result: toResultMeta(result)
      });
      await this.persist();
      throw Object.assign(new Error(result.error!), { statusCode: 401 });
    }

    if (!isSourceAllowed(webhook.allowedSources, input.sourceAddress)) {
      const result = rejected(`Source ${input.sourceAddress ?? "(unknown)"} is not allowed for this webhook.`);
      this.pushAudit({
        kind: "webhook_rejected",
        source: "webhook",
        webhookId: webhook.id,
        summary: result.summary,
        result: toResultMeta(result),
        metadata: { sourceAddress: input.sourceAddress }
      });
      await this.persist();
      throw Object.assign(new Error(result.error!), { statusCode: 403 });
    }

    let payload: WebhookEventPayload;
    try {
      payload = parseWebhookPayload(input.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid webhook payload.";
      const result = rejected(message);
      this.pushAudit({
        kind: "webhook_rejected",
        source: "webhook",
        webhookId: webhook.id,
        summary: result.summary,
        result: toResultMeta(result)
      });
      await this.persist();
      throw Object.assign(new Error(message), { statusCode: 400 });
    }

    if (!webhook.allowedEventTypes.includes(payload.type)) {
      const result = rejected(`Event type "${payload.type}" is not allowed on this webhook.`);
      this.pushAudit({
        kind: "webhook_rejected",
        source: "webhook",
        webhookId: webhook.id,
        summary: result.summary,
        result: toResultMeta(result)
      });
      await this.persist();
      throw Object.assign(new Error(result.error!), { statusCode: 400 });
    }

    const idemKey =
      payload.idempotencyKey?.trim() ||
      (payload.eventId?.trim() ? `webhook:${webhook.id}:event:${payload.eventId.trim()}` : undefined);

    if (idemKey) {
      const existing = this.state.idempotency.find((e) => e.key === idemKey);
      if (existing) {
        const prior = this.state.history.find((h) => h.id === existing.eventId);
        const result: ActionExecutionResult = {
          status: "deduped",
          todoId: prior?.result?.todoId,
          runId: prior?.result?.runId,
          flowId: prior?.result?.flowId,
          requiresHumanGates: true,
          summary: `Duplicate webhook event ignored (idempotency key ${idemKey}).`
        };
        this.pushAudit({
          kind: "webhook_deduped",
          source: "webhook",
          webhookId: webhook.id,
          idempotencyKey: idemKey,
          summary: result.summary,
          result: toResultMeta(result)
        });
        await this.persist();
        return result;
      }
    }

    this.pushAudit({
      kind: "webhook_received",
      source: "webhook",
      webhookId: webhook.id,
      idempotencyKey: idemKey,
      summary: `Webhook "${webhook.name}" received event ${payload.type}.`,
      metadata: { type: payload.type }
    });

    const action = webhookPayloadToAction(payload);
    const result = await this.executeAction(action, {
      source: "webhook",
      webhookId: webhook.id
    });

    const event = this.pushAudit({
      kind: result.status === "ok" ? "webhook_executed" : "webhook_rejected",
      source: "webhook",
      webhookId: webhook.id,
      idempotencyKey: idemKey,
      summary: result.summary,
      result: toResultMeta(result)
    });
    if (idemKey && result.status === "ok") {
      this.rememberIdempotency(idemKey, event.id);
    }
    await this.persist();
    return result;
  }

  /** Test helper: advance scheduler as if the clock fired. */
  async tickForTest(): Promise<void> {
    await this.onTimer();
  }

  // --- internals ---

  private findJob(id: string): AutomationJob | undefined {
    return this.state.jobs.find((j) => j.id === id);
  }

  private requireJob(id: string): AutomationJob {
    const job = this.findJob(id);
    if (!job) throw new Error(`Automation job ${id} was not found.`);
    return job;
  }

  private findWebhook(id: string): WebhookEndpoint | undefined {
    return this.state.webhooks.find((w) => w.id === id);
  }

  private requireWebhook(id: string): WebhookEndpoint {
    const wh = this.findWebhook(id);
    if (!wh) throw new Error(`Webhook ${id} was not found.`);
    return wh;
  }

  private getNextWakeMs(): number | null {
    const times = this.state.jobs
      .filter((j) => j.enabled && j.state.nextRunAt)
      .map((j) => Date.parse(j.state.nextRunAt!))
      .filter((ms) => Number.isFinite(ms));
    if (times.length === 0) return null;
    return Math.min(...times);
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;
    const next = this.getNextWakeMs();
    if (next === null) return;
    const delay = Math.max(0, next - this.now());
    this.timer = setTimeout(() => {
      void this.runTimerSafely();
    }, delay);
    // Allow Node to exit in tests even if a timer is armed.
    this.timer.unref?.();
  }

  private async runTimerSafely(): Promise<void> {
    try {
      await this.onTimer();
    } catch (error) {
      console.error("[automation] timer failed:", error instanceof Error ? error.message : error);
      this.armTimer();
    }
  }

  private async onTimer(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const now = this.now();
      const due = this.state.jobs.filter(
        (j) => j.enabled && j.state.nextRunAt && Date.parse(j.state.nextRunAt) <= now
      );
      for (const job of due) {
        await this.handleDueJob(job, now);
      }
      await this.persist();
    } finally {
      this.tickInFlight = false;
      this.armTimer();
    }
  }

  /**
   * On start: for overdue jobs, either skip forward (default) or catch up once.
   * Never batch-executes a backlog of missed slots.
   */
  private async reconcileMissedOnStart(): Promise<void> {
    const now = this.now();
    for (const job of this.state.jobs) {
      if (!job.enabled || !job.state.nextRunAt || job.schedule.kind === "manual") continue;
      const nextMs = Date.parse(job.state.nextRunAt);
      if (!Number.isFinite(nextMs) || nextMs > now) continue;

      // Strictly overdue + skip: jump to next future slot without batch-firing.
      // Due exactly now (or catch_up_one): execute a single slot.
      if (nextMs < now && job.missedRunPolicy === "skip") {
        const future = computeNextRunAtMs(job.schedule, now, {
          inclusive: false,
          anchorMs: nextMs
        });
        job.state.nextRunAt = toIso(future);
        job.state.lastStatus = "skipped";
        job.state.lastError = null;
        job.updatedAt = nowIso(now);
        this.pushAudit({
          kind: "job_skipped",
          source: "system",
          jobId: job.id,
          summary: `Skipped missed run(s) for "${job.name}" (policy=skip); next at ${job.state.nextRunAt ?? "none"}.`,
          result: {
            status: "skipped",
            requiresHumanGates: true
          },
          metadata: { missedSlot: new Date(nextMs).toISOString(), policy: "skip" }
        });
      } else {
        await this.handleDueJob(job, now);
      }
    }
  }

  private async handleDueJob(job: AutomationJob, now: number): Promise<void> {
    const slotMs = job.state.nextRunAt ? Date.parse(job.state.nextRunAt) : now;
    const idem = scheduledSlotKey(job.id, Number.isFinite(slotMs) ? slotMs : now);

    // Idempotency: do not re-run the same scheduled slot.
    if (this.state.idempotency.some((e) => e.key === idem) || job.state.lastScheduledSlot === toIso(slotMs)) {
      job.state.nextRunAt = toIso(
        computeNextRunAtMs(job.schedule, now, {
          inclusive: false,
          anchorMs: Number.isFinite(slotMs) ? slotMs : null
        })
      );
      job.updatedAt = nowIso(now);
      this.pushAudit({
        kind: "job_deduped",
        source: "cron",
        jobId: job.id,
        idempotencyKey: idem,
        summary: `Deduped scheduled slot for "${job.name}".`,
        result: { status: "deduped", requiresHumanGates: true }
      });
      return;
    }

    await this.executeJob(job, {
      source: "cron",
      idempotencyKey: idem,
      scheduledSlotMs: Number.isFinite(slotMs) ? slotMs : now
    });
  }

  private async executeJob(
    job: AutomationJob,
    ctx: {
      source: "cron" | "manual";
      idempotencyKey: string;
      scheduledSlotMs: number | null;
    }
  ): Promise<ActionExecutionResult> {
    const now = this.now();
    let result: ActionExecutionResult;
    try {
      result = await this.executeAction(job.action, {
        source: ctx.source,
        jobId: job.id
      });
    } catch (error) {
      result = {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        requiresHumanGates: true,
        summary: `Automation job "${job.name}" failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    job.state.lastRunAt = nowIso(now);
    job.state.lastStatus = result.status;
    job.state.lastError = result.error ?? null;
    if (ctx.scheduledSlotMs !== null) {
      job.state.lastScheduledSlot = toIso(ctx.scheduledSlotMs);
    }
    job.updatedAt = nowIso(now);

    if (result.status === "ok") {
      this.rememberIdempotency(ctx.idempotencyKey, randomUUID());
    }

    // Advance schedule
    if (job.schedule.kind === "once" || job.schedule.kind === "manual") {
      if (job.deleteAfterRun && result.status === "ok") {
        this.state.jobs = this.state.jobs.filter((j) => j.id !== job.id);
      } else {
        job.enabled = false;
        job.state.nextRunAt = null;
      }
    } else if (ctx.source === "cron" || ctx.scheduledSlotMs !== null) {
      const anchor = ctx.scheduledSlotMs;
      job.state.nextRunAt = toIso(
        computeNextRunAtMs(job.schedule, now, {
          inclusive: false,
          anchorMs: anchor
        })
      );
    }
    // manual force-run of an interval job does not shift nextRunAt unless it was due

    const kind =
      result.status === "ok"
        ? "job_executed"
        : result.status === "skipped"
          ? "job_skipped"
          : result.status === "deduped"
            ? "job_deduped"
            : "job_error";

    this.pushAudit({
      kind,
      source: ctx.source,
      jobId: job.id,
      idempotencyKey: ctx.idempotencyKey,
      summary: result.summary,
      result: toResultMeta(result)
    });

    await this.persist();
    this.armTimer();
    return result;
  }

  /**
   * Execute an action via injected ports only.
   * CRITICAL: never calls plan approval, danger approval, or acceptance APIs.
   */
  private async executeAction(
    action: AutomationAction,
    meta: { source: "cron" | "manual" | "webhook"; jobId?: string; webhookId?: string }
  ): Promise<ActionExecutionResult> {
    switch (action.type) {
      case "create_todo": {
        if (!this.todos) {
          return failed("Todo service is not configured for automation.");
        }
        const todo = await this.todos.create({
          title: action.title,
          description: action.description,
          projectId: action.projectId
        });
        let runId: string | undefined;
        if (action.startRun) {
          if (!this.runs) {
            return failed("Run service is not configured for automation.");
          }
          const run = await this.runs.create(todo.id, action.initialMessage);
          runId = run.id;
        }
        return {
          status: "ok",
          todoId: todo.id,
          runId,
          requiresHumanGates: true,
          summary: runId
            ? `Created Todo ${todo.id} and Run ${runId}; plan approval / danger / acceptance still required.`
            : `Created Todo ${todo.id}; any later Run still requires plan approval and acceptance.`
        };
      }
      case "create_run": {
        if (!this.runs) {
          return failed("Run service is not configured for automation.");
        }
        const run = await this.runs.create(action.todoId, action.message);
        return {
          status: "ok",
          todoId: action.todoId,
          runId: run.id,
          requiresHumanGates: true,
          summary: `Created Run ${run.id} (status=${run.status}); plan approval / danger / acceptance still required.`
        };
      }
      case "append_run_message": {
        if (!this.runs) {
          return failed("Run service is not configured for automation.");
        }
        await this.runs.addUserMessage(action.runId, action.message);
        return {
          status: "ok",
          runId: action.runId,
          requiresHumanGates: true,
          summary: `Appended message to Run ${action.runId}; does not approve plans or accept work.`
        };
      }
      case "trigger_flow": {
        if (!this.flows) {
          return failed("Flow trigger is not configured for automation.");
        }
        const outcome = await this.flows.trigger(action.flowId, action.input, {
          source: meta.source,
          jobId: meta.jobId,
          webhookId: meta.webhookId
        });
        if (!outcome.accepted) {
          return {
            status: "error",
            flowId: action.flowId,
            error: outcome.summary ?? "Flow was not accepted.",
            requiresHumanGates: true,
            summary: outcome.summary ?? `Flow ${action.flowId} was not accepted.`
          };
        }
        return {
          status: "ok",
          flowId: action.flowId,
          todoId: outcome.todoId,
          runId: outcome.runId,
          requiresHumanGates: true,
          summary:
            outcome.summary ??
            `Triggered flow ${action.flowId}; plan approval / danger / acceptance still required.`
        };
      }
      default: {
        const _exhaustive: never = action;
        return failed(`Unknown action type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  private pushAudit(
    partial: Omit<AutomationAuditEvent, "id" | "createdAt"> & { createdAt?: string }
  ): AutomationAuditEvent {
    const event: AutomationAuditEvent = {
      id: randomUUID(),
      createdAt: partial.createdAt ?? nowIso(this.now()),
      kind: partial.kind,
      summary: partial.summary,
      source: partial.source,
      jobId: partial.jobId,
      webhookId: partial.webhookId,
      idempotencyKey: partial.idempotencyKey,
      result: partial.result,
      metadata: partial.metadata
    };
    this.state.history.unshift(event);
    if (this.state.history.length > this.maxHistory) {
      this.state.history.length = this.maxHistory;
    }
    return event;
  }

  private rememberIdempotency(key: string, eventId: string): void {
    this.state.idempotency.unshift({ key, eventId, createdAt: nowIso(this.now()) });
    if (this.state.idempotency.length > MAX_IDEMPOTENCY) {
      this.state.idempotency.length = MAX_IDEMPOTENCY;
    }
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: constants.S_IRUSR | constants.S_IWUSR
    });
    try {
      await rename(tempPath, this.statePath);
    } catch (error: unknown) {
      // Windows can EPERM replace-via-rename when the dest is open; fall back to overwrite.
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") {
        await writeFile(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
        await unlink(tempPath).catch(() => undefined);
        return;
      }
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

// --- helpers ---

function required(value: string | undefined, message: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function normalizeMissedPolicy(value: MissedRunPolicy | undefined): MissedRunPolicy {
  if (!value) return "skip";
  if (!(missedRunPolicies as readonly string[]).includes(value)) {
    throw new Error(`Invalid missedRunPolicy: ${value}`);
  }
  return value;
}

function normalizeSchedule(schedule: AutomationSchedule): AutomationSchedule {
  validateSchedule(schedule);
  if (schedule.kind === "once") return { kind: "once", at: new Date(Date.parse(schedule.at!)).toISOString() };
  if (schedule.kind === "every") return { kind: "every", everyMs: schedule.everyMs };
  if (schedule.kind === "cron") return { kind: "cron", expr: schedule.expr!.trim() };
  return { kind: "manual" };
}

/** Initial next fire time; `once` retains absolute `at` even when already overdue. */
function initialNextRunAt(schedule: AutomationSchedule, nowMs: number): string | null {
  if (schedule.kind === "manual") return null;
  if (schedule.kind === "once") {
    return new Date(Date.parse(schedule.at!)).toISOString();
  }
  return toIso(computeNextRunAtMs(schedule, nowMs, { inclusive: true }));
}

function validateAction(action: AutomationAction): void {
  if (!action || typeof action !== "object") throw new Error("An action is required.");
  if (!(automationActionTypes as readonly string[]).includes(action.type)) {
    throw new Error(`Unknown action type: ${(action as { type: string }).type}`);
  }
  switch (action.type) {
    case "create_todo":
      if (!action.title?.trim()) throw new Error("create_todo requires title.");
      return;
    case "append_run_message":
      if (!action.runId?.trim()) throw new Error("append_run_message requires runId.");
      if (!action.message?.trim()) throw new Error("append_run_message requires message.");
      return;
    case "create_run":
      if (!action.todoId?.trim()) throw new Error("create_run requires todoId.");
      return;
    case "trigger_flow":
      if (!action.flowId?.trim()) throw new Error("trigger_flow requires flowId.");
      return;
  }
}

function normalizeSources(sources: string[] | undefined): string[] {
  if (!sources || sources.length === 0) return [...DEFAULT_ALLOWED_SOURCES];
  const normalized = sources.map((s) => normalizeSource(s)).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_ALLOWED_SOURCES];
}

function normalizeEventTypes(types: WebhookEventType[] | undefined): WebhookEventType[] {
  if (!types || types.length === 0) return [...webhookEventTypes];
  for (const t of types) {
    if (!(webhookEventTypes as readonly string[]).includes(t)) {
      throw new Error(`Unknown webhook event type: ${t}`);
    }
  }
  return [...new Set(types)];
}

function isSourceAllowed(allowed: string[], sourceAddress: string | undefined): boolean {
  // Empty source on loopback-bound service is treated as local.
  if (!sourceAddress && allowed.some((a) => isLoopbackSource(a))) return true;
  const n = normalizeSource(sourceAddress);
  return allowed.map(normalizeSource).includes(n) || (isLoopbackSource(n) && allowed.some(isLoopbackSource));
}

function parseWebhookPayload(body: WebhookEventPayload | Record<string, unknown>): WebhookEventPayload {
  if (!body || typeof body !== "object") throw new Error("Webhook body must be a JSON object.");
  const type = (body as { type?: unknown }).type;
  if (typeof type !== "string" || !(webhookEventTypes as readonly string[]).includes(type)) {
    throw new Error(
      `Unknown or missing event type. Allowed: ${webhookEventTypes.join(", ")}.`
    );
  }
  const payload = body as WebhookEventPayload;
  // Structural checks by type
  switch (type as WebhookEventType) {
    case "create_todo":
      if (typeof payload.title !== "string" || !payload.title.trim()) {
        throw new Error("create_todo requires title.");
      }
      break;
    case "append_run_message":
      if (typeof payload.runId !== "string" || !payload.runId.trim()) {
        throw new Error("append_run_message requires runId.");
      }
      if (typeof payload.message !== "string" || !payload.message.trim()) {
        throw new Error("append_run_message requires message.");
      }
      break;
    case "create_run":
      if (typeof payload.todoId !== "string" || !payload.todoId.trim()) {
        throw new Error("create_run requires todoId.");
      }
      break;
    case "trigger_flow":
      if (typeof payload.flowId !== "string" || !payload.flowId.trim()) {
        throw new Error("trigger_flow requires flowId.");
      }
      break;
  }
  return payload;
}

function webhookPayloadToAction(payload: WebhookEventPayload): AutomationAction {
  switch (payload.type) {
    case "create_todo":
      return {
        type: "create_todo",
        title: payload.title!,
        description: payload.description,
        projectId: payload.projectId,
        startRun: payload.startRun === true,
        initialMessage: payload.initialMessage
      };
    case "append_run_message":
      return {
        type: "append_run_message",
        runId: payload.runId!,
        message: payload.message!
      };
    case "create_run":
      return {
        type: "create_run",
        todoId: payload.todoId!,
        message: payload.message ?? payload.initialMessage
      };
    case "trigger_flow":
      return {
        type: "trigger_flow",
        flowId: payload.flowId!,
        input: payload.input
      };
  }
}

function toPublicWebhook(webhook: WebhookEndpoint): PublicWebhookEndpoint {
  return {
    id: webhook.id,
    name: webhook.name,
    enabled: webhook.enabled,
    allowedSources: [...webhook.allowedSources],
    allowedEventTypes: [...webhook.allowedEventTypes],
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
    path: `/api/hooks/${webhook.id}`
  };
}

function cloneJob(job: AutomationJob): AutomationJob {
  return structuredClone(job);
}

function toResultMeta(result: ActionExecutionResult): NonNullable<AutomationAuditEvent["result"]> {
  return {
    status: result.status,
    todoId: result.todoId,
    runId: result.runId,
    flowId: result.flowId,
    error: result.error,
    requiresHumanGates: true
  };
}

function failed(message: string): ActionExecutionResult {
  return {
    status: "error",
    error: message,
    requiresHumanGates: true,
    summary: message
  };
}

function rejected(message: string): ActionExecutionResult {
  return {
    status: "rejected",
    error: message,
    requiresHumanGates: true,
    summary: message
  };
}

export { ScheduleValidationError, scheduleKinds, webhookEventTypes, missedRunPolicies };
