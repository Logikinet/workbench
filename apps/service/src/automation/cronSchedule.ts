/**
 * Lightweight local schedule helpers for automation triggers.
 * No external cron dependency — supports once / every / 5-field cron / manual.
 */

import type { AutomationSchedule } from "./automationTypes.js";
import { MIN_EVERY_MS } from "./automationTypes.js";

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export function validateSchedule(schedule: AutomationSchedule): void {
  if (!schedule || typeof schedule !== "object") {
    throw new ScheduleValidationError("A schedule is required.");
  }
  switch (schedule.kind) {
    case "manual":
      return;
    case "once": {
      if (!schedule.at?.trim()) {
        throw new ScheduleValidationError("once schedule requires an ISO `at` timestamp.");
      }
      const ms = Date.parse(schedule.at);
      if (!Number.isFinite(ms)) {
        throw new ScheduleValidationError(`Invalid once.at timestamp: ${schedule.at}`);
      }
      return;
    }
    case "every": {
      if (typeof schedule.everyMs !== "number" || !Number.isFinite(schedule.everyMs)) {
        throw new ScheduleValidationError("every schedule requires a numeric everyMs.");
      }
      if (schedule.everyMs < MIN_EVERY_MS) {
        throw new ScheduleValidationError(`everyMs must be at least ${MIN_EVERY_MS}ms.`);
      }
      return;
    }
    case "cron": {
      if (!schedule.expr?.trim()) {
        throw new ScheduleValidationError("cron schedule requires expr (5-field).");
      }
      parseCronExpression(schedule.expr.trim());
      return;
    }
    default:
      throw new ScheduleValidationError(`Unknown schedule kind: ${(schedule as { kind: string }).kind}`);
  }
}

/**
 * Next fire time strictly after `fromMs` (or at/after for once when still in future).
 * Returns null when no future occurrence exists (spent one-shot / manual).
 */
export function computeNextRunAtMs(
  schedule: AutomationSchedule,
  fromMs: number,
  options: { inclusive?: boolean; anchorMs?: number | null } = {}
): number | null {
  validateSchedule(schedule);
  const inclusive = options.inclusive === true;
  const base = inclusive ? fromMs - 1 : fromMs;

  switch (schedule.kind) {
    case "manual":
      return null;
    case "once": {
      const at = Date.parse(schedule.at!);
      return at > base ? at : null;
    }
    case "every": {
      const everyMs = schedule.everyMs!;
      const anchor = typeof options.anchorMs === "number" && Number.isFinite(options.anchorMs)
        ? options.anchorMs
        : null;
      if (anchor !== null) {
        if (anchor > base) return anchor;
        const steps = Math.floor((base - anchor) / everyMs) + 1;
        return anchor + steps * everyMs;
      }
      return fromMs + everyMs;
    }
    case "cron": {
      return nextCronOccurrenceMs(schedule.expr!.trim(), fromMs, inclusive);
    }
    default:
      return null;
  }
}

export function toIso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// --- Minimal 5-field cron (minute hour day-of-month month day-of-week) ---

interface CronField {
  all: boolean;
  values: Set<number>;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const CRON_CACHE = new Map<string, ParsedCron>();

export function parseCronExpression(expr: string): ParsedCron {
  const cached = CRON_CACHE.get(expr);
  if (cached) return cached;

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new ScheduleValidationError(
      `cron expr must have 5 fields (minute hour dom month dow); got ${parts.length}.`
    );
  }
  const parsed: ParsedCron = {
    minute: parseField(parts[0]!, 0, 59, "minute"),
    hour: parseField(parts[1]!, 0, 23, "hour"),
    dayOfMonth: parseField(parts[2]!, 1, 31, "day-of-month"),
    month: parseField(parts[3]!, 1, 12, "month"),
    dayOfWeek: parseField(parts[4]!, 0, 6, "day-of-week")
  };
  CRON_CACHE.set(expr, parsed);
  return parsed;
}

function parseField(raw: string, min: number, max: number, label: string): CronField {
  if (raw === "*") return { all: true, values: new Set() };
  const values = new Set<number>();
  for (const segment of raw.split(",")) {
    const stepParts = segment.split("/");
    const rangePart = stepParts[0]!;
    const step = stepParts[1] !== undefined ? Number.parseInt(stepParts[1], 10) : 1;
    if (!Number.isFinite(step) || step <= 0) {
      throw new ScheduleValidationError(`Invalid cron step in ${label}: ${segment}`);
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      start = Number.parseInt(a!, 10);
      end = Number.parseInt(b!, 10);
    } else {
      start = Number.parseInt(rangePart, 10);
      end = stepParts[1] !== undefined ? max : start;
    }
    if (![start, end].every((n) => Number.isFinite(n) && n >= min && n <= max) || start > end) {
      throw new ScheduleValidationError(`Invalid cron ${label} segment: ${segment}`);
    }
    for (let n = start; n <= end; n += step) {
      values.add(n);
    }
  }
  return { all: false, values };
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.all || field.values.has(value);
}

/**
 * Next occurrence at or after `fromMs` (minute resolution).
 * When inclusive=false, searches strictly after fromMs (starts from next minute).
 */
export function nextCronOccurrenceMs(expr: string, fromMs: number, inclusive = false): number | null {
  const cron = parseCronExpression(expr);
  const start = new Date(fromMs);
  // Work in local time components for wall-clock cron (local workstation).
  let cursor = new Date(start);
  cursor.setSeconds(0, 0);
  if (!inclusive) {
    cursor = new Date(cursor.getTime() + 60_000);
  }

  // Search up to ~2 years of minutes (bounded).
  const maxIterations = 60 * 24 * 366 * 2;
  for (let i = 0; i < maxIterations; i += 1) {
    const minute = cursor.getMinutes();
    const hour = cursor.getHours();
    const dom = cursor.getDate();
    const month = cursor.getMonth() + 1;
    const dow = cursor.getDay(); // 0=Sunday
    if (
      fieldMatches(cron.minute, minute) &&
      fieldMatches(cron.hour, hour) &&
      fieldMatches(cron.dayOfMonth, dom) &&
      fieldMatches(cron.month, month) &&
      fieldMatches(cron.dayOfWeek, dow)
    ) {
      return cursor.getTime();
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return null;
}

/** Slot identity used for scheduled-job idempotency. */
export function scheduledSlotKey(jobId: string, slotMs: number): string {
  return `job:${jobId}:slot:${new Date(slotMs).toISOString()}`;
}
