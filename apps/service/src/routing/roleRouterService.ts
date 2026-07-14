/**
 * Firstmate Role Router (Task 20).
 *
 * Selects configured Agent Roles for approved plans using deterministic matching
 * on capabilities / harness / skills / tools / permissions / enabled /
 * allowFirstmateAutoInvoke. Does not mutate formal files or start execution itself;
 * callers (main / queue / execution) consume RoutingDecision + queue payload.
 */

import { randomUUID } from "node:crypto";
import type { ConnectionService } from "../connections/connectionService.js";
import type {
  AgentRole,
  Harness,
  ReasoningEffort,
  RolePermissions,
  RoleService
} from "../roles/roleService.js";

export type PlanComplexity = "low" | "medium" | "high";

export type TaskType =
  | "implementation"
  | "bug_fix"
  | "research"
  | "writing"
  | "analysis"
  | "automation"
  | "other";

/** One logical work unit that needs a single role instance. */
export interface InstanceRequirement {
  /** Stable id within the plan (e.g. "primary", "research", step id). */
  id: string;
  name?: string;
  /** Free-form capabilities from Firstmate assessment (workspace, filesystem, tests, …). */
  capabilities?: string[];
  skills?: string[];
  tools?: string[];
  harness?: Harness;
  permissions?: Partial<RolePermissions>;
  /** Preferred reasoning for temporary role generation. */
  reasoningEffort?: ReasoningEffort;
  responsibilityHint?: string;
  systemInstructionHint?: string;
}

export interface RouteRequest {
  runId?: string;
  todoId?: string;
  taskType?: TaskType;
  complexity?: PlanComplexity;
  /** Flat capability list when the plan does not split instances. */
  requiredCapabilities?: string[];
  requiredSkills?: string[];
  requiredTools?: string[];
  preferredHarness?: Harness;
  requiredPermissions?: Partial<RolePermissions>;
  /**
   * Explicit user role choice. When set, Firstmate must not replace it with another
   * auto-matched role. If the role is unavailable, routing pauses (no auto-switch).
   */
  explicitRoleId?: string;
  /**
   * Optional multi-instance requirements for complex plans.
   * When omitted, the router derives instance count from complexity + capabilities.
   */
  instances?: InstanceRequirement[];
  /**
   * When true (plan just approved), mark decision eligible for auto-queue when all
   * instances are ready without user confirmation of temporary roles.
   */
  planApproved?: boolean;
  /**
   * When false, skip live connection probes (unit tests / dry-run). Default true
   * for production readiness checks.
   */
  verifyAvailability?: boolean;
  /** Optional default connection for temporary roles. */
  defaultConnectionId?: string;
  defaultModelId?: string;
}

export interface RoleMatchCandidate {
  roleId: string;
  name: string;
  modelId?: string;
  harness: Harness;
  connectionId?: string;
  score: number;
  matchReasons: string[];
  rejectReasons: string[];
  eligible: boolean;
}

export interface TemporaryRoleDraft {
  id: string;
  name: string;
  responsibility: string;
  systemInstruction: string;
  connectionId?: string;
  modelId?: string;
  harness: Harness;
  reasoningEffort: ReasoningEffort;
  skills: string[];
  tools: string[];
  permissions: RolePermissions;
  allowFirstmateAutoInvoke: boolean;
  /** True only after user confirms save to the long-term Role library. */
  confirmedForLongTerm: boolean;
  longTermRoleId?: string;
  createdAt: string;
}

export type InstanceRouteStatus =
  | "selected"
  | "temporary"
  | "user_specified"
  | "user_override"
  | "paused";

export type PauseCode =
  | "role_unavailable"
  | "quota_exhausted"
  | "login_failed"
  | "role_disabled"
  | "connection_disabled"
  | "explicit_role_missing"
  | "no_connection_for_temporary";

export interface SelectedRoleSummary {
  source: "role" | "temporary" | "user_specified" | "user_override";
  roleId?: string;
  temporaryRoleId?: string;
  name: string;
  modelId?: string;
  harness: Harness;
  connectionId?: string;
  skills: string[];
  tools: string[];
  permissions: RolePermissions;
  reasoningEffort: ReasoningEffort;
  systemInstruction: string;
  responsibility: string;
  allowFirstmateAutoInvoke: boolean;
}

export interface RoutedInstance {
  instanceId: string;
  instanceName: string;
  status: InstanceRouteStatus;
  selection?: SelectedRoleSummary;
  /** Human-readable Firstmate reason for the choice (shown before execute / override). */
  reason: string;
  candidates: RoleMatchCandidate[];
  temporaryRole?: TemporaryRoleDraft;
  pauseReason?: string;
  pauseCode?: PauseCode;
  requirement: InstanceRequirement;
}

