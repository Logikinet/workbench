import { describe, expect, it } from "vitest";
import {
  computeNextRunAtMs,
  nextCronOccurrenceMs,
  parseCronExpression,
  ScheduleValidationError,
  validateSchedule
} from "./cronSchedule.js";

describe("cronSchedule", () => {
  it("validates once / every / cron / manual schedules", () => {
    expect(() => validateSchedule({ kind: "manual" })).not.toThrow();
    expect(() => validateSchedule({ kind: "once", at: "2026-01-01T00:00:00.000Z" })).not.toThrow();
    expect(() => validateSchedule({ kind: "every", everyMs: 60_000 })).not.toThrow();
    expect(() => validateSchedule({ kind: "cron", expr: "0 * * * *" })).not.toThrow();

    expect(() => validateSchedule({ kind: "once" })).toThrow(ScheduleValidationError);
    expect(() => validateSchedule({ kind: "every", everyMs: 100 })).toThrow(/at least/);
    expect(() => validateSchedule({ kind: "cron", expr: "bad" })).toThrow(ScheduleValidationError);
  });

  it("computes once next only while still in the future", () => {
    const at = "2030-06-01T12:00:00.000Z";
    const atMs = Date.parse(at);
    expect(computeNextRunAtMs({ kind: "once", at }, atMs - 1000)).toBe(atMs);
    expect(computeNextRunAtMs({ kind: "once", at }, atMs)).toBeNull();
    expect(computeNextRunAtMs({ kind: "manual" }, Date.now())).toBeNull();
  });

  it("computes every intervals from an anchor without batching gaps", () => {
    const everyMs = 10_000;
    const anchor = 1_000_000;
    const next = computeNextRunAtMs({ kind: "every", everyMs }, anchor + 25_000, { anchorMs: anchor });
    // floor((25000)/10000)+1 = 3 → anchor + 30000
    expect(next).toBe(anchor + 30_000);
  });

  it("parses 5-field cron and finds the next minute match", () => {
    const parsed = parseCronExpression("*/5 9-17 * * 1-5");
    expect(parsed.minute.all).toBe(false);
    expect(parsed.minute.values.has(0)).toBe(true);
    expect(parsed.minute.values.has(5)).toBe(true);

    // Fixed local wall clock: pick a Monday 09:00 base if possible via Date construction
    const from = new Date(2026, 0, 5, 8, 58, 0, 0); // Mon Jan 5 2026 08:58 local
    const next = nextCronOccurrenceMs("0 9 * * 1", from.getTime(), false);
    expect(next).not.toBeNull();
    const d = new Date(next!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDay()).toBe(1);
  });
});
