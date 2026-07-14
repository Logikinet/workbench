import { sameCommand } from "./commandMatch.js";
import type { VerificationCommandEntry, VerificationPlan } from "./types.js";

export interface ApprovedExecutionCheck {
  allowed: string[][];
  rejected: string[][];
  ok: boolean;
  reason?: string;
}

/**
 * Execution phase may only run commands bound to the approved plan.
 * New commands require re-approval (rejected here).
 */
export function checkApprovedExecution(
  requested: string[][],
  approved: string[][] | VerificationCommandEntry[] | VerificationPlan
): ApprovedExecutionCheck {
  const approvedArgv = normalizeApproved(approved);
  if (approvedArgv.length === 0) {
    return {
      allowed: [],
      rejected: requested.map((command) => [...command]),
      ok: false,
      reason: "已批准计划未绑定任何验证命令；新增命令需重新审批。"
    };
  }
  if (!Array.isArray(requested) || requested.length === 0) {
    return {
      allowed: [],
      rejected: [],
      ok: false,
      reason: "至少需要一条已批准的验证命令。"
    };
  }

  const allowed: string[][] = [];
  const rejected: string[][] = [];
  for (const command of requested) {
    if (!isValidCommand(command)) {
      rejected.push([...command]);
      continue;
    }
    if (approvedArgv.some((entry) => sameCommand(entry, command))) {
      allowed.push([...command]);
    } else {
      rejected.push([...command]);
    }
  }

  if (rejected.length > 0) {
    return {
      allowed,
      rejected,
      ok: false,
      reason: "Only verification commands in the approved Secondmate plan may run."
    };
  }

  return { allowed, rejected, ok: true };
}

/** Throws when any requested command is outside the approved set. */
export function assertOnlyApprovedCommands(
  requested: string[][],
  approved: string[][] | VerificationCommandEntry[] | VerificationPlan
): string[][] {
  const result = checkApprovedExecution(requested, approved);
  if (!result.ok) {
    throw new Error(result.reason ?? "Only approved verification commands may run.");
  }
  return result.allowed;
}

function normalizeApproved(approved: string[][] | VerificationCommandEntry[] | VerificationPlan): string[][] {
  if (Array.isArray(approved)) {
    if (approved.length === 0) return [];
    const first = approved[0];
    if (Array.isArray(first)) {
      return (approved as string[][]).filter(isValidCommand).map((command) => [...command]);
    }
    return (approved as VerificationCommandEntry[])
      .filter((entry) => entry.enabled !== false && isValidCommand(entry.command))
      .map((entry) => [...entry.command]);
  }
  return approved.commands
    .filter((entry) => entry.enabled && isValidCommand(entry.command))
    .map((entry) => [...entry.command]);
}

function isValidCommand(command: string[]): boolean {
  return Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string" && part.trim().length > 0);
}
