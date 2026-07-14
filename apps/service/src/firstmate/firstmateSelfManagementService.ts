/**
 * Firstmate self-management service (Task 36).
 *
 * Provides a controlled tool surface so Firstmate can inspect and manage
 * Agent Roles + discover Runtime/Connection/Skill/Tool/Project/Run/queue
 * state without secrets, silent global config edits, or raw DB access.
 *
 * Import roles/skills/tools/connections/routing as read-only clients only
 * for discovery; Role mutations go through RoleService APIs.
 */

import { randomUUID } from "node:crypto";
import { redactJsonValue, redactSecrets } from "../model/redact.js";
import type {
  AgentRole,
  CreateRoleInput,
  Harness,
  ReasoningEffort,
  RolePermissions,
  RoleService,
  UpdateRoleInput
} from "../roles/roleService.js";
import type { ConnectionService, PublicConnection } from "../connections/connectionService.js";
import type { SkillService } from "../skills/skillService.js";
import type { ToolRegistry } from "../tools/toolRegistry.js";
import type { ProjectService } from "../projects/projectService.js";
import type { RunService } from "../runs/runService.js";
import type { RunQueueService } from "../queue/runQueueService.js";
import type { RuntimeAdapterRegistry } from "../runtime/registry.js";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import {
  FIRSTMATE_BUILTIN_ROLE_ID,
  FIRSTMATE_NAME_PATTERN,
  type AuditEntry,
  type AuditResultKind,
  type ConnectionDiscoveryView,
  type CreateRoleToolInput,
  type CreateTemporaryAgentInput,
  type FirstmateAvatar,
  type FirstmateErrorCode,
  type FirstmateToolName,
  type FirstmateToolResult,
  type ProjectDiscoveryView,
  type PublicRoleView,
  type QueueDiscoveryView,
  type RemoveRoleToolInput,
  type RoleConfigSchema,
  type RolePatchCycleResult,
  type RunDiscoveryView,
  type RuntimeDiscoveryView,
  type SkillDiscoveryView,
  type TemporaryAgent,
  type ToolDiscoveryView,
  type UpdateRoleToolInput
} from "./firstmateTypes.js";

// ── Dependency contracts (minimal read/write surfaces) ───────────────────────

export type RolesClient = Pick<
  RoleService,
  "list" | "get" | "create" | "update" | "remove" | "verify"
> & {
  readonly firstmateCoreRules?: string;
};

export type ConnectionsClient = Pick<ConnectionService, "listPublic" | "getPublic">;
export type SkillsClient = Pick<SkillService, "list" | "get" | "tryGet">;
export type ToolsClient = Pick<ToolRegistry, "list" | "get" | "tryGet">;
export type ProjectsClient = Pick<ProjectService, "list" | "get">;
export type RunsClient = Pick<RunService, "listAll" | "get">;
export type QueueClient = Pick<RunQueueService, "status" | "getConfig">;

export type RuntimesClient =
  | RuntimeAdapterRegistry
  | {
      list(): RuntimeAdapter[];
      tryGet?(harness: string): RuntimeAdapter | undefined;
      get?(harness: string): RuntimeAdapter;
      has?(harness: string): boolean;
    };

export interface FirstmateSelfManagementOptions {
  roles: RolesClient;
  connections?: ConnectionsClient;
  skills?: SkillsClient;
  tools?: ToolsClient;
  projects?: ProjectsClient;
  runs?: RunsClient;
  queue?: QueueClient;
  runtimes?: RuntimesClient;
  /** Optional clock for tests. */
  now?: () => Date;
  /** Max audit entries retained in memory. */
  maxAuditEntries?: number;
}

const DEFAULT_MAX_AUDIT = 500;

const DEFAULT_PERMISSIONS: RolePermissions = {
  workspace: "project_only",
  network: false,
  shell: false,
  externalSend: false
};

// ── Service ──────────────────────────────────────────────────────────────────

