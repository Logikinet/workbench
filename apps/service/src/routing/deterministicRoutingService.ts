/**
 * Deterministic routing + session isolation (Task 38).
 *
 * Builds on RoleRouterService (Task 20):
 * 1. Manual agent designation outranks automatic rules (unless invalid → pause).
 * 2. Ordered routing rules: first valid hit wins; explainable evaluations.
 * 3. Fallback to capability auto-rank / temporary role when no rule wins.
 * 4. Session scopes (global/project/run/subtask/reviewer) with no cross-leak.
 * 5. Session-local tags / preferred model / temporary instructions never mutate Roles.
 *
 * Does not edit app.ts / sessions package (sessions may be imported read-only).
 */

import { randomUUID } from "node:crypto";
import type { AgentRole, RoleService } from "../roles/roleService.js";
import {
  evaluateRoutingRules,
  manualOverrideRejects,
  normalizeRoutingRule,
  sortRules,
  type RuleEvaluation,
  type RoutingRule,
  type RoutingRuleInput,
  type RuleMatchContext
} from "./routingRules.js";
import {
  RoleRouterService,
  type OverrideInput,
  type RouteRequest,
  type RoutingDecision,
  type ConfirmTemporaryInput
} from "./roleRouterService.js";
import {
  assertNoCrossLeak,
  buildSessionKey,
  canShareContext,
  createSessionLocalConfig,
  filterContextForScope,
  resolveSessionModelId,
  type ContextShareDecision,
  type CreateSessionLocalInput,
  type SessionLocalConfig,
  type SessionScopeRef
} from "./sessionScopes.js";

export type SelectionMode =
  | "manual"
  | "rule"
  | "auto_rank"
  | "temporary"
  | "paused"
  | "fallback";

export interface SelectionTrace {
  mode: SelectionMode;
  /** Hit rule when mode === "rule". */
  matchedRuleId?: string;
  matchedRuleName?: string;
  matchedRuleOrder?: number;
  /** Full ordered rule evaluation log. */
  ruleEvaluations: RuleEvaluation[];
  /** Candidate role ids considered by the underlying auto router (when used). */
  candidateRoleIds: string[];
  /** Aggregated reject reasons for explainability. */
  rejectReasons: string[];
  /** Final human-readable selection reason. */
  finalReason: string;
  fallbackCode?: string;
  fallbackReason?: string;
}

export interface DeterministicRouteRequest extends RouteRequest {
  projectId?: string;
  /** Strict session scope for isolation + session key. */
  sessionScope?: SessionScopeRef;
  clientProfileId?: string;
  /** Session-only settings — never written to Role library. */
  sessionLocal?: CreateSessionLocalInput;
  /**
   * When true (default), manual explicitRoleId is validated against request
   * permissions; violation pauses instead of falling through to rules.
   */
  enforceManualPermissions?: boolean;
}

export interface DeterministicRoutingDecision extends RoutingDecision {
  selectionTrace: SelectionTrace;
  sessionKey?: string;
  sessionScope?: SessionScopeRef;
  /** Session-local tags / model / temporary instructions snapshot. */
  sessionLocal: SessionLocalConfig;
  /** Project id from the request (for isolation / audit). */
  projectId?: string;
  clientProfileId?: string;
}

export interface DeterministicRoutingServiceOptions {
  roles: RoleService;
  roleRouter: RoleRouterService;
  /** Initial ordered rules (optional). */
  rules?: RoutingRule[];
  now?: () => Date;
}

export class DeterministicRoutingService {
  private readonly rules = new Map<string, RoutingRule>();
  private readonly decisions = new Map<string, DeterministicRoutingDecision>();
  private readonly now: () => Date;

  constructor(private readonly options: DeterministicRoutingServiceOptions) {
    this.now = options.now ?? (() => new Date());
    for (const rule of options.rules ?? []) {
      this.rules.set(rule.id, rule);
    }
  }

  // ---------------------------------------------------------------------------
  // Rule CRUD (deterministic config)
  // ---------------------------------------------------------------------------

  listRules(): RoutingRule[] {
    return sortRules([...this.rules.values()]).map(cloneRule);
  }

  getRule(ruleId: string): RoutingRule {
    const rule = this.rules.get(ruleId);
    if (!rule) throw new Error(`Routing rule ${ruleId} was not found.`);
    return cloneRule(rule);
  }