export interface RoutingDecision {
  id: string;
  runId?: string;
  todoId?: string;
  taskType?: TaskType;
  complexity: PlanComplexity;
  createdAt: string;
  updatedAt: string;
  instances: RoutedInstance[];
  /**
   * True when plan is approved, every instance has a ready selection, and no
   * temporary role is waiting for long-term confirmation before auto-queue.
   * Temporary roles may still execute for this Run without long-term save.
   */
  canAutoQueue: boolean;
  autoQueueBlockedReason?: string;
  explanation: string;
  /** Payload main/queue can use to start execution without another manual pick. */
  queuePayload: AutoQueuePayload;
}

export interface AutoQueuePayload {
  decisionId: string;
  runId?: string;
  planApproved: boolean;
  selections: Array<{
    instanceId: string;
    roleId?: string;
    temporaryRoleId?: string;
    source: SelectedRoleSummary["source"];
    name: string;
    harness: Harness;
    modelId?: string;
    connectionId?: string;
    skills: string[];
    tools: string[];
    permissions: RolePermissions;
    systemInstruction: string;
    responsibility: string;
  }>;
}

export interface OverrideInput {
  /** Target instance; defaults to the only instance when there is one. */
  instanceId?: string;
  roleId: string;
}

export interface ConfirmTemporaryInput {
  temporaryRoleId: string;
  /** Optional name override when saving into the long-term library. */
  name?: string;
  /** Must be true — temporary roles never enter the long-term library silently. */
  confirm: boolean;
}

export interface RoleRouterServiceOptions {
  roles: RoleService;
  connections?: ConnectionService;
  /** Optional clock for tests. */
  now?: () => Date;
}

const CAPABILITY_SKILL_MAP: Record<string, string[]> = {
  workspace: [],
  filesystem: [],
  shell: [],
  tests: ["tdd", "implement"],
  tdd: ["tdd"],
  implement: ["implement"],
  implementation: ["implement"],
  research: ["research"],
  documents: ["documents"],
  writing: ["documents"],
  analysis: ["research", "documents"],
  code_review: ["code-review"],
  review: ["code-review"],
  skill_creator: ["skill-creator"]
};

const CAPABILITY_TOOL_MAP: Record<string, string[]> = {
  workspace: ["filesystem"],
  filesystem: ["filesystem"],
  shell: ["shell"],
  tests: ["filesystem", "shell"],
  web: ["web"],
  git: ["git"],
  network: ["web"],
  "model-api": ["model-api"],
  "codex-cli": ["codex-cli"],
  research: ["filesystem"],
  documents: ["filesystem"],
  implement: ["filesystem", "shell"],
  implementation: ["filesystem", "shell"],
  automation: ["filesystem", "shell"]
};

const CODE_TASK_TYPES = new Set<TaskType>(["implementation", "bug_fix", "automation"]);

/**
 * Deterministic Firstmate role router.
 * Pure selection + temporary draft + override/confirm APIs.
 * Does not edit Run state, planning, or app.ts.
 */
export class RoleRouterService {
  private readonly decisions = new Map<string, RoutingDecision>();
  private readonly temporaryRoles = new Map<string, TemporaryRoleDraft>();
  private readonly now: () => Date;