export class FirstmateSelfManagementService {
  private readonly temporaryAgents = new Map<string, TemporaryAgent>();
  private readonly audit: AuditEntry[] = [];
  private readonly now: () => Date;
  private readonly maxAuditEntries: number;

  constructor(private readonly options: FirstmateSelfManagementOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxAuditEntries = options.maxAuditEntries ?? DEFAULT_MAX_AUDIT;
  }

  // ── Role CRUD ────────────────────────────────────────────────────────────

  async listRoles(): Promise<PublicRoleView[]> {
    const roles = await this.options.roles.list();
    return roles.map((role) => toPublicRole(role));
  }

  async getRole(roleId: string): Promise<PublicRoleView> {
    const role = await this.options.roles.get(roleId);
    return toPublicRole(role);
  }

  roleSchema(): RoleConfigSchema {
    return buildRoleConfigSchema(this.options.roles.firstmateCoreRules);
  }

  async createRole(input: CreateRoleToolInput): Promise<FirstmateToolResult> {
    const tool: FirstmateToolName = "roles.create";
    const actor = input.actor?.trim() || "firstmate";

    if (!input.userRequested) {
      return this.reject(
        tool,
        actor,
        input.reason,
        "role",
        undefined,
        "user_request_required",
        "Creating a long-term Agent Role requires an explicit user request (userRequested=true). Temporary agents do not need this gate."
      );
    }

    try {
      const createInput = parseCreateRoleInput(input);
      const created = await this.options.roles.create(createInput);
      const after = toPublicRole(created);
      const auditId = this.recordAudit({
        actor,
        tool,
        reason: input.reason,
        targetType: "role",
        targetId: created.id,
        before: undefined,
        after: redactJsonValue(after),
        result: "ok",
        userRequested: true
      });
      return ok(tool, `Created Agent Role “${created.name}” (${created.id}).`, after, auditId);
    } catch (error) {
      return this.fail(tool, actor, input.reason, "role", undefined, error);
    }
  }

