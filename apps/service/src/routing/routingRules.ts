/**
 * Ordered, explainable routing rules (Task 38).
 *
 * Inspired by NextClaw bindings (first match wins) — adapted to PAW match
 * dimensions: taskType, project, capabilities, harness, security permissions.
 *
 * Manual agent designation is handled outside this module and always outranks
 * automatic rules unless the role violates permissions or is unavailable.
 */

import type { AgentRole, Harness, RolePermissions } from "../roles/roleService.js";
import type { TaskType } from "./roleRouterService.js";

/** Match dimensions for a single deterministic rule. */
export interface RoutingRuleMatch {
  /** When set, request.taskType must be one of these. */
  taskTypes?: TaskType[];
  /** When set, request.projectId must be one of these. */
  projectIds?: string[];
  /**
   * Capabilities the request must include (all listed caps required).
   * Empty / omitted = do not constrain by capability.
   */
  requiredCapabilities?: string[];
  /** Skills the target role must cover (all listed). */
  requiredSkills?: string[];
  /** Tools the target role must cover (all listed). */
  requiredTools?: string[];
  /** When set, role.harness must equal this value. */
  harness?: Harness;
  /**
   * Minimum permissions the target role must satisfy.
   * Role may be more permissive; never less.
   */
  minPermissions?: Partial<RolePermissions>;
}

export interface RoutingRule {
  id: string;
  name: string;
  /**
   * Explicit evaluation order. Lower runs first.
   * Ties break by id ascending for stability.
   */
  order: number;
  enabled: boolean;
  match: RoutingRuleMatch;
  /** Configured Agent Role id to select when the rule is the first valid hit. */
  roleId: string;
  /**
   * When the rule matches the request but the role is invalid/unavailable:
   * - continue (default): try the next rule
   * - pause: stop routing and surface the failure (no silent fallback)
   */
  onInvalid?: "continue" | "pause";
}

export interface RoutingRuleInput {
  id?: string;
  name: string;
  order: number;
  enabled?: boolean;
  match?: RoutingRuleMatch;
  roleId: string;
  onInvalid?: "continue" | "pause";
}

/** Request slice used only for rule matching (not full route verification). */
export interface RuleMatchContext {
  taskType?: TaskType;
  projectId?: string;
  requiredCapabilities?: string[];
  requiredSkills?: string[];
  requiredTools?: string[];
  preferredHarness?: Harness;
  requiredPermissions?: Partial<RolePermissions>;
}

export type RuleMatchResult = "matched" | "no_match" | "disabled";

export interface RuleEvaluation {
  ruleId: string;
  ruleName: string;
  order: number;
  matchResult: RuleMatchResult;
  /** Why the request did not match this rule (match phase). */
  matchRejectReasons: string[];
  /** Role looked up for a matched rule. */
  roleId: string;
  roleName?: string;
  /** Whether the matched role passed structural eligibility. */
  roleEligible?: boolean;
  /** Why the role was rejected after match (permissions, disabled, missing, harness…). */
  roleRejectReasons: string[];
  /** True only for the first fully valid rule. */
  selected: boolean;
  /** True when onInvalid=pause stopped the chain. */
  paused?: boolean;
}

export interface RuleEvaluationResult {
  /** First fully valid rule, if any. */
  matchedRule?: RoutingRule;
  matchedRole?: AgentRole;
  evaluations: RuleEvaluation[];
  /**
   * How evaluation ended when no rule was selected:
   * - no_rules / none_matched / none_eligible / paused_on_invalid
   */
  fallbackCode:
    | "rule_selected"
    | "no_rules"
    | "none_matched"
    | "none_eligible"
    | "paused_on_invalid";
  fallbackReason: string;
  /** Set when a matched rule requested pause on invalid role. */
  paused?: {
    ruleId: string;
    ruleName: string;
    reason: string;
  };
}

// ---------------------------------------------------------------------------
// Rule store helpers (pure)
// ---------------------------------------------------------------------------

export function sortRules(rules: RoutingRule[]): RoutingRule[] {
  return [...rules].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.id.localeCompare(b.id);
  });
}

