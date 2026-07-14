/**
 * Firstmate hard security / orchestration rules for Agent Home.
 *
 * These are system-fixed. Home profile files may only supplement role
 * behaviour; they cannot override these boundaries.
 */

import { firstmateCoreRules } from "../roles/roleService.js";

/** Canonical hard rules string (same source of truth as RoleService). */
export const FIRSTMATE_HARD_RULES = firstmateCoreRules;

/**
 * Patterns that attempt to weaken or override Firstmate hard boundaries.
 * Matches are case-insensitive.
 */
const OVERRIDE_PATTERNS: RegExp[] = [
  /\bignore\b[\s\S]{0,40}\bfirstmate\b/i,
  /\boverride\b[\s\S]{0,40}\bfirstmate\b/i,
  /\bdisable\b[\s\S]{0,40}\bfirstmate\b/i,
  /\bfirstmate\b[\s\S]{0,40}\b(ignore|override|disable|bypass)\b/i,
  /\bwithout\b[\s\S]{0,30}\bapproved\s+plans?\b/i,
  /\bskip\b[\s\S]{0,30}\bapproved\s+plans?\b/i,
  /\bordinary\s+agent\s+roles?\s+can\s+override\b/i,
  /\bdirectly\s+produces?\s+formal\s+artifacts?\b/i,
  /\bbypass\b[\s\S]{0,40}\bsecurity\s+boundaries\b/i
];

export interface HardRuleViolation {
  pattern: string;
  message: string;
}

/**
 * Detect Home content that tries to override Firstmate hard rules.
 * Returns violations (empty = allowed).
 */
export function detectHardRuleOverrides(content: string): HardRuleViolation[] {
  if (!content || !content.trim()) return [];
  const violations: HardRuleViolation[] = [];
  for (const pattern of OVERRIDE_PATTERNS) {
    if (pattern.test(content)) {
      violations.push({
        pattern: pattern.source,
        message:
          "Home profile content cannot override Firstmate hard security or orchestration rules."
      });
    }
  }
  return violations;
}

/**
 * Assert content is allowed as a Home supplement. Throws on override attempts.
 */
export function assertHomeCannotOverrideHardRules(content: string, fileLabel?: string): void {
  const violations = detectHardRuleOverrides(content);
  if (violations.length === 0) return;
  const where = fileLabel ? ` in ${fileLabel}` : "";
  throw new Error(
    `Home content${where} attempts to override Firstmate hard rules (system-fixed; cannot be overridden by AGENTS.md/IDENTITY.md/USER.md/TOOLS.md/MEMORY.md).`
  );
}

/**
 * Compose a system prefix that always wins over Home supplements.
 */
export function composeWithHardRules(homeSupplements: string[]): string {
  const parts = [
    "## Firstmate hard rules (system — cannot be overridden by Agent Home)",
    FIRSTMATE_HARD_RULES,
    "",
    "## Agent Home supplements (role behaviour only)"
  ];
  for (const block of homeSupplements) {
    const trimmed = block.trim();
    if (trimmed) parts.push(trimmed, "");
  }
  return parts.join("\n").trimEnd() + "\n";
}