  constructor(private readonly options: RoleRouterServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Route roles for a (typically plan-approved) task. */
  async route(request: RouteRequest): Promise<RoutingDecision> {
    const complexity = request.complexity ?? "medium";
    const instanceReqs = deriveInstances(request, complexity);
    const roles = await this.options.roles.list();
    const instances: RoutedInstance[] = [];

    for (const req of instanceReqs) {
      if (request.explicitRoleId) {
        instances.push(await this.routeExplicit(request.explicitRoleId, req, request));
        continue;
      }
      instances.push(await this.routeAuto(roles, req, request));
    }

    return this.persistDecision(request, complexity, instances);
  }

  getDecision(decisionId: string): RoutingDecision {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new Error(`Routing decision ${decisionId} was not found.`);
    return cloneDecision(decision);
  }

  listDecisions(): RoutingDecision[] {
    return [...this.decisions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(cloneDecision);
  }

  /**
   * User override before execution. Replaces the selected role for one instance.
   * Does not auto-switch away from the override when verification fails — pauses instead.
   */
  async override(decisionId: string, input: OverrideInput): Promise<RoutingDecision> {
    const decision = this.requireDecision(decisionId);
    const instance = pickInstance(decision, input.instanceId);
    const role = await this.options.roles.get(input.roleId);
    const verification = await this.verifyRole(role, decision.runId !== undefined ? true : true, {
      verifyAvailability: true
    });

    if (!role.enabled) {
      instance.status = "paused";
      instance.selection = undefined;
      instance.pauseCode = "role_disabled";
      instance.pauseReason = `用户指定的角色「${role.name}」已停用，已暂停，不会自动切换其他角色。`;
      instance.reason = instance.pauseReason;
    } else if (!verification.ready) {
      const detail = verification.reason ?? `用户指定的角色「${role.name}」当前不可用`;
      const message = `${detail}；已暂停，不会自动切换其他模型或角色。`;
      instance.status = "paused";
      instance.selection = undefined;
      instance.pauseCode = verification.pauseCode ?? "role_unavailable";
      instance.pauseReason = message;
      instance.reason = message;
    } else {
      instance.status = "user_override";
      instance.selection = selectionFromRole(role, "user_override");
      instance.temporaryRole = undefined;
      instance.pauseCode = undefined;
      instance.pauseReason = undefined;
      instance.reason = `用户覆盖选择角色「${role.name}」（${role.harness}${role.modelId ? ` / ${role.modelId}` : ""}）。`;
    }

    instance.candidates = rankCandidates(await this.options.roles.list(), instance.requirement).map((c) => ({
      ...c,
      // Keep eligibility metadata even though user forced a pick.
    }));

    return this.finalize(decision);
  }

  /**
   * Confirm a temporary role into the long-term Role library.
   * Without confirm=true the draft stays Run-scoped only.
   */
  async confirmTemporaryAsLongTerm(
    decisionId: string,
    input: ConfirmTemporaryInput
  ): Promise<{ decision: RoutingDecision; role: AgentRole }> {
    if (!input.confirm) {
      throw new Error("Confirm before saving a temporary Role into the long-term library.");
    }
    const decision = this.requireDecision(decisionId);
    const draft =
      this.temporaryRoles.get(input.temporaryRoleId)
      ?? decision.instances.find((i) => i.temporaryRole?.id === input.temporaryRoleId)?.temporaryRole;
    if (!draft) throw new Error(`Temporary role ${input.temporaryRoleId} was not found.`);
    if (draft.longTermRoleId) {
      const existing = await this.options.roles.get(draft.longTermRoleId);
      return { decision: cloneDecision(decision), role: existing };
    }

    const role = await this.options.roles.create({
      name: input.name?.trim() || draft.name,
      responsibility: draft.responsibility,
      systemInstruction: draft.systemInstruction,
      connectionId: draft.connectionId,
      modelId: draft.modelId,
      harness: draft.harness,
      reasoningEffort: draft.reasoningEffort,
      skills: draft.skills,
      tools: draft.tools,
      permissions: draft.permissions,
      // Long-term save does not auto-enable Firstmate invoke unless the draft said so.
      allowFirstmateAutoInvoke: draft.allowFirstmateAutoInvoke
    });

    draft.confirmedForLongTerm = true;
    draft.longTermRoleId = role.id;
    this.temporaryRoles.set(draft.id, draft);

    for (const instance of decision.instances) {
      if (instance.temporaryRole?.id === draft.id) {
        instance.temporaryRole = { ...draft };
        if (instance.selection?.temporaryRoleId === draft.id) {
          instance.selection = {
            ...instance.selection,
            roleId: role.id,
            source: instance.selection.source === "user_override" ? "user_override" : "temporary"
          };
        }
      }
    }

    return { decision: this.finalize(decision), role };
  }

  getTemporaryRole(temporaryRoleId: string): TemporaryRoleDraft {
    const draft = this.temporaryRoles.get(temporaryRoleId);
    if (!draft) throw new Error(`Temporary role ${temporaryRoleId} was not found.`);
    return { ...draft, skills: [...draft.skills], tools: [...draft.tools], permissions: { ...draft.permissions } };
  }

  // ---------------------------------------------------------------------------
  // Internal routing
  // ---------------------------------------------------------------------------

  private async routeExplicit(
    roleId: string,
    req: InstanceRequirement,
    request: RouteRequest
  ): Promise<RoutedInstance> {
    const base: RoutedInstance = {
      instanceId: req.id,
      instanceName: req.name ?? req.id,
      status: "paused",
      reason: "",
      candidates: [],
      requirement: req
    };

    let role: AgentRole;
    try {
      role = await this.options.roles.get(roleId);
    } catch {
      return {
        ...base,
        status: "paused",
        pauseCode: "explicit_role_missing",
        pauseReason: `用户指定的角色 ${roleId} 不存在，已暂停，不会自动替换为其他角色。`,
        reason: `用户指定的角色 ${roleId} 不存在，已暂停，不会自动替换为其他角色。`
      };
    }

    base.candidates = rankCandidates([role], req);

    if (!role.enabled) {
      return {
        ...base,
        status: "paused",
        pauseCode: "role_disabled",
        pauseReason: `用户指定的角色「${role.name}」已停用，已暂停，不会自动切换其他角色。`,
        reason: `用户指定的角色「${role.name}」已停用，已暂停，不会自动切换其他角色。`
      };
    }

    const verification = await this.verifyRole(role, true, {
      verifyAvailability: request.verifyAvailability !== false
    });
    if (!verification.ready) {
      const detail = verification.reason ?? `用户指定的角色「${role.name}」当前不可用`;
      const message = `${detail}；已暂停，不会自动切换其他模型或角色。`;
      return {
        ...base,
        status: "paused",
        pauseCode: verification.pauseCode ?? "role_unavailable",
        pauseReason: message,
        reason: message
      };
    }

    return {
      ...base,
      status: "user_specified",
      selection: selectionFromRole(role, "user_specified"),
      reason: `尊重用户明确指定的角色「${role.name}」（模型 ${role.modelId ?? "默认"}，Harness ${role.harness}），不擅自替换。`
    };
  }

  private async routeAuto(
    roles: AgentRole[],
    req: InstanceRequirement,
    request: RouteRequest
  ): Promise<RoutedInstance> {
    const ranked = rankCandidates(roles, req);
    const eligible = ranked.filter((c) => c.eligible);

    for (const candidate of eligible) {
      const role = roles.find((r) => r.id === candidate.roleId)!;
      const verification = await this.verifyRole(role, true, {
        verifyAvailability: request.verifyAvailability !== false
      });
      if (!verification.ready) {
        // Spec: 角色不可用、配额不足或登录失效时暂停，不自动切换其他模型.
        const detail = verification.reason ?? `匹配角色「${role.name}」当前不可用`;
        const message = `${detail}；已暂停，不会自动切换其他模型。`;
        return {
          instanceId: req.id,
          instanceName: req.name ?? req.id,
          status: "paused",
          reason: message,
          candidates: ranked,
          requirement: req,
          pauseCode: verification.pauseCode ?? "role_unavailable",
          pauseReason: message
        };
      }

      return {
        instanceId: req.id,
        instanceName: req.name ?? req.id,
        status: "selected",
        selection: selectionFromRole(role, "role"),
        reason: buildSelectionReason(role, candidate),
        candidates: ranked,
        requirement: req
      };
    }

    // No eligible configured role → temporary role for this Run only.
    const temporary = this.createTemporaryDraft(req, request);
    return {
      instanceId: req.id,
      instanceName: req.name ?? req.id,
      status: temporary.connectionId ? "temporary" : "paused",
      selection: temporary.connectionId
        ? selectionFromTemporary(temporary)
        : undefined,
      reason: temporary.connectionId
        ? `没有匹配的已配置角色；已生成临时角色「${temporary.name}」供本次 Run 使用（需确认后才会写入长期角色库）。`
        : "没有匹配的已配置角色，且无法生成临时角色（缺少默认模型连接）。",
      candidates: ranked,
      temporaryRole: temporary,
      requirement: req,
      pauseCode: temporary.connectionId ? undefined : "no_connection_for_temporary",
      pauseReason: temporary.connectionId
        ? undefined
        : "没有匹配角色且缺少 defaultConnectionId，已暂停。"
    };
  }

  private createTemporaryDraft(req: InstanceRequirement, request: RouteRequest): TemporaryRoleDraft {
    const derived = deriveSkillToolPermission(req);
    const harness = req.harness ?? request.preferredHarness ?? "api";
    const connectionId = request.defaultConnectionId;
    const modelId = request.defaultModelId;
    const name = req.name?.trim() || `临时角色 · ${req.id}`;
    const responsibility =
      req.responsibilityHint?.trim()
      || `按需执行：${(req.capabilities ?? derived.skills).join("、") || req.id}`;
    const systemInstruction =
      req.systemInstructionHint?.trim()
      || "仅在批准的计划与项目工作区范围内完成分配任务；不越权修改；完成后回报可验证结果。";

    const draft: TemporaryRoleDraft = {
      id: randomUUID(),
      name,
      responsibility,
      systemInstruction,
      connectionId,
      modelId,
      harness,
      reasoningEffort: req.reasoningEffort ?? "medium",
      skills: derived.skills.length > 0 ? derived.skills : ["implement"],
      tools: derived.tools.length > 0 ? derived.tools : ["filesystem"],
      permissions: derived.permissions,
      allowFirstmateAutoInvoke: false,
      confirmedForLongTerm: false,
      createdAt: this.now().toISOString()
    };
    this.temporaryRoles.set(draft.id, draft);
    return draft;
  }

  private async verifyRole(
    role: AgentRole,
    _selected: boolean,
    options: { verifyAvailability: boolean }
  ): Promise<{ ready: boolean; reason?: string; pauseCode?: PauseCode }> {
    if (!role.enabled) {
      return { ready: false, reason: `角色「${role.name}」已停用。`, pauseCode: "role_disabled" };
    }

    if (!options.verifyAvailability) {
      // Structural checks only (skills/tools catalog) via RoleService when available.
      try {
        const verification = await this.options.roles.verify(role.id);
        if (!verification.ready && (verification.missingSkills.length > 0 || verification.missingTools.length > 0)) {
          return {
            ready: false,
            reason: [
              verification.missingSkills.length ? `缺少 Skills: ${verification.missingSkills.join(", ")}` : "",
              verification.missingTools.length ? `缺少 Tools: ${verification.missingTools.join(", ")}` : ""
            ].filter(Boolean).join("；"),
            pauseCode: "role_unavailable"
          };
        }
      } catch {
        // Role may be ephemeral in tests; treat as ready for structural-only path.
      }
      return { ready: true };
    }

    // Prefer RoleService.verify (connection test + catalog).
    try {
      const verification = await this.options.roles.verify(role.id);
      if (verification.ready) return { ready: true };
      const connReason = verification.connection?.reason ?? "";
      const pauseCode = classifyPause(connReason);
      const parts = [
        connReason,
        verification.missingSkills.length ? `缺少 Skills: ${verification.missingSkills.join(", ")}` : "",
        verification.missingTools.length ? `缺少 Tools: ${verification.missingTools.join(", ")}` : ""
      ].filter(Boolean);
      return {
        ready: false,
        reason: parts.join("；") || `角色「${role.name}」不可用。`,
        pauseCode
      };
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof Error ? error.message : `角色「${role.name}」校验失败。`,
        pauseCode: "role_unavailable"
      };
    }
  }

  private persistDecision(
    request: RouteRequest,
    complexity: PlanComplexity,
    instances: RoutedInstance[]
  ): RoutingDecision {
    const now = this.now().toISOString();
    const decision: RoutingDecision = {
      id: randomUUID(),
      runId: request.runId,
      todoId: request.todoId,
      taskType: request.taskType,
      complexity,
      createdAt: now,
      updatedAt: now,
      instances,
      canAutoQueue: false,
      explanation: "",
      queuePayload: { decisionId: "", runId: request.runId, planApproved: Boolean(request.planApproved), selections: [] }
    };
    return this.finalize(decision, request.planApproved === true);
  }

  private finalize(decision: RoutingDecision, planApproved = false): RoutingDecision {
    const approved = planApproved || Boolean(decision.queuePayload.planApproved);
    decision.updatedAt = this.now().toISOString();
    decision.queuePayload = buildQueuePayload(decision, approved);
    const paused = decision.instances.filter((i) => i.status === "paused");
    const ready = decision.instances.every(
      (i) => i.selection && i.status !== "paused"
    );
    if (!approved) {
      decision.canAutoQueue = false;
      decision.autoQueueBlockedReason = "计划尚未批准；批准后可直接进入队列。";
    } else if (paused.length > 0) {
      decision.canAutoQueue = false;
      decision.autoQueueBlockedReason = paused.map((i) => i.pauseReason ?? i.reason).join("；");
    } else if (!ready) {
      decision.canAutoQueue = false;
      decision.autoQueueBlockedReason = "仍有实例未完成角色选择。";
    } else {
      decision.canAutoQueue = true;
      decision.autoQueueBlockedReason = undefined;
    }

    decision.explanation = buildDecisionExplanation(decision);
    this.decisions.set(decision.id, decision);
    return cloneDecision(decision);
  }

  private requireDecision(decisionId: string): RoutingDecision {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new Error(`Routing decision ${decisionId} was not found.`);
    return decision;
  }
}

// =============================================================================
// Pure helpers (exported for unit tests)
// =============================================================================

export function deriveInstances(request: RouteRequest, complexity: PlanComplexity): InstanceRequirement[] {
  if (request.instances && request.instances.length > 0) {
    return request.instances.map((entry) => ({
      ...entry,
      id: entry.id || randomUUID(),
      capabilities: normalizeList(entry.capabilities),
      skills: normalizeList(entry.skills),
      tools: normalizeList(entry.tools)
    }));
  }

  const caps = normalizeList(request.requiredCapabilities);
  const skills = normalizeList(request.requiredSkills);
  const tools = normalizeList(request.requiredTools);
  const base: InstanceRequirement = {
    id: "primary",
    name: "主执行角色",
    capabilities: caps,
    skills,
    tools,
    harness: request.preferredHarness,
    permissions: request.requiredPermissions
  };

  // Simple tasks → single role only.
  if (complexity === "low") {
    return [base];
  }

  // Complex: partition into capability affinity groups when multiple distinct domains exist.
  const groups = partitionCapabilities(caps, request.taskType);
  if (groups.length <= 1) {
    return [base];
  }

  return groups.map((group, index) => ({
    id: group.id,
    name: group.name,
    capabilities: group.capabilities,
    skills: index === 0 ? skills : skills.filter((s) => group.skills.includes(s)),
    tools: index === 0 ? tools : tools.filter((t) => group.tools.includes(t)),
    harness: group.harness ?? request.preferredHarness,
    permissions: request.requiredPermissions
  }));
}

export function rankCandidates(roles: AgentRole[], req: InstanceRequirement): RoleMatchCandidate[] {
  const needed = deriveSkillToolPermission(req);
  return roles
    .map((role) => scoreRole(role, req, needed))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });
}