export function normalizeRoutingRule(input: RoutingRuleInput, id: string): RoutingRule {
  const name = input.name?.trim();
  if (!name) throw new Error("Routing rule name is required.");
  if (typeof input.order !== "number" || !Number.isFinite(input.order)) {
    throw new Error("Routing rule order must be a finite number.");
  }
  const roleId = input.roleId?.trim();
  if (!roleId) throw new Error("Routing rule roleId is required.");

  return {
    id,
    name,
    order: input.order,
    enabled: input.enabled !== false,
    match: normalizeMatch(input.match),
    roleId,
    onInvalid: input.onInvalid === "pause" ? "pause" : "continue"
  };
}

function normalizeMatch(match?: RoutingRuleMatch): RoutingRuleMatch {
  if (!match) return {};
  return {
    taskTypes: normalizeStringList(match.taskTypes) as TaskType[] | undefined,
    projectIds: normalizeStringList(match.projectIds),
    requiredCapabilities: normalizeStringList(match.requiredCapabilities),
    requiredSkills: normalizeStringList(match.requiredSkills),
    requiredTools: normalizeStringList(match.requiredTools),
    harness: match.harness === "api" || match.harness === "codex-cli" ? match.harness : undefined,
    minPermissions: match.minPermissions ? { ...match.minPermissions } : undefined
  };
}

function normalizeStringList(values?: string[]): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const out = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Evaluation — first valid rule wins
// ---------------------------------------------------------------------------

/**
 * Evaluate rules in deterministic order.
 * The first rule that (1) matches the request and (2) has an eligible role wins.
 * Subsequent rules are still recorded for explainability but not selected.
 */
export function evaluateRoutingRules(
  rules: RoutingRule[],
  context: RuleMatchContext,
  roles: AgentRole[]
): RuleEvaluationResult {
  const ordered = sortRules(rules);
  if (ordered.length === 0) {
    return {
      evaluations: [],
      fallbackCode: "no_rules",
      fallbackReason: "没有配置路由规则；将使用自动角色匹配作为 fallback。"
    };
  }

  const roleById = new Map(roles.map((r) => [r.id, r]));
  const evaluations: RuleEvaluation[] = [];
  let matchedRule: RoutingRule | undefined;
  let matchedRole: AgentRole | undefined;
  let paused: RuleEvaluationResult["paused"];
  let sawMatch = false;

  for (const rule of ordered) {
    if (matchedRule || paused) {
      // Still record remaining rules as not evaluated for selection.
      evaluations.push({
        ruleId: rule.id,
        ruleName: rule.name,
        order: rule.order,
        matchResult: rule.enabled ? "no_match" : "disabled",
        matchRejectReasons: matchedRule
          ? [`已有更高优先级规则命中（${matchedRule.name}），跳过`]
          : ["先前规则已暂停路由，跳过"],
        roleId: rule.roleId,
        roleRejectReasons: [],
        selected: false
      });
      continue;
    }

    if (!rule.enabled) {
      evaluations.push({
        ruleId: rule.id,
        ruleName: rule.name,
        order: rule.order,
        matchResult: "disabled",
        matchRejectReasons: ["规则已停用"],
        roleId: rule.roleId,
        roleRejectReasons: [],
        selected: false
      });
      continue;
    }

    const matchRejects = matchRuleAgainstContext(rule, context);
    if (matchRejects.length > 0) {
      evaluations.push({
        ruleId: rule.id,
        ruleName: rule.name,
        order: rule.order,
        matchResult: "no_match",
        matchRejectReasons: matchRejects,
        roleId: rule.roleId,
        roleRejectReasons: [],
        selected: false
      });
      continue;
    }

    sawMatch = true;
    const role = roleById.get(rule.roleId);
    const roleRejects = role ? roleEligibilityRejects(role, rule, context) : ["目标角色不存在"];
    const roleEligible = roleRejects.length === 0;

    if (roleEligible && role) {
      evaluations.push({
        ruleId: rule.id,
        ruleName: rule.name,
        order: rule.order,
        matchResult: "matched",
        matchRejectReasons: [],
        roleId: rule.roleId,
        roleName: role.name,
        roleEligible: true,
        roleRejectReasons: [],
        selected: true
      });
      matchedRule = rule;
      matchedRole = role;
      continue;
    }

    const onInvalid = rule.onInvalid ?? "continue";
    if (onInvalid === "pause") {
      const reason = `规则「${rule.name}」命中但角色无效：${roleRejects.join("；")}；按 onInvalid=pause 暂停，不继续 fallback。`;
      evaluations.push({
        ruleId: rule.id,
        ruleName: rule.name,
        order: rule.order,
        matchResult: "matched",
        matchRejectReasons: [],
        roleId: rule.roleId,
        roleName: role?.name,
        roleEligible: false,
        roleRejectReasons: roleRejects,
        selected: false,
        paused: true
      });
      paused = { ruleId: rule.id, ruleName: rule.name, reason };
      continue;
    }

    evaluations.push({
      ruleId: rule.id,
      ruleName: rule.name,
      order: rule.order,
      matchResult: "matched",
      matchRejectReasons: [],
      roleId: rule.roleId,
      roleName: role?.name,
      roleEligible: false,
      roleRejectReasons: roleRejects,
      selected: false
    });
  }

  if (matchedRule && matchedRole) {
    return {
      matchedRule,
      matchedRole,
      evaluations,
      fallbackCode: "rule_selected",
      fallbackReason: `命中规则「${matchedRule.name}」(order=${matchedRule.order}) → 角色「${matchedRole.name}」。`
    };
  }

  if (paused) {
    return {
      evaluations,
      fallbackCode: "paused_on_invalid",
      fallbackReason: paused.reason,
      paused
    };
  }

  if (!sawMatch) {
    return {
      evaluations,
      fallbackCode: "none_matched",
      fallbackReason: "没有规则匹配当前任务类型 / Project / 能力 / Harness / 权限条件；将使用自动角色匹配作为 fallback。"
    };
  }

  return {
    evaluations,
    fallbackCode: "none_eligible",
    fallbackReason: "有规则匹配请求，但目标角色均不可用或权限不足；将使用自动角色匹配作为 fallback。"
  };
}