  /**
   * Fixed mutation workflow: read current → schema → minimal patch → re-read verify.
   * Never invents enum values; callers must supply only fields present in schema.
   */
  async updateRole(input: UpdateRoleToolInput): Promise<FirstmateToolResult> {
    const tool: FirstmateToolName = "roles.update";
    const actor = input.actor?.trim() || "firstmate";
    const roleId = requiredString(input.roleId, "roleId");

    if (!input.userRequested) {
      return this.reject(
        tool,
        actor,
        input.reason,
        "role",
        roleId,
        "user_request_required",
        "Updating a long-term Agent Role requires an explicit user request (userRequested=true)."
      );
    }

    try {
      const beforeRole = await this.options.roles.get(roleId);
      if (isBuiltinFirstmate(beforeRole)) {
        // Allow limited non-security fields only when user requested — still block core identity wipe.
        this.assertFirstmateSafePatch(input.patch);
      }

      const before = toPublicRole(beforeRole);
      const schema = this.roleSchema();
      const appliedPatch = sanitizePatch(input.patch);
      if (Object.keys(appliedPatch).length === 0) {
        throw invalid("patch must include at least one field.");
      }

      const updated = await this.options.roles.update(roleId, appliedPatch);
      const after = toPublicRole(updated);
      const diff = computeDiff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);

      let verification: RolePatchCycleResult["verification"];
      try {
        verification = await this.options.roles.verify(roleId);
      } catch {
        verification = undefined;
      }

      const cycle: RolePatchCycleResult = {
        workflow: ["read", "schema", "patch", "verify"],
        before,
        schema,
        appliedPatch,
        after,
        diff,
        verification
      };

      const auditId = this.recordAudit({
        actor,
        tool,
        reason: input.reason,
        targetType: "role",
        targetId: roleId,
        before: redactJsonValue(before),
        after: redactJsonValue(after),
        diff: redactJsonValue(diff),
        result: "ok",
        userRequested: true
      });

      return ok(
        tool,
        `Updated Agent Role “${after.name}” via read→schema→patch→verify (${Object.keys(diff).length} field(s)).`,
        cycle,
        auditId
      );
    } catch (error) {
      return this.fail(tool, actor, input.reason, "role", roleId, error);
    }
  }

  async removeRole(input: RemoveRoleToolInput): Promise<FirstmateToolResult> {
    const tool: FirstmateToolName = "roles.remove";
    const actor = input.actor?.trim() || "firstmate";
    const roleId = requiredString(input.roleId, "roleId");

    if (!input.userRequested) {
      return this.reject(
        tool,
        actor,
        input.reason,
        "role",
        roleId,
        "user_request_required",
        "Removing a long-term Agent Role requires an explicit user request (userRequested=true)."
      );
    }

    try {
      const beforeRole = await this.options.roles.get(roleId);
      if (isBuiltinFirstmate(beforeRole)) {
        return this.reject(
          tool,
          actor,
          input.reason,
          "role",
          roleId,
          "builtin_protected",
          "Built-in Firstmate Role cannot be deleted."
        );
      }

      const before = toPublicRole(beforeRole);
      await this.options.roles.remove(roleId);

      const auditId = this.recordAudit({
        actor,
        tool,
        reason: input.reason,
        targetType: "role",
        targetId: roleId,
        before: redactJsonValue(before),
        after: undefined,
        result: "ok",
        userRequested: true
      });

      return ok(tool, `Removed Agent Role “${before.name}” (${roleId}).`, { removed: before }, auditId);
    } catch (error) {
      return this.fail(tool, actor, input.reason, "role", roleId, error);
    }
  }

  // ── Temporary agents ─────────────────────────────────────────────────────

  createTemporaryAgent(input: CreateTemporaryAgentInput): FirstmateToolResult {
    const tool: FirstmateToolName = "agents.temporary.create";
    const actor = input.actor?.trim() || "firstmate";

    try {
      const now = this.now().toISOString();
      const agent: TemporaryAgent = {
        id: randomUUID(),
        name: requiredString(input.name, "name"),
        responsibility: requiredString(input.responsibility, "responsibility"),
        systemInstruction:
          input.systemInstruction?.trim()
          || `Temporary agent: ${input.responsibility.trim()}. Follow Firstmate orchestration and security boundaries.`,
        avatar: normalizeAvatar(input.avatar),
        connectionId: input.connectionId || undefined,
        modelId: input.modelId?.trim() || undefined,
        harness: parseHarness(input.harness),
        reasoningEffort: parseReasoning(input.reasoningEffort ?? "medium"),
        skills: uniqueStrings(input.skills ?? []),
        tools: uniqueStrings(input.tools ?? []),
        permissions: mergePermissions(input.permissions),
        allowFirstmateAutoInvoke: input.allowFirstmateAutoInvoke !== false,
        temporary: true,
        confirmedForLongTerm: false,
        createdAt: now,
        updatedAt: now,
        createdBy: actor,
        reason: input.reason?.trim() || undefined
      };

      this.temporaryAgents.set(agent.id, agent);

      const auditId = this.recordAudit({
        actor,
        tool,
        reason: input.reason,
        targetType: "temporary_agent",
        targetId: agent.id,
        after: redactJsonValue(agent),
        result: "ok",
        userRequested: false
      });

      return ok(
        tool,
        `Created temporary agent “${agent.name}” (${agent.id}) — run-scoped only; not in long-term Role library.`,
        agent,
        auditId
      );
    } catch (error) {
      return this.fail(tool, actor, input.reason, "temporary_agent", undefined, error);
    }
  }

  listTemporaryAgents(): TemporaryAgent[] {
    return [...this.temporaryAgents.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(cloneTemporary);
  }

  getTemporaryAgent(id: string): TemporaryAgent {
    const agent = this.temporaryAgents.get(id);
    if (!agent) throw notFound(`Temporary agent ${id} was not found.`);
    return cloneTemporary(agent);
  }

  removeTemporaryAgent(id: string, options: { actor?: string; reason?: string } = {}): FirstmateToolResult {
    const tool: FirstmateToolName = "agents.temporary.remove";
    const actor = options.actor?.trim() || "firstmate";
    try {
      const before = this.getTemporaryAgent(id);
      this.temporaryAgents.delete(id);
      const auditId = this.recordAudit({
        actor,
        tool,
        reason: options.reason,
        targetType: "temporary_agent",
        targetId: id,
        before: redactJsonValue(before),
        result: "ok"
      });
      return ok(tool, `Removed temporary agent “${before.name}” (${id}).`, { removed: before }, auditId);
    } catch (error) {
      return this.fail(tool, actor, options.reason, "temporary_agent", id, error);
    }
  }

  // ── Read-only discovery ──────────────────────────────────────────────────

  async listRuntimes(): Promise<RuntimeDiscoveryView[]> {
    const registry = this.options.runtimes;
    if (!registry) return [];
    const adapters = registry.list();
    const views: RuntimeDiscoveryView[] = [];
    for (const adapter of adapters) {
      views.push(await this.runtimeView(adapter));
    }
    return views.sort((a, b) => a.harness.localeCompare(b.harness));
  }

  async getRuntime(harness: string): Promise<RuntimeDiscoveryView> {
    const registry = this.options.runtimes;
    if (!registry) throw unavailable("Runtime registry is not configured.");
    const key = requiredString(harness, "harness");
    const adapter =
      "tryGet" in registry && typeof registry.tryGet === "function"
        ? registry.tryGet(key)
        : registry.list().find((entry) => entry.harness === key);
    if (!adapter) throw notFound(`Runtime harness "${key}" was not found.`);
    return this.runtimeView(adapter);
  }

  async listConnections(): Promise<ConnectionDiscoveryView[]> {
    if (!this.options.connections) return [];
    const rows = await this.options.connections.listPublic();
    return rows.map(toConnectionView);
  }

  async getConnection(connectionId: string): Promise<ConnectionDiscoveryView> {
    if (!this.options.connections) throw unavailable("Connection service is not configured.");
    const row = await this.options.connections.getPublic(requiredString(connectionId, "connectionId"));
    return toConnectionView(row);
  }

  listSkills(): SkillDiscoveryView[] {
    if (!this.options.skills) return [];
    return this.options.skills.list().map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      description: skill.description,
      enabled: skill.enabled,
      trusted: skill.trusted,
      source: skill.source,
      tags: [...(skill.tags ?? [])],
      requiredTools: [...(skill.requiredTools ?? [])]
    }));
  }

  getSkill(skillId: string): SkillDiscoveryView {
    if (!this.options.skills) throw unavailable("Skill service is not configured.");
    const skill = this.options.skills.get(requiredString(skillId, "skillId"));
    return {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      description: skill.description,
      enabled: skill.enabled,
      trusted: skill.trusted,
      source: skill.source,
      tags: [...(skill.tags ?? [])],
      requiredTools: [...(skill.requiredTools ?? [])]
    };
  }

  listTools(): ToolDiscoveryView[] {
    if (!this.options.tools) return [];
    return this.options.tools.list().map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      version: tool.version,
      category: tool.category,
      source: tool.source,
      enabled: tool.enabled,
      trusted: tool.trusted,
      requiresApproval: tool.requiresApproval,
      tags: [...(tool.tags ?? [])]
    }));
  }

  getTool(toolId: string): ToolDiscoveryView {
    if (!this.options.tools) throw unavailable("Tool registry is not configured.");
    const tool = this.options.tools.get(requiredString(toolId, "toolId"));
    return {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      version: tool.version,
      category: tool.category,
      source: tool.source,
      enabled: tool.enabled,
      trusted: tool.trusted,
      requiresApproval: tool.requiresApproval,
      tags: [...(tool.tags ?? [])]
    };
  }

  async listProjects(): Promise<ProjectDiscoveryView[]> {
    if (!this.options.projects) return [];
    const projects = await this.options.projects.list();
    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      workspacePath: project.workspacePath,
      summary: project.summary,
      status: project.status,
      workspaceLinkStatus: project.workspaceLinkStatus,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    }));
  }

  async getProject(projectId: string): Promise<ProjectDiscoveryView> {
    if (!this.options.projects) throw unavailable("Project service is not configured.");
    const project = await this.options.projects.get(requiredString(projectId, "projectId"));
    return {
      id: project.id,
      name: project.name,
      workspacePath: project.workspacePath,
      summary: project.summary,
      status: project.status,
      workspaceLinkStatus: project.workspaceLinkStatus,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    };
  }

  async listRuns(limit = 50): Promise<RunDiscoveryView[]> {
    if (!this.options.runs) return [];
    const runs = await this.options.runs.listAll();
    return runs.slice(0, Math.max(1, Math.min(limit, 200))).map((run) => toRunView(run));
  }

  async getRun(runId: string): Promise<RunDiscoveryView> {
    if (!this.options.runs) throw unavailable("Run service is not configured.");
    const run = await this.options.runs.get(requiredString(runId, "runId"));
    return toRunView(run);
  }

  async queueStatus(): Promise<QueueDiscoveryView> {
    if (!this.options.queue) throw unavailable("Queue service is not configured.");
    const status = await this.options.queue.status();
    return {
      config: { ...status.config },
      active: status.active.map((lease) => ({
        runId: lease.runId,
        lane: lease.lane,
        projectId: lease.projectId,
        worktreeIsolated: lease.worktreeIsolated,
        acquiredAt: lease.acquiredAt,
        timeoutMs: lease.timeoutMs
      })),
      writeCount: status.writeCount,
      readOnlyCount: status.readOnlyCount,
      newTasksPaused: status.newTasksPaused,
      pauseReason: status.pauseReason,
      resource: status.resource ? ({ ...status.resource } as Record<string, unknown>) : undefined
    };
  }

  // ── Audit ────────────────────────────────────────────────────────────────

  listAudit(limit = 100): AuditEntry[] {
    const capped = Math.max(1, Math.min(limit, 500));
    return this.audit.slice(0, capped).map(cloneAudit);
  }

  getAudit(auditId: string): AuditEntry {
    const entry = this.audit.find((item) => item.id === auditId);
    if (!entry) throw notFound(`Audit entry ${auditId} was not found.`);
    return cloneAudit(entry);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async runtimeView(adapter: RuntimeAdapter): Promise<RuntimeDiscoveryView> {
    const caps = adapter.capabilities();
    let probeReady = false;
    let reason: string | undefined;
    let details: Record<string, unknown> | undefined;
    try {
      const probe = await adapter.probe();
      probeReady = probe.ready === true;
      reason = probe.reason;
      if (probe.details) {
        details = redactJsonValue(probe.details) as Record<string, unknown>;
      }
    } catch (error) {
      probeReady = false;
      reason = errorMessage(error, "Runtime probe failed.");
    }
    return {
      harness: adapter.harness,
      ready: probeReady,
      reason,
      capabilities: {
        reasoning: !!caps.reasoning,
        images: !!caps.images,
        tools: !!caps.tools,
        resume: !!caps.resume,
        workspace: !!caps.workspace,
        network: !!caps.network,
        structuredOutput: !!caps.structuredOutput
      },
      details
    };
  }

  private assertFirstmateSafePatch(patch: UpdateRoleInput): void {
    // Block attempts to strip Firstmate identity / security posture via ordinary patch.
    if (patch.name !== undefined && !FIRSTMATE_NAME_PATTERN.test(String(patch.name))) {
      throw forbidden("Cannot rename built-in Firstmate away from its identity.");
    }
    if (patch.permissions?.externalSend === true) {
      throw forbidden("Built-in Firstmate cannot be granted externalSend.");
    }
  }

  private reject(
    tool: FirstmateToolName,
    actor: string,
    reason: string | undefined,
    targetType: string,
    targetId: string | undefined,
    code: FirstmateErrorCode,
    message: string
  ): FirstmateToolResult {
    const auditId = this.recordAudit({
      actor,
      tool,
      reason,
      targetType,
      targetId,
      result: "rejected",
      error: message,
      userRequested: false
    });
    return {
      ok: false,
      tool,
      summary: message,
      error: message,
      code,
      needsUserRequest: code === "user_request_required",
      auditId
    };
  }

  private fail(
    tool: FirstmateToolName,
    actor: string,
    reason: string | undefined,
    targetType: string,
    targetId: string | undefined,
    error: unknown
  ): FirstmateToolResult {
    const message = errorMessage(error, "Self-management operation failed.");
    const code = errorCodeOf(error);
    const auditId = this.recordAudit({
      actor,
      tool,
      reason,
      targetType,
      targetId,
      result: "error",
      error: message
    });
    return {
      ok: false,
      tool,
      summary: message,
      error: message,
      code,
      auditId
    };
  }

  private recordAudit(input: {
    actor: string;
    tool: FirstmateToolName;
    reason?: string;
    targetType: string;
    targetId?: string;
    before?: unknown;
    after?: unknown;
    diff?: Record<string, { from: unknown; to: unknown }>;
    result: AuditResultKind;
    error?: string;
    userRequested?: boolean;
  }): string {
    const entry: AuditEntry = {
      id: randomUUID(),
      at: this.now().toISOString(),
      actor: input.actor,
      tool: input.tool,
      reason: input.reason ? redactSecrets(input.reason) : undefined,
      targetType: input.targetType,
      targetId: input.targetId,
      before: input.before,
      after: input.after,
      diff: input.diff,
      result: input.result,
      error: input.error ? redactSecrets(input.error) : undefined,
      userRequested: input.userRequested
    };
    this.audit.unshift(entry);
    if (this.audit.length > this.maxAuditEntries) {
      this.audit.length = this.maxAuditEntries;
    }
    return entry.id;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function isBuiltinFirstmate(role: Pick<AgentRole, "id" | "name">): boolean {
  if (role.id === FIRSTMATE_BUILTIN_ROLE_ID) return true;
  return FIRSTMATE_NAME_PATTERN.test(role.name);
}

export function toPublicRole(role: AgentRole): PublicRoleView {
  return {
    id: role.id,
    name: role.name,
    responsibility: role.responsibility,
    systemInstruction: role.systemInstruction,
    connectionId: role.connectionId,
    modelId: role.modelId,
    harness: role.harness,
    reasoningEffort: role.reasoningEffort,
    skills: [...role.skills],
    tools: [...role.tools],
    permissions: { ...role.permissions },
    allowFirstmateAutoInvoke: role.allowFirstmateAutoInvoke,
    enabled: role.enabled,
    isBuiltinFirstmate: isBuiltinFirstmate(role),
    createdAt: role.createdAt,
    updatedAt: role.updatedAt
  };
}

function buildRoleConfigSchema(coreRules?: string): RoleConfigSchema {
  return {
    type: "object",
    description:
      "Agent Role configuration schema. Always: read current value → read this schema → apply minimal patch → re-read to verify. Do not guess enum values or edit internal storage.",
    properties: {
      name: { type: "string", description: "Display name" },
      responsibility: { type: "string", description: "Role responsibility summary" },
      systemInstruction: { type: "string", description: "System instruction for the agent" },
      connectionId: { type: ["string", "null"], description: "Bound model connection id (null clears)" },
      modelId: { type: ["string", "null"], description: "Model id on the connection (null clears)" },
      harness: { type: "string", enum: ["api", "codex-cli"] },
      reasoningEffort: { type: "string", enum: ["low", "medium", "high"] },
      skills: { type: "array", items: { type: "string" }, description: "Skill ids/names from skills.list" },
      tools: { type: "array", items: { type: "string" }, description: "Tool ids/names from tools.list" },
      permissions: {
        type: "object",
        properties: {
          workspace: { type: "string", enum: ["project_only", "read_only"] },
          network: { type: "boolean" },
          shell: { type: "boolean" },
          externalSend: { type: "boolean" }
        },
        required: ["workspace", "network", "shell", "externalSend"]
      },
      allowFirstmateAutoInvoke: { type: "boolean" },
      enabled: { type: "boolean" }
    },
    required: [
      "name",
      "responsibility",
      "systemInstruction",
      "harness",
      "reasoningEffort",
      "skills",
      "tools",
      "permissions",
      "allowFirstmateAutoInvoke"
    ],
    enums: {
      harness: ["api", "codex-cli"],
      reasoningEffort: ["low", "medium", "high"],
      workspacePermission: ["project_only", "read_only"]
    },
    notes: [
      "Long-term Role create/update/remove require userRequested=true.",
      "Built-in Firstmate cannot be deleted.",
      "Secrets are never returned; use connections.list for status only.",
      ...(coreRules
        ? ["Firstmate core rules (non-overridable): " + coreRules.split("\n")[0]]
        : ["Firstmate only orchestrates; ordinary roles cannot override security rules."])
    ]
  };
}

function parseCreateRoleInput(input: CreateRoleToolInput): CreateRoleInput {
  return {
    name: requiredString(input.name, "name"),
    responsibility: requiredString(input.responsibility, "responsibility"),
    systemInstruction: requiredString(input.systemInstruction, "systemInstruction"),
    connectionId: input.connectionId ?? undefined,
    modelId: input.modelId ?? undefined,
    harness: parseHarness(input.harness),
    reasoningEffort: parseReasoning(input.reasoningEffort),
    skills: uniqueStrings(input.skills ?? []),
    tools: uniqueStrings(input.tools ?? []),
    permissions: mergePermissions(input.permissions),
    allowFirstmateAutoInvoke: input.allowFirstmateAutoInvoke === true
  };
}

function sanitizePatch(patch: UpdateRoleInput): UpdateRoleInput {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw invalid("patch must be an object.");
  }
  const out: UpdateRoleInput = {};
  if (patch.name !== undefined) out.name = String(patch.name);
  if (patch.responsibility !== undefined) out.responsibility = String(patch.responsibility);
  if (patch.systemInstruction !== undefined) out.systemInstruction = String(patch.systemInstruction);
  if (patch.connectionId !== undefined) out.connectionId = patch.connectionId;
  if (patch.modelId !== undefined) out.modelId = patch.modelId;
  if (patch.harness !== undefined) out.harness = parseHarness(patch.harness);
  if (patch.reasoningEffort !== undefined) out.reasoningEffort = parseReasoning(patch.reasoningEffort);
  if (patch.skills !== undefined) out.skills = uniqueStrings(patch.skills);
  if (patch.tools !== undefined) out.tools = uniqueStrings(patch.tools);
  if (patch.permissions !== undefined) out.permissions = mergePermissions(patch.permissions);
  if (patch.allowFirstmateAutoInvoke !== undefined) {
    out.allowFirstmateAutoInvoke = patch.allowFirstmateAutoInvoke === true;
  }
  if (patch.enabled !== undefined) out.enabled = patch.enabled === true;
  return out;
}

function mergePermissions(partial?: Partial<RolePermissions> | RolePermissions): RolePermissions {
  const base = { ...DEFAULT_PERMISSIONS, ...(partial ?? {}) };
  if (base.workspace !== "project_only" && base.workspace !== "read_only") {
    throw invalid("permissions.workspace must be project_only or read_only.");
  }
  if (typeof base.network !== "boolean" || typeof base.shell !== "boolean" || typeof base.externalSend !== "boolean") {
    throw invalid("permissions.network/shell/externalSend must be booleans.");
  }
  return {
    workspace: base.workspace,
    network: base.network,
    shell: base.shell,
    externalSend: base.externalSend
  };
}

function parseHarness(value: unknown): Harness {
  if (value === "api" || value === "codex-cli") return value;
  throw invalid('harness must be "api" or "codex-cli" (see roles.schema).');
}

function parseReasoning(value: unknown): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high") return value;
  throw invalid('reasoningEffort must be "low", "medium", or "high" (see roles.schema).');
}