export function deriveSkillToolPermission(req: InstanceRequirement): {
  skills: string[];
  tools: string[];
  permissions: RolePermissions;
} {
  const skills = new Set(normalizeList(req.skills));
  const tools = new Set(normalizeList(req.tools));
  let workspace: RolePermissions["workspace"] = req.permissions?.workspace ?? "project_only";
  let network = req.permissions?.network ?? false;
  let shell = req.permissions?.shell ?? false;
  let externalSend = req.permissions?.externalSend ?? false;

  for (const cap of normalizeList(req.capabilities)) {
    const key = cap.trim().toLowerCase().replace(/\s+/g, "_");
    for (const skill of CAPABILITY_SKILL_MAP[key] ?? []) skills.add(skill);
    for (const tool of CAPABILITY_TOOL_MAP[key] ?? []) tools.add(tool);
    if (key === "shell" || key === "tests" || key === "automation" || key === "implement" || key === "implementation") {
      shell = req.permissions?.shell ?? true;
    }
    if (key === "network" || key === "web") network = req.permissions?.network ?? true;
    if (key === "external_send" || key === "externalsend") externalSend = true;
    if (key === "read_only" || key === "readonly") workspace = "read_only";
  }

  return {
    skills: [...skills],
    tools: [...tools],
    permissions: { workspace, network, shell, externalSend }
  };
}