  upsertRule(input: RoutingRuleInput): RoutingRule {
    const id = input.id?.trim() || randomUUID();
    const rule = normalizeRoutingRule(input, id);
    this.rules.set(rule.id, rule);
    return cloneRule(rule);
  }

  deleteRule(ruleId: string): { deleted: true; id: string } {
    if (!this.rules.has(ruleId)) throw new Error(`Routing rule ${ruleId} was not found.`);
    this.rules.delete(ruleId);
    return { deleted: true, id: ruleId };
  }

  replaceRules(rules: RoutingRuleInput[]): RoutingRule[] {
    this.rules.clear();
    for (const input of rules) {
      this.upsertRule(input);
    }
    return this.listRules();
  }

  // ---------------------------------------------------------------------------
  // Session isolation (read-only policy surface)
  // ---------------------------------------------------------------------------

  buildSessionKey(scope: SessionScopeRef): string {
    return buildSessionKey(scope);
  }

  canShareContext(from: SessionScopeRef, to: SessionScopeRef): ContextShareDecision {
    return canShareContext(from, to);
  }

  assertNoCrossLeak(from: SessionScopeRef, to: SessionScopeRef): void {
    assertNoCrossLeak(from, to);
  }

  filterContextForScope<T extends Record<string, unknown>>(
    scope: SessionScopeRef,
    context: T,
    options?: { includePrivateMemory?: boolean }
  ): Partial<T> {
    return filterContextForScope(scope, context, options);
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  async route(request: DeterministicRouteRequest): Promise<DeterministicRoutingDecision> {
    const sessionLocal = createSessionLocalConfig(request.sessionLocal);
    const sessionScope = resolveSessionScope(request);
    const sessionKey = sessionScope ? buildSessionKey(sessionScope) : undefined;
    const matchContext = toMatchContext(request);
    const roles = await this.options.roles.list();
    const ruleList = this.listRules();

    // 1) Manual designation — highest priority (unless invalid).
    if (request.explicitRoleId) {
      return this.routeManual(request, roles, matchContext, sessionLocal, sessionScope, sessionKey, ruleList);
    }

    // 2) Ordered rules — first valid wins.
    const ruleResult = evaluateRoutingRules(ruleList, matchContext, roles);

    if (ruleResult.fallbackCode === "paused_on_invalid" && ruleResult.paused) {
      return this.buildPausedDecision(
        request,
        ruleResult.paused.reason,
        ruleResult.evaluations,
        sessionLocal,
        sessionScope,
        sessionKey,
        "paused",
        ruleResult.fallbackCode,
        ruleResult.fallbackReason
      );
    }

    if (ruleResult.matchedRule && ruleResult.matchedRole) {
      const decision = await this.options.roleRouter.route({
        ...stripDeterministicFields(request),
        explicitRoleId: ruleResult.matchedRole.id,
        // Rule path still verifies availability when requested.
        verifyAvailability: request.verifyAvailability
      });

      // If explicit path paused (unavailable), surface as rule pause with evaluations.
      const instance = decision.instances[0];
      const mode: SelectionMode = instance?.status === "paused" ? "paused" : "rule";
      const finalReason =
        instance?.status === "paused"
          ? `规则「${ruleResult.matchedRule.name}」命中角色「${ruleResult.matchedRole.name}」但不可用：${instance.reason}`
          : `${ruleResult.fallbackReason} ${instance?.reason ?? ""}`.trim();

      return this.wrapDecision(decision, {
        request,
        sessionLocal,
        sessionScope,
        sessionKey,
        trace: {
          mode,
          matchedRuleId: ruleResult.matchedRule.id,
          matchedRuleName: ruleResult.matchedRule.name,
          matchedRuleOrder: ruleResult.matchedRule.order,
          ruleEvaluations: ruleResult.evaluations,
          candidateRoleIds: collectCandidateIds(decision),
          rejectReasons: collectRejectReasons(decision, ruleResult.evaluations),
          finalReason,
          fallbackCode: ruleResult.fallbackCode,
          fallbackReason: ruleResult.fallbackReason
        }
      });
    }

    // 3) Fallback: auto-rank / temporary via RoleRouterService.
    const decision = await this.options.roleRouter.route(stripDeterministicFields(request));
    const instance = decision.instances[0];
    let mode: SelectionMode = "auto_rank";
    if (instance?.status === "temporary") mode = "temporary";
    if (instance?.status === "paused") mode = "paused";
    if (instance?.status === "user_specified" || instance?.status === "user_override") mode = "manual";

    const finalReason = [
      ruleResult.fallbackReason,
      instance?.reason ?? decision.explanation
    ]
      .filter(Boolean)
      .join(" ");

    return this.wrapDecision(decision, {
      request,
      sessionLocal,
      sessionScope,
      sessionKey,
      trace: {
        mode: mode === "auto_rank" && !instance?.selection ? "fallback" : mode,
        ruleEvaluations: ruleResult.evaluations,
        candidateRoleIds: collectCandidateIds(decision),
        rejectReasons: collectRejectReasons(decision, ruleResult.evaluations),
        finalReason,
        fallbackCode: ruleResult.fallbackCode,
        fallbackReason: ruleResult.fallbackReason
      }
    });
  }

  async override(
    decisionId: string,
    input: OverrideInput
  ): Promise<DeterministicRoutingDecision> {
    const existing = this.requireDecision(decisionId);
    const updated = await this.options.roleRouter.override(existing.id, input);
    const instance = updated.instances[0];
    const mode: SelectionMode = instance?.status === "paused" ? "paused" : "manual";
    const wrapped = this.wrapDecision(updated, {
      request: {
        runId: existing.runId,
        todoId: existing.todoId,
        projectId: existing.projectId,
        clientProfileId: existing.clientProfileId
      },
      sessionLocal: existing.sessionLocal,
      sessionScope: existing.sessionScope,
      sessionKey: existing.sessionKey,
      trace: {
        mode,
        matchedRuleId: existing.selectionTrace.matchedRuleId,
        matchedRuleName: existing.selectionTrace.matchedRuleName,
        matchedRuleOrder: existing.selectionTrace.matchedRuleOrder,
        ruleEvaluations: existing.selectionTrace.ruleEvaluations,
        candidateRoleIds: collectCandidateIds(updated),
        rejectReasons: [
          ...existing.selectionTrace.rejectReasons,
          ...(instance?.status === "paused" ? [instance.reason] : [])
        ],
        finalReason: instance?.reason ?? "用户覆盖选择。",
        fallbackCode: existing.selectionTrace.fallbackCode,
        fallbackReason: existing.selectionTrace.fallbackReason
      },
      preserveId: existing.id
    });
    return wrapped;
  }

  async confirmTemporaryAsLongTerm(
    decisionId: string,
    input: ConfirmTemporaryInput
  ): Promise<{ decision: DeterministicRoutingDecision; role: AgentRole }> {
    const existing = this.requireDecision(decisionId);
    const result = await this.options.roleRouter.confirmTemporaryAsLongTerm(existing.id, input);
    const wrapped = this.wrapDecision(result.decision, {
      request: {
        runId: existing.runId,
        todoId: existing.todoId,
        projectId: existing.projectId,
        clientProfileId: existing.clientProfileId
      },
      sessionLocal: existing.sessionLocal,
      sessionScope: existing.sessionScope,
      sessionKey: existing.sessionKey,
      trace: {
        ...existing.selectionTrace,
        finalReason: `临时角色已确认写入长期库：${result.role.name}`,
        mode: "temporary"
      },
      preserveId: existing.id
    });
    return { decision: wrapped, role: result.role };
  }

  getDecision(decisionId: string): DeterministicRoutingDecision {
    return cloneDecision(this.requireDecision(decisionId));
  }

  listDecisions(): DeterministicRoutingDecision[] {
    return [...this.decisions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(cloneDecision);
  }

  /** Underlying Task 20 router (for advanced callers). */
  get roleRouter(): RoleRouterService {
    return this.options.roleRouter;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async routeManual(
    request: DeterministicRouteRequest,
    roles: AgentRole[],
    matchContext: RuleMatchContext,
    sessionLocal: SessionLocalConfig,
    sessionScope: SessionScopeRef | undefined,
    sessionKey: string | undefined,
    ruleList: RoutingRule[]
  ): Promise<DeterministicRoutingDecision> {
    const roleId = request.explicitRoleId!;
    let role: AgentRole | undefined;
    try {
      role = await this.options.roles.get(roleId);
    } catch {
      role = undefined;
    }

    const enforce = request.enforceManualPermissions !== false;
    const structuralRejects =
      role && enforce ? manualOverrideRejects(role, matchContext) : role ? [] : ["角色不存在"];

    // Still record rule evaluations for audit (none selected under manual).
    const ruleResult = evaluateRoutingRules(ruleList, matchContext, roles);
    const ruleSkipNote = "用户手动指定优先于自动规则，规则未用于最终选择。";

    if (!role || structuralRejects.length > 0) {
      const reason = !role
        ? `用户指定的角色 ${roleId} 不存在或不可用；已暂停，不回退到自动规则。`
        : `用户指定的角色「${role.name}」违反权限/约束：${structuralRejects.join("；")}；已暂停，不回退到自动规则。`;

      return this.buildPausedDecision(
        request,
        reason,
        ruleResult.evaluations.map((e) => ({
          ...e,
          selected: false,
          matchRejectReasons: e.selected
            ? [...e.matchRejectReasons, ruleSkipNote]
            : e.matchRejectReasons
        })),
        sessionLocal,
        sessionScope,
        sessionKey,
        "paused",
        "manual_rejected",
        reason
      );
    }

    const decision = await this.options.roleRouter.route({
      ...stripDeterministicFields(request),
      explicitRoleId: role.id
    });

    const instance = decision.instances[0];
    const mode: SelectionMode = instance?.status === "paused" ? "paused" : "manual";
    const finalReason =
      instance?.status === "paused"
        ? instance.reason
        : `用户手动指定角色「${role.name}」优先于自动规则；${instance?.reason ?? ""}`.trim();

    return this.wrapDecision(decision, {
      request,
      sessionLocal,
      sessionScope,
      sessionKey,
      trace: {
        mode,
        ruleEvaluations: ruleResult.evaluations.map((e) => ({
          ...e,
          selected: false,
          matchRejectReasons: [...e.matchRejectReasons, ruleSkipNote]
        })),
        candidateRoleIds: collectCandidateIds(decision),
        rejectReasons:
          instance?.status === "paused"
            ? [instance.reason]
            : ruleResult.evaluations.flatMap((e) => e.roleRejectReasons),
        finalReason,
        fallbackCode: "manual_priority",
        fallbackReason: "手动指定优先，未使用规则链。"
      }
    });
  }

  private async buildPausedDecision(
    request: DeterministicRouteRequest,
    reason: string,
    evaluations: RuleEvaluation[],
    sessionLocal: SessionLocalConfig,
    sessionScope: SessionScopeRef | undefined,
    sessionKey: string | undefined,
    mode: SelectionMode,
    fallbackCode: string,
    fallbackReason: string
  ): Promise<DeterministicRoutingDecision> {
    // Route a benign auto path with verify off then overwrite — simpler: synthesize via router without explicit.
    const base = await this.options.roleRouter.route({
      runId: request.runId,
      todoId: request.todoId,
      taskType: request.taskType,
      complexity: request.complexity ?? "low",
      requiredCapabilities: request.requiredCapabilities,
      planApproved: request.planApproved,
      verifyAvailability: false,
      defaultConnectionId: request.defaultConnectionId,
      defaultModelId: request.defaultModelId
    });

    // Force pause on all instances for isolation of this path.
    for (const instance of base.instances) {
      instance.status = "paused";
      instance.selection = undefined;
      instance.pauseCode = "role_unavailable";
      instance.pauseReason = reason;
      instance.reason = reason;
    }

    return this.wrapDecision(base, {
      request,
      sessionLocal,
      sessionScope,
      sessionKey,
      trace: {
        mode,
        ruleEvaluations: evaluations,
        candidateRoleIds: collectCandidateIds(base),
        rejectReasons: [reason],
        finalReason: reason,
        fallbackCode,
        fallbackReason
      }
    });
  }

  private wrapDecision(
    decision: RoutingDecision,
    args: {
      request: Pick<
        DeterministicRouteRequest,
        "runId" | "todoId" | "projectId" | "clientProfileId" | "sessionLocal"
      > &
        Partial<DeterministicRouteRequest>;
      sessionLocal: SessionLocalConfig;
      sessionScope?: SessionScopeRef;
      sessionKey?: string;
      trace: SelectionTrace;
      preserveId?: string;
    }
  ): DeterministicRoutingDecision {
    // Apply session-local preferred model onto selection summaries (not Role records).
    const instances = decision.instances.map((instance) => {
      if (!instance.selection) return instance;
      const modelId = resolveSessionModelId(instance.selection.modelId, args.sessionLocal);
      const systemInstruction = mergeTemporaryInstructions(
        instance.selection.systemInstruction,
        args.sessionLocal.temporaryInstructions
      );
      return {
        ...instance,
        selection: {
          ...instance.selection,
          modelId,
          systemInstruction
        }
      };
    });

    const wrapped: DeterministicRoutingDecision = {
      ...decision,
      id: args.preserveId ?? decision.id,
      instances,
      queuePayload: {
        ...decision.queuePayload,
        decisionId: args.preserveId ?? decision.id,
        selections: decision.queuePayload.selections.map((sel) => {
          const inst = instances.find((i) => i.instanceId === sel.instanceId);
          return {
            ...sel,
            modelId: inst?.selection?.modelId ?? sel.modelId,
            systemInstruction: inst?.selection?.systemInstruction ?? sel.systemInstruction
          };
        })
      },
      selectionTrace: args.trace,
      sessionKey: args.sessionKey,
      sessionScope: args.sessionScope,
      sessionLocal: args.sessionLocal,
      projectId: args.request.projectId,
      clientProfileId: args.request.clientProfileId,
      updatedAt: this.now().toISOString()
    };

    this.decisions.set(wrapped.id, wrapped);
    // Also keep id alignment: RoleRouter uses its own id; we re-key under same id for getDecision.
    return cloneDecision(wrapped);
  }

  private requireDecision(decisionId: string): DeterministicRoutingDecision {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new Error(`Routing decision ${decisionId} was not found.`);
    return decision;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function resolveSessionScope(request: DeterministicRouteRequest): SessionScopeRef | undefined {
  if (request.sessionScope) {
    const scope: SessionScopeRef = {
      ...request.sessionScope,
      clientProfileId: request.sessionScope.clientProfileId ?? request.clientProfileId,
      projectId: request.sessionScope.projectId ?? request.projectId,
      runId: request.sessionScope.runId ?? request.runId
    };
    return scope;
  }
  // Infer a reasonable scope when enough ids are present.
  if (request.runId && request.projectId) {
    return {
      kind: "run",
      runId: request.runId,
      projectId: request.projectId,
      clientProfileId: request.clientProfileId
    };
  }
  if (request.projectId) {
    return {
      kind: "project_firstmate",
      projectId: request.projectId,
      clientProfileId: request.clientProfileId
    };
  }
  return undefined;
}

function toMatchContext(request: DeterministicRouteRequest): RuleMatchContext {
  return {
    taskType: request.taskType,
    projectId: request.projectId,
    requiredCapabilities: request.requiredCapabilities,
    requiredSkills: request.requiredSkills,
    requiredTools: request.requiredTools,
    preferredHarness: request.preferredHarness,
    requiredPermissions: request.requiredPermissions
  };
}

function stripDeterministicFields(request: DeterministicRouteRequest): RouteRequest {
  const {
    projectId: _p,
    sessionScope: _s,
    clientProfileId: _c,
    sessionLocal: _l,
    enforceManualPermissions: _e,
    ...rest
  } = request;
  return rest;
}

function collectCandidateIds(decision: RoutingDecision): string[] {
  const ids = new Set<string>();
  for (const instance of decision.instances) {
    for (const c of instance.candidates) ids.add(c.roleId);
    if (instance.selection?.roleId) ids.add(instance.selection.roleId);
  }
  return [...ids];
}

function collectRejectReasons(decision: RoutingDecision, evaluations: RuleEvaluation[]): string[] {
  const reasons: string[] = [];
  for (const evaluation of evaluations) {
    reasons.push(...evaluation.matchRejectReasons, ...evaluation.roleRejectReasons);
  }
  for (const instance of decision.instances) {
    for (const c of instance.candidates) {
      if (!c.eligible) reasons.push(...c.rejectReasons);
    }
    if (instance.pauseReason) reasons.push(instance.pauseReason);
  }
  return [...new Set(reasons.filter(Boolean))];
}

function mergeTemporaryInstructions(base: string, temporary?: string): string {
  if (!temporary?.trim()) return base;
  return `${base}\n\n[会话临时指令 — 仅本会话有效，不写入角色库]\n${temporary.trim()}`;
}

function cloneRule(rule: RoutingRule): RoutingRule {
  return structuredClone(rule);
}

function cloneDecision(decision: DeterministicRoutingDecision): DeterministicRoutingDecision {
  return structuredClone(decision);
}