function normalizeAvatar(avatar: FirstmateAvatar | undefined): FirstmateAvatar | undefined {
  if (!avatar) return undefined;
  if (avatar.kind !== "emoji" && avatar.kind !== "url" && avatar.kind !== "color") {
    throw invalid('avatar.kind must be "emoji", "url", or "color".');
  }
  const value = requiredString(avatar.value, "avatar.value");
  if (avatar.kind === "url" && !/^https?:\/\//i.test(value) && !value.startsWith("data:image/")) {
    throw invalid("avatar.url value must be an http(s) or data:image URL.");
  }
  return { kind: avatar.kind, value };
}

function toConnectionView(row: PublicConnection): ConnectionDiscoveryView {
  // Never include credentialRef, apiKey, or raw headers.
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    enabled: row.enabled,
    presetId: row.presetId,
    providerKind: row.providerKind,
    modelSource: row.modelSource,
    credentialPresent: row.credentialPresent === true,
    lastTestKind: row.lastTest?.kind,
    lastTestMessage: row.lastTest?.message ? redactSecrets(row.lastTest.message) : undefined,
    lastProbeMessage: row.lastProbe?.message ? redactSecrets(row.lastProbe.message) : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function toRunView(run: {
  id: string;
  todoId: string;
  status: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  connectionId?: string;
  planVersions?: Array<{ version: number }>;
  planning?: { approvedPlanVersion?: number };
}): RunDiscoveryView {
  const latestPlan =
    run.planning?.approvedPlanVersion
    ?? run.planVersions?.at(-1)?.version;
  return {
    id: run.id,
    todoId: run.todoId,
    status: run.status,
    attempt: run.attempt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    connectionId: run.connectionId,
    planVersion: latestPlan
  };
}

export function computeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, { from: unknown; to: unknown }> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    const from = before[key];
    const to = after[key];
    if (!stableEqual(from, to)) {
      diff[key] = { from, to };
    }
  }
  return diff;
}