function scoreRole(
  role: AgentRole,
  req: InstanceRequirement,
  needed: { skills: string[]; tools: string[]; permissions: RolePermissions }
): RoleMatchCandidate {
  const matchReasons: string[] = [];
  const rejectReasons: string[] = [];
  let score = 0;

  if (!role.enabled) rejectReasons.push("角色已停用");
  if (!role.allowFirstmateAutoInvoke) rejectReasons.push("未允许 Firstmate 自动调用 (allowFirstmateAutoInvoke=false)");

  const harness = req.harness;
  if (harness && role.harness !== harness) {
    rejectReasons.push(`Harness 不匹配（需要 ${harness}，角色为 ${role.harness}）`);
  } else if (harness) {
    matchReasons.push(`Harness=${role.harness}`);
    score += 20;
  } else {
    matchReasons.push(`Harness=${role.harness}`);
    score += 5;
  }

  const missingSkills = needed.skills.filter((s) => !role.skills.includes(s));
  const coveredSkills = needed.skills.filter((s) => role.skills.includes(s));
  if (missingSkills.length > 0) {
    rejectReasons.push(`缺少 Skills: ${missingSkills.join(", ")}`);
  } else if (needed.skills.length > 0) {
    matchReasons.push(`Skills 覆盖: ${coveredSkills.join(", ")}`);
    score += 15 + coveredSkills.length * 3;
  } else {
    score += Math.min(role.skills.length, 5);
  }

  const missingTools = needed.tools.filter((t) => !role.tools.includes(t));
  const coveredTools = needed.tools.filter((t) => role.tools.includes(t));
  if (missingTools.length > 0) {
    rejectReasons.push(`缺少 Tools: ${missingTools.join(", ")}`);
  } else if (needed.tools.length > 0) {
    matchReasons.push(`Tools 覆盖: ${coveredTools.join(", ")}`);
    score += 15 + coveredTools.length * 3;
  } else {
    score += Math.min(role.tools.length, 5);
  }

  // Permissions must be sufficient (role may be stricter on externalSend/network).
  if (needed.permissions.shell && !role.permissions.shell) {
    rejectReasons.push("权限不足：需要 shell");
  } else if (needed.permissions.shell) {
    matchReasons.push("permissions.shell=true");
    score += 5;
  }
  if (needed.permissions.network && !role.permissions.network) {
    rejectReasons.push("权限不足：需要 network");
  } else if (needed.permissions.network) {
    matchReasons.push("permissions.network=true");
    score += 3;
  }
  if (needed.permissions.externalSend && !role.permissions.externalSend) {
    rejectReasons.push("权限不足：需要 externalSend");
  }
  if (needed.permissions.workspace === "project_only" && role.permissions.workspace === "read_only") {
    rejectReasons.push("权限不足：需要 project_only 工作区写入");
  } else if (role.permissions.workspace === needed.permissions.workspace) {
    matchReasons.push(`permissions.workspace=${role.permissions.workspace}`);
    score += 5;
  }

  // Capability soft match against responsibility / name / skills / tools.
  for (const cap of normalizeList(req.capabilities)) {
    const needle = cap.toLowerCase();
    const hay = `${role.name} ${role.responsibility} ${role.skills.join(" ")} ${role.tools.join(" ")}`.toLowerCase();
    if (hay.includes(needle) || role.skills.some((s) => s.toLowerCase().includes(needle)) || role.tools.some((t) => t.toLowerCase().includes(needle))) {
      matchReasons.push(`能力关键词命中: ${cap}`);
      score += 4;
    }
  }

  if (role.enabled) {
    matchReasons.push("enabled=true");
    score += 5;
  }
  if (role.allowFirstmateAutoInvoke) {
    matchReasons.push("allowFirstmateAutoInvoke=true");
    score += 10;
  }

  const eligible = rejectReasons.length === 0 && role.enabled && role.allowFirstmateAutoInvoke;

  return {
    roleId: role.id,
    name: role.name,
    modelId: role.modelId,
    harness: role.harness,
    connectionId: role.connectionId,
    score,
    matchReasons: unique(matchReasons),
    rejectReasons: unique(rejectReasons),
    eligible
  };
}

