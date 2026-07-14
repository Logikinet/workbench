/**
 * Limited exponential restart delay (NextClaw RuntimeServiceProcess).
 *
 * NextClaw formula: min(15_000, 500 * 2^(attempt-1))
 * PAW adds a hard maxAttempts cap so recovery does not loop forever.
 */

import {
  DEFAULT_RESTART_POLICY,
  type WatchdogRestartPolicy
} from "./watchdogTypes.js";

/**
 * Delay before the Nth automatic recovery attempt (1-based).
 * Matches NextClaw `computeRuntimeRestartDelayMs`.
 */
export function computeRuntimeRestartDelayMs(
  attempt: number,
  policy: Pick<WatchdogRestartPolicy, "baseDelayMs" | "maxDelayMs"> = DEFAULT_RESTART_POLICY
): number {
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const base = policy.baseDelayMs > 0 ? policy.baseDelayMs : DEFAULT_RESTART_POLICY.baseDelayMs;
  const cap = policy.maxDelayMs > 0 ? policy.maxDelayMs : DEFAULT_RESTART_POLICY.maxDelayMs;
  const raw = base * 2 ** (normalizedAttempt - 1);
  return Math.min(cap, raw);
}

/**
 * Whether another automatic recovery attempt is allowed.
 * `maxAttempts === 0` means unlimited (still delay-capped).
 */
export function canAttemptRestart(
  attempt: number,
  policy: Pick<WatchdogRestartPolicy, "maxAttempts"> = DEFAULT_RESTART_POLICY
): boolean {
  if (policy.maxAttempts <= 0) return true;
  return attempt <= policy.maxAttempts;
}

export function nextRestartAttempt(currentAttempt: number): number {
  const n = Number.isFinite(currentAttempt) ? Math.max(0, Math.floor(currentAttempt)) : 0;
  return n + 1;
}