// ---------------------------------------------------------------------------
// Match + eligibility
// ---------------------------------------------------------------------------

export function matchRuleAgainstContext(rule: RoutingRule, context: RuleMatchContext): string[] {
  const rejects: string[] = [];
  const m = rule.match;

  if (m.taskTypes && m.taskTypes.length > 0) {
    if (!context.taskType || !m.taskTypes.includes(context.taskType)) {
      rejects.push(
        `taskType 不匹配（规则: ${m.taskTypes.join("|")}，请求: ${context.taskType ?? "∅"}）`
      );
    }
  }

  if (m.projectIds && m.projectIds.length > 0) {
    const projectId = context.projectId?.trim();
    const allowed = new Set(m.projectIds.map((p) => p.trim().toLowerCase()));
    if (!projectId || !allowed.has(projectId.toLowerCase())) {
      rejects.push(
        `projectId 不匹配（规则: ${m.projectIds.join("|")}，请求: ${projectId ?? "∅"}）`
      );
    }
  }

  if (m.requiredCapabilities && m.requiredCapabilities.length > 0) {
    const caps = new Set((context.requiredCapabilities ?? []).map((c) => c.toLowerCase()));
    const missing = m.requiredCapabilities.filter((c) => !caps.has(c.toLowerCase()));
    if (missing.length > 0) {
      rejects.push(`请求缺少能力: ${missing.join(", ")}`);
    }
  }

  if (m.requiredSkills && m.requiredSkills.length > 0) {
    const skills = new Set((context.requiredSkills ?? []).map((s) => s.toLowerCase()));
    // Skills may also be implied only on the role; for match phase we only check request when provided.
    // If request lists requiredSkills, they must include rule's requiredSkills.
    if (context.requiredSkills && context.requiredSkills.length > 0) {
      const missing = m.requiredSkills.filter((s) => !skills.has(s.toLowerCase()));
      if (missing.length > 0) {
        rejects.push(`请求 Skills 不满足规则: ${missing.join(", ")}`);
      }
    }
  }

  if (m.harness) {
    // Prefer request preferredHarness; if omitted, rule still matches (harness checked on role).
    if (context.preferredHarness && context.preferredHarness !== m.harness) {
      rejects.push(`Harness 不匹配（规则: ${m.harness}，请求: ${context.preferredHarness}）`);
    }
  }

  if (m.minPermissions && context.requiredPermissions) {
    const permRejects = permissionInsufficient(context.requiredPermissions, m.minPermissions, "请求权限");
    rejects.push(...permRejects);
  }

  return rejects;
}