function partitionCapabilities(
  capabilities: string[],
  taskType?: TaskType
): Array<{ id: string; name: string; capabilities: string[]; skills: string[]; tools: string[]; harness?: Harness }> {
  if (capabilities.length === 0) {
    return [{ id: "primary", name: "主执行角色", capabilities: [], skills: [], tools: [] }];
  }

  const codeCaps = new Set(["filesystem", "shell", "tests", "implement", "implementation", "automation", "workspace", "git"]);
  const researchCaps = new Set(["research", "documents", "writing", "analysis", "web"]);
  const reviewCaps = new Set(["code_review", "review"]);

  const code: string[] = [];
  const research: string[] = [];
  const review: string[] = [];
  const other: string[] = [];

  for (const cap of capabilities) {
    const key = cap.toLowerCase().replace(/\s+/g, "_");
    if (reviewCaps.has(key)) review.push(cap);
    else if (researchCaps.has(key)) research.push(cap);
    else if (codeCaps.has(key)) code.push(cap);
    else other.push(cap);
  }

  // Always keep workspace with the primary code/write path when present.
  const groups: Array<{ id: string; name: string; capabilities: string[]; skills: string[]; tools: string[]; harness?: Harness }> = [];

  const pushGroup = (
    id: string,
    name: string,
    caps: string[],
    harness?: Harness
  ) => {
    if (caps.length === 0) return;
    const derived = deriveSkillToolPermission({ id, capabilities: caps });
    groups.push({ id, name, capabilities: caps, skills: derived.skills, tools: derived.tools, harness });
  };

  const preferCodex = taskType && CODE_TASK_TYPES.has(taskType);
  pushGroup("exec", "执行角色", [...code, ...other.filter((c) => !researchCaps.has(c.toLowerCase()) && !reviewCaps.has(c.toLowerCase()))], preferCodex ? "codex-cli" : undefined);
  // If exec absorbed nothing but we had only "other", fold other into exec:
  if (groups.length === 0 && other.length > 0) {
    pushGroup("exec", "执行角色", other, preferCodex ? "codex-cli" : undefined);
  }
  pushGroup("research", "调研/文档角色", research);
  pushGroup("review", "审查角色", review);

  if (groups.length === 0) {
    return [{ id: "primary", name: "主执行角色", capabilities, skills: [], tools: [] }];
  }

  // If only one non-empty domain, collapse to single instance (simple multi-cap same domain).
  return groups;
}

