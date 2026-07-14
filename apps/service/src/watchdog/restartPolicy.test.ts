import { describe, expect, it } from "vitest";
import {
  canAttemptRestart,
  computeRuntimeRestartDelayMs,
  nextRestartAttempt
} from "./restartPolicy.js";

describe("computeRuntimeRestartDelayMs (NextClaw formula)", () => {
  it("matches NextClaw delays for attempts 1..n", () => {
    expect(computeRuntimeRestartDelayMs(1)).toBe(500);
    expect(computeRuntimeRestartDelayMs(2)).toBe(1_000);
    expect(computeRuntimeRestartDelayMs(3)).toBe(2_000);
    expect(computeRuntimeRestartDelayMs(4)).toBe(4_000);
    expect(computeRuntimeRestartDelayMs(5)).toBe(8_000);
    expect(computeRuntimeRestartDelayMs(6)).toBe(15_000);
    expect(computeRuntimeRestartDelayMs(10)).toBe(15_000);
  });

  it("normalizes non-positive attempts to 1", () => {
    expect(computeRuntimeRestartDelayMs(0)).toBe(500);
    expect(computeRuntimeRestartDelayMs(-3)).toBe(500);
    expect(computeRuntimeRestartDelayMs(Number.NaN)).toBe(500);
  });

  it("respects custom base/max", () => {
    expect(computeRuntimeRestartDelayMs(3, { baseDelayMs: 100, maxDelayMs: 250 })).toBe(250);
  });
});

describe("canAttemptRestart", () => {
  it("caps attempts when maxAttempts > 0", () => {
    expect(canAttemptRestart(10, { maxAttempts: 10 })).toBe(true);
    expect(canAttemptRestart(11, { maxAttempts: 10 })).toBe(false);
  });

  it("allows unlimited when maxAttempts is 0", () => {
    expect(canAttemptRestart(999, { maxAttempts: 0 })).toBe(true);
  });
});

describe("nextRestartAttempt", () => {
  it("increments from current", () => {
    expect(nextRestartAttempt(0)).toBe(1);
    expect(nextRestartAttempt(3)).toBe(4);
  });
});