function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function cloneTemporary(agent: TemporaryAgent): TemporaryAgent {
  return {
    ...agent,
    skills: [...agent.skills],
    tools: [...agent.tools],
    permissions: { ...agent.permissions },
    avatar: agent.avatar ? { ...agent.avatar } : undefined
  };
}

function cloneAudit(entry: AuditEntry): AuditEntry {
  return structuredClone(entry);
}

function ok(
  tool: FirstmateToolName,
  summary: string,
  data: unknown,
  auditId?: string
): FirstmateToolResult {
  return {
    ok: true,
    tool,
    summary: redactSecrets(summary),
    data: redactJsonValue(data),
    auditId
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(`${field} is required.`);
  }
  return value.trim();
}

function uniqueStrings(values: string[]): string[] {
  if (!Array.isArray(values)) throw invalid("skills/tools must be arrays.");
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return redactSecrets(error.message);
  return fallback;
}

function errorCodeOf(error: unknown): FirstmateErrorCode {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: string }).code;
    if (
      code === "not_found"
      || code === "invalid_input"
      || code === "forbidden"
      || code === "user_request_required"
      || code === "builtin_protected"
      || code === "unavailable"
    ) {
      return code;
    }
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("was not found") || msg.includes("not found")) return "not_found";
    if (msg.includes("invalid") || msg.includes("required") || msg.includes("must be")) return "invalid_input";
    if (msg.includes("cannot") || msg.includes("forbidden") || msg.includes("not allowed")) return "forbidden";
  }
  return "internal";
}

function invalid(message: string): Error & { code: FirstmateErrorCode } {
  return Object.assign(new Error(message), { code: "invalid_input" as const });
}

function notFound(message: string): Error & { code: FirstmateErrorCode } {
  return Object.assign(new Error(message), { code: "not_found" as const });
}

function forbidden(message: string): Error & { code: FirstmateErrorCode } {
  return Object.assign(new Error(message), { code: "forbidden" as const });
}

function unavailable(message: string): Error & { code: FirstmateErrorCode } {
  return Object.assign(new Error(message), { code: "unavailable" as const });
}