function selectionFromRole(
  role: AgentRole,
  source: SelectedRoleSummary["source"]
): SelectedRoleSummary {
  return {
    source,
    roleId: role.id,
    name: role.name,
    modelId: role.modelId,
    harness: role.harness,
    connectionId: role.connectionId,
    skills: [...role.skills],
    tools: [...role.tools],
    permissions: { ...role.permissions },
    reasoningEffort: role.reasoningEffort,
    systemInstruction: role.systemInstruction,
    responsibility: role.responsibility,
    allowFirstmateAutoInvoke: role.allowFirstmateAutoInvoke
  };
}

function selectionFromTemporary(draft: TemporaryRoleDraft): SelectedRoleSummary {
  return {
    source: "temporary",
    temporaryRoleId: draft.id,
    roleId: draft.longTermRoleId,
    name: draft.name,
    modelId: draft.modelId,
    harness: draft.harness,
    connectionId: draft.connectionId,
    skills: [...draft.skills],
    tools: [...draft.tools],
    permissions: { ...draft.permissions },
    reasoningEffort: draft.reasoningEffort,
    systemInstruction: draft.systemInstruction,
    responsibility: draft.responsibility,
    allowFirstmateAutoInvoke: draft.allowFirstmateAutoInvoke
  };
}

function buildSelectionReason(role: AgentRole, candidate: RoleMatchCandidate): string {
  const bits = [
    `自动选择角色「${role.name}」`,
    `模型 ${role.modelId ?? "默认"}`,
    `Harness ${role.harness}`,
    candidate.matchReasons.slice(0, 4).join("；")
  ];
  return `${bits.join(" · ")}。`;
}

