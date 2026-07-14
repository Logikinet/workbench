/**
 * Firstmate self-management tool surface types (Task 36).
 *
 * Pattern (NextClaw-inspired AI Self-Management Contract):
 * - Machine-readable tools for Role CRUD + read-only discovery
 * - Config mutation flow: read current → schema → minimal patch → re-read verify
 * - Never return secrets; audit every management action
 */

import type {
  AgentRole,
  CreateRoleInput,
  Harness,
  ReasoningEffort,
  RolePermissions,
  UpdateRoleInput
} from "../roles/roleService.js";

/** Well-known built-in Firstmate Role id — never deletable via tools. */
export const FIRSTMATE_BUILTIN_ROLE_ID = "firstmate";

/** Match Role names that identify the built-in Firstmate orchestrator. */
export const FIRSTMATE_NAME_PATTERN = /firstmate/i;

export type FirstmateToolName =
  | "roles.list"
  | "roles.get"
  | "roles.schema"
  | "roles.create"
  | "roles.update"
  | "roles.remove"
  | "agents.temporary.create"
  | "agents.temporary.list"
  | "agents.temporary.get"
  | "agents.temporary.remove"
  | "runtimes.list"
  | "runtimes.get"
  | "connections.list"
  | "connections.get"
  | "skills.list"
  | "skills.get"
  | "tools.list"
  | "tools.get"
  | "projects.list"
  | "projects.get"
  | "runs.list"
  | "runs.get"
  | "queue.status"
  | "audit.list"
  | "audit.get";

export type FirstmateToolRisk = "read" | "write" | "dangerous";

export type FirstmateToolCategory =
  | "roles"
  | "temporary_agents"
  | "discovery"
  | "audit";

/** Catalog entry returned to the model (schema + description only). */
export interface FirstmateToolSpec {
  name: FirstmateToolName;
  description: string;
  risk: FirstmateToolRisk;
  category: FirstmateToolCategory;
  /** JSON-schema-like input contract — never guess enum values; read this first. */
  inputSchema: Record<string, unknown>;
  /** When true, tool mutates durable long-term config and requires userRequested=true. */
  requiresUserRequest: boolean;
}

export type FirstmateAvatarKind = "emoji" | "url" | "color";

export interface FirstmateAvatar {
  kind: FirstmateAvatarKind;
  value: string;
}

/** Run-scoped temporary agent drafted by Firstmate (not long-term library). */
export interface TemporaryAgent {
  id: string;
  name: string;
  responsibility: string;
  systemInstruction: string;
  avatar?: FirstmateAvatar;
  connectionId?: string;
  modelId?: string;
  harness: Harness;
  reasoningEffort: ReasoningEffort;
  skills: string[];
  tools: string[];
  permissions: RolePermissions;
  allowFirstmateAutoInvoke: boolean;
  temporary: true;
  /** Never auto-promoted to long-term Role without explicit user confirm (routing path). */
  confirmedForLongTerm: false;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  reason?: string;
}

export interface CreateTemporaryAgentInput {
  name: string;
  responsibility: string;
  systemInstruction?: string;
  avatar?: FirstmateAvatar;
  connectionId?: string | null;
  modelId?: string | null;
  harness: Harness;
  reasoningEffort?: ReasoningEffort;
  skills?: string[];
  tools?: string[];
  permissions?: Partial<RolePermissions>;
  allowFirstmateAutoInvoke?: boolean;
  reason?: string;
  /** Actor label for audit (default "firstmate"). */
  actor?: string;
}

export interface CreateRoleToolInput extends Omit<CreateRoleInput, "roleKind"> {
  reason?: string;
  actor?: string;
  /**
   * Must be true for durable Role library writes.
   * Without an explicit user request, long-term Role create is rejected.
   */
  userRequested: boolean;
}

export interface UpdateRoleToolInput {
  roleId: string;
  /** Minimal patch fields only — omit unchanged properties. */
  patch: UpdateRoleInput;
  reason?: string;
  actor?: string;
  userRequested: boolean;
}