/**
 * Structural eligibility of a role for a matched rule (no live connection probe).
 */
export function roleEligibilityRejects(
  role: AgentRole,
  rule: RoutingRule,
  context: RuleMatchContext
): string[] {
  const rejects: string[] = [];
  if (!role.enabled) rejects.push("角色已停用");

  const m = rule.match;
  if (m.harness && role.harness !== m.harness) {
    rejects.push(`角色 Harness 不匹配（需要 ${m.harness}，角色为 ${role.harness}）`);
  }
  if (context.preferredHarness && role.harness !== context.preferredHarness) {
    rejects.push(`角色 Harness 与请求 preferredHarness 不符（${role.harness} ≠ ${context.preferredHarness}）`);
  }

  if (m.requiredSkills && m.requiredSkills.length > 0) {
    const missing = m.requiredSkills.filter((s) => !role.skills.includes(s));
    if (missing.length > 0) rejects.push(`角色缺少 Skills: ${missing.join(", ")}`);
  }
  if (m.requiredTools && m.requiredTools.length > 0) {
    const missing = m.requiredTools.filter((t) => !role.tools.includes(t));
    if (missing.length > 0) rejects.push(`角色缺少 Tools: ${missing.join(", ")}`);
  }

  // Request-level skills/tools (from capabilities) when present on context.
  if (context.requiredSkills && context.requiredSkills.length > 0) {
    const missing = context.requiredSkills.filter((s) => !role.skills.includes(s));
    if (missing.length > 0) rejects.push(`角色未覆盖请求 Skills: ${missing.join(", ")}`);
  }
  if (context.requiredTools && context.requiredTools.length > 0) {
    const missing = context.requiredTools.filter((t) => !role.tools.includes(t));
    if (missing.length > 0) rejects.push(`角色未覆盖请求 Tools: ${missing.join(", ")}`);
  }

  if (m.minPermissions) {
    rejects.push(...permissionInsufficient(m.minPermissions, role.permissions, "角色权限"));
  }
  if (context.requiredPermissions) {
    rejects.push(...permissionInsufficient(context.requiredPermissions, role.permissions, "角色权限"));
  }

  return rejects;
}

/**
 * `holder` must satisfy every constraint in `needed`.
 * For booleans: needed=true requires holder=true.
 * For workspace: project_only needed rejects read_only holder.
 */
export function permissionInsufficient(
  needed: Partial<RolePermissions>,
  holder: Partial<RolePermissions> | RolePermissions,
  label: string
): string[] {
  const rejects: string[] = [];
  if (needed.shell === true && holder.shell !== true) {
    rejects.push(`${label}不足：需要 shell`);
  }
  if (needed.network === true && holder.network !== true) {
    rejects.push(`${label}不足：需要 network`);
  }
  if (needed.externalSend === true && holder.externalSend !== true) {
    rejects.push(`${label}不足：需要 externalSend`);
  }
  if (needed.workspace === "project_only" && holder.workspace === "read_only") {
    rejects.push(`${label}不足：需要 project_only 工作区写入`);
  }
  return rejects;
}

/**
 * Manual designation validation: user-specified role outranks rules unless
 * disabled / permission-insufficient relative to the request.
 */
export function manualOverrideRejects(
  role: AgentRole,
  context: RuleMatchContext
): string[] {
  const rejects: string[] = [];
  if (!role.enabled) rejects.push("角色已停用");
  if (context.preferredHarness && role.harness !== context.preferredHarness) {
    rejects.push(`Harness 不符（需要 ${context.preferredHarness}，角色为 ${role.harness}）`);
  }
  if (context.requiredSkills) {
    const missing = context.requiredSkills.filter((s) => !role.skills.includes(s));
    if (missing.length > 0) rejects.push(`缺少 Skills: ${missing.join(", ")}`);
  }
  if (context.requiredTools) {
    const missing = context.requiredTools.filter((t) => !role.tools.includes(t));
    if (missing.length > 0) rejects.push(`缺少 Tools: ${missing.join(", ")}`);
  }
  if (context.requiredPermissions) {
    rejects.push(...permissionInsufficient(context.requiredPermissions, role.permissions, "权限"));
  }
  return rejects;
}