function buildQueuePayload(decision: RoutingDecision, planApproved: boolean): AutoQueuePayload {
  return {
    decisionId: decision.id,
    runId: decision.runId,
    planApproved,
    selections: decision.instances
      .filter((i) => i.selection && i.status !== "paused")
      .map((i) => ({
        instanceId: i.instanceId,
        roleId: i.selection!.roleId,
        temporaryRoleId: i.selection!.temporaryRoleId,
        source: i.selection!.source,
        name: i.selection!.name,
        harness: i.selection!.harness,
        modelId: i.selection!.modelId,
        connectionId: i.selection!.connectionId,
        skills: [...i.selection!.skills],
        tools: [...i.selection!.tools],
        permissions: { ...i.selection!.permissions },
        systemInstruction: i.selection!.systemInstruction,
        responsibility: i.selection!.responsibility
      }))
  };
}

function buildDecisionExplanation(decision: RoutingDecision): string {
  const parts = decision.instances.map((i) => {
    if (i.status === "paused") return `[${i.instanceName}] 暂停：${i.pauseReason ?? i.reason}`;
    if (i.selection) {
      return `[${i.instanceName}] ${i.selection.name} (${i.selection.harness}${i.selection.modelId ? ` / ${i.selection.modelId}` : ""}) — ${i.reason}`;
    }
    return `[${i.instanceName}] ${i.reason}`;
  });
  const queue = decision.canAutoQueue
    ? "计划已批准且角色就绪，可直接进入队列与执行。"
    : `尚未自动入队：${decision.autoQueueBlockedReason ?? "未知原因"}`;
  return `${parts.join("\n")}\n${queue}`;
}

function pickInstance(decision: RoutingDecision, instanceId?: string): RoutedInstance {
  if (instanceId) {
    const found = decision.instances.find((i) => i.instanceId === instanceId);
    if (!found) throw new Error(`Routing instance ${instanceId} was not found.`);
    return found;
  }
  if (decision.instances.length === 1) return decision.instances[0]!;
  throw new Error("instanceId is required when the routing decision has multiple instances.");
}

function classifyPause(reason: string): PauseCode {
  const text = reason.toLowerCase();
  if (/配额|quota|rate.?limit|429/.test(text)) return "quota_exhausted";
  if (/登录|login|auth|认证|401|403|api.?key|credential/.test(text)) return "login_failed";
  if (/停用|disabled/.test(text)) return "connection_disabled";
  return "role_unavailable";
}

function normalizeList(values?: string[]): string[] {
  if (!values) return [];
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function cloneDecision(decision: RoutingDecision): RoutingDecision {
  return structuredClone(decision);
}