export interface RemoveRoleToolInput {
  roleId: string;
  reason?: string;
  actor?: string;
  userRequested: boolean;
}

/** Structured result for every tool invocation (model-safe). */
export interface FirstmateToolResult {
  ok: boolean;
  tool: FirstmateToolName;
  /** Compact summary for timeline / model feedback (never secrets). */
  summary: string;
  data?: unknown;
  error?: string;
  code?: FirstmateErrorCode;
  /** Present when mutation was blocked pending explicit user request. */
  needsUserRequest?: boolean;
  auditId?: string;
}

export type FirstmateErrorCode =
  | "not_found"
  | "invalid_input"
  | "forbidden"
  | "user_request_required"
  | "builtin_protected"
  | "unavailable"
  | "internal";

export type AuditResultKind = "ok" | "rejected" | "error";

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  tool: FirstmateToolName;
  reason?: string;
  targetType: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  /** Machine-readable shallow field diffs (before → after). */
  diff?: Record<string, { from: unknown; to: unknown }>;
  result: AuditResultKind;
  error?: string;
  /** True when the caller declared an explicit user request. */
  userRequested?: boolean;
}

/** Public Role view for tools (no internal-only fields). */
export interface PublicRoleView {
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
  enabled: boolean;
  isBuiltinFirstmate: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Runtime discovery summary (probe + capabilities, no secrets). */
export interface RuntimeDiscoveryView {
  harness: string;
  ready: boolean;
  reason?: string;
  capabilities: {
    reasoning: boolean;
    images: boolean;
    tools: boolean;
    resume: boolean;
    workspace: boolean;
    network: boolean;
    structuredOutput: boolean;
  };
  details?: Record<string, unknown>;
}

/** Connection discovery — status + capability summary only. */
export interface ConnectionDiscoveryView {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  presetId: string;
  providerKind: string;
  modelSource: string;
  credentialPresent: boolean;
  lastTestKind?: string;
  lastTestMessage?: string;
  lastProbeMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDiscoveryView {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  trusted: boolean;
  source: string;
  tags: string[];
  requiredTools: string[];
}

export interface ToolDiscoveryView {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  source: string;
  enabled: boolean;
  trusted: boolean;
  requiresApproval: boolean;
  tags: string[];
}

export interface ProjectDiscoveryView {
  id: string;
  name: string;
  workspacePath: string;
  summary?: string;
  status: string;
  workspaceLinkStatus?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunDiscoveryView {
  id: string;
  todoId: string;
  status: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  connectionId?: string;
  planVersion?: number;
}

export interface QueueDiscoveryView {
  config: Record<string, unknown>;
  active: Array<{
    runId: string;
    lane: string;
    projectId?: string;
    worktreeIsolated: boolean;
    acquiredAt: string;
    timeoutMs: number;
  }>;
  writeCount: number;
  readOnlyCount: number;
  newTasksPaused: boolean;
  pauseReason?: string;
  resource?: Record<string, unknown>;
}

/** Role JSON Schema for the fixed config mutation workflow. */
export interface RoleConfigSchema {
  type: "object";
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  enums: {
    harness: Harness[];
    reasoningEffort: ReasoningEffort[];
    workspacePermission: Array<"project_only" | "read_only">;
  };
  notes: string[];
}

export interface RolePatchCycleResult {
  workflow: ["read", "schema", "patch", "verify"];
  before: PublicRoleView;
  schema: RoleConfigSchema;
  appliedPatch: UpdateRoleInput;
  after: PublicRoleView;
  diff: Record<string, { from: unknown; to: unknown }>;
  verification?: {
    ready: boolean;
    formalRunStarted: false;
    missingSkills: string[];
    missingTools: string[];
    connection?: { ready: boolean; reason?: string };
  };
}

export type { AgentRole, CreateRoleInput, Harness, ReasoningEffort, RolePermissions, UpdateRoleInput };
