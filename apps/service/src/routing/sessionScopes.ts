/**
 * Deterministic session scopes + isolation policy (Task 38).
 *
 * Inspired by NextClaw sessionKey / bindings isolation — adapted for PAW:
 * global Firstmate, Project Firstmate, Run, Subtask, Reviewer.
 * No chat-channel peer model.
 *
 * Session-local tags / preferred model / temporary instructions never mutate
 * global Agent Role configuration.
 */

import type { MemoryLayer } from "../agentHome/agentHomeTypes.js";

/** Strict session isolation scopes required by Task 38. */
export type SessionScopeKind =
  | "global_firstmate"
  | "project_firstmate"
  | "run"
  | "subtask"
  | "reviewer";

export const SESSION_SCOPE_KINDS: readonly SessionScopeKind[] = [
  "global_firstmate",
  "project_firstmate",
  "run",
  "subtask",
  "reviewer"
] as const;

/**
 * Fully qualified scope identity used to build stable session keys and
 * enforce no-cross-leak between projects, runs, subtasks, reviewers, clients.
 */
export interface SessionScopeRef {
  kind: SessionScopeKind;
  /** Required for project_firstmate; optional parent project for run/subtask/reviewer. */
  projectId?: string;
  /** Required for run / subtask / reviewer. */
  runId?: string;
  /** Required for subtask. */
  subtaskId?: string;
  /** Optional client/customer profile boundary (never share across). */
  clientProfileId?: string;
  /** Optional owning agent role id (informational; isolation is scope-based). */
  roleId?: string;
}

/** Per-session knobs that must not write into global Role config. */
export interface SessionLocalConfig {
  tags: string[];
  preferredModelId?: string;
  /** Ephemeral system/user instruction for this session only. */
  temporaryInstructions?: string;
  /** Session-preferred agent; does not change Role library. */
  agentRoleId?: string;
}

export interface CreateSessionLocalInput {
  tags?: string[];
  preferredModelId?: string;
  temporaryInstructions?: string;
  agentRoleId?: string;
}

export interface ContextShareDecision {
  allowed: boolean;
  reason: string;
  /** Layers that may transfer when partially allowed. */
  allowedLayers: MemoryLayer[];
}

export interface IsolationViolation {
  code:
    | "client_profile_mismatch"
    | "project_mismatch"
    | "run_mismatch"
    | "subtask_mismatch"
    | "reviewer_isolation"
    | "scope_incompatible"
    | "invalid_scope";
  message: string;
}

// ---------------------------------------------------------------------------
// Scope validation + session keys
// ---------------------------------------------------------------------------

export function isSessionScopeKind(value: unknown): value is SessionScopeKind {
  return typeof value === "string" && (SESSION_SCOPE_KINDS as readonly string[]).includes(value);
}

/**
 * Validates required identifiers for each scope kind.
 * Throws a clear Error when the scope is incomplete.
 */
export function assertScopeValid(scope: SessionScopeRef): void {
  if (!isSessionScopeKind(scope.kind)) {
    throw new Error(`Invalid session scope kind: ${String((scope as SessionScopeRef).kind)}`);
  }
  switch (scope.kind) {
    case "global_firstmate":
      return;
    case "project_firstmate":
      if (!trimId(scope.projectId)) {
        throw new Error("project_firstmate scope requires projectId.");
      }
      return;
    case "run":
      if (!trimId(scope.runId)) {
        throw new Error("run scope requires runId.");
      }
      return;
    case "subtask":
      if (!trimId(scope.runId)) {
        throw new Error("subtask scope requires runId.");
      }
      if (!trimId(scope.subtaskId)) {
        throw new Error("subtask scope requires subtaskId.");
      }
      return;
    case "reviewer":
      if (!trimId(scope.runId)) {
        throw new Error("reviewer scope requires runId.");
      }
      return;
  }
}

/**
 * Stable, deterministic session key (NextClaw-inspired, PAW scopes).
 *
 * Examples:
 * - scope:global_firstmate
 * - scope:project_firstmate:project:abc
 * - scope:run:run:r1:project:p1
 * - scope:subtask:run:r1:subtask:s1
 * - scope:reviewer:run:r1:client:c1
 */
export function buildSessionKey(scope: SessionScopeRef): string {
  assertScopeValid(scope);
  const parts: string[] = ["scope", scope.kind];

  if (scope.kind === "project_firstmate") {
    parts.push("project", normalizeToken(scope.projectId!));
  } else if (scope.kind === "run") {
    parts.push("run", normalizeToken(scope.runId!));
    if (trimId(scope.projectId)) parts.push("project", normalizeToken(scope.projectId!));
  } else if (scope.kind === "subtask") {
    parts.push("run", normalizeToken(scope.runId!));
    parts.push("subtask", normalizeToken(scope.subtaskId!));
    if (trimId(scope.projectId)) parts.push("project", normalizeToken(scope.projectId!));
  } else if (scope.kind === "reviewer") {
    parts.push("run", normalizeToken(scope.runId!));
    if (trimId(scope.projectId)) parts.push("project", normalizeToken(scope.projectId!));
  }

  if (trimId(scope.clientProfileId)) {
    parts.push("client", normalizeToken(scope.clientProfileId!));
  }
  if (trimId(scope.roleId) && scope.kind !== "global_firstmate") {
    // Role segment is optional disambiguator for multi-agent same scope.
    parts.push("role", normalizeToken(scope.roleId!));
  }

  return parts.join(":");
}

export function parseSessionKey(sessionKey: string): SessionScopeRef | null {
  const raw = sessionKey.trim().toLowerCase();
  if (!raw.startsWith("scope:")) return null;
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 2) return null;
  const kind = parts[1];
  if (!isSessionScopeKind(kind)) return null;

  const map = parseKeyedSegments(parts.slice(2));
  const scope: SessionScopeRef = { kind };
  if (map.project) scope.projectId = map.project;
  if (map.run) scope.runId = map.run;
  if (map.subtask) scope.subtaskId = map.subtask;
  if (map.client) scope.clientProfileId = map.client;
  if (map.role) scope.roleId = map.role;

  try {
    assertScopeValid(scope);
  } catch {
    return null;
  }
  return scope;
}

export function createSessionLocalConfig(input: CreateSessionLocalInput = {}): SessionLocalConfig {
  return {
    tags: normalizeTags(input.tags),
    preferredModelId: trimId(input.preferredModelId) || undefined,
    temporaryInstructions: normalizeInstructions(input.temporaryInstructions),
    agentRoleId: trimId(input.agentRoleId) || undefined
  };
}

/**
 * Merge session-local preferred model into a selection model id without
 * mutating the Role record itself.
 */
export function resolveSessionModelId(
  roleModelId: string | undefined,
  sessionLocal?: SessionLocalConfig
): string | undefined {
  return sessionLocal?.preferredModelId?.trim() || roleModelId;
}

// ---------------------------------------------------------------------------
// Isolation policy
// ---------------------------------------------------------------------------

/**
 * Memory layers a scope is allowed to load for its own context.
 * Reviewer never loads private role experience; global Firstmate stays global-only.
 */
export function allowedMemoryLayers(scope: SessionScopeRef): MemoryLayer[] {
  assertScopeValid(scope);
  switch (scope.kind) {
    case "global_firstmate":
      return ["global_preferences"];
    case "project_firstmate":
      return ["global_preferences", "project_facts"];
    case "run":
      return ["global_preferences", "project_facts", "task_checkpoints"];
    case "subtask":
      return ["project_facts", "task_checkpoints"];
    case "reviewer":
      // Shared evidence only — no private role_experience / MEMORY.
      return ["project_facts", "task_checkpoints"];
  }
}

/** Whether private MEMORY / role_experience may be loaded for this scope. */
export function allowsPrivateMemory(scope: SessionScopeRef): boolean {
  assertScopeValid(scope);
  // Reviewer and pure global orchestration never load private role memory.
  if (scope.kind === "reviewer" || scope.kind === "global_firstmate") return false;
  return true;
}

/**
 * Decide whether context produced in `from` may be injected into `to`.
 * Default deny across project / client / reviewer / subtask boundaries.
 */
export function canShareContext(from: SessionScopeRef, to: SessionScopeRef): ContextShareDecision {
  try {
    assertScopeValid(from);
    assertScopeValid(to);
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : "Invalid session scope.",
      allowedLayers: []
    };
  }

  // Hard wall: client / customer profiles never mix.
  if (
    trimId(from.clientProfileId)
    && trimId(to.clientProfileId)
    && normalizeToken(from.clientProfileId!) !== normalizeToken(to.clientProfileId!)
  ) {
    return {
      allowed: false,
      reason: "不同客户资料（clientProfile）之间禁止上下文共享，避免串线。",
      allowedLayers: []
    };
  }
  // If one side has a client profile and the other has a different one set vs unset+set mismatch with both set handled above.
  if (
    trimId(from.clientProfileId)
    && trimId(to.clientProfileId) === undefined
    && to.kind !== "global_firstmate"
  ) {
    // Allow only if destination is explicitly global and layers will be filtered to global_preferences.
  }

  // Project hard wall when both sides are project-bound.
  const fromProject = effectiveProjectId(from);
  const toProject = effectiveProjectId(to);
  if (fromProject && toProject && fromProject !== toProject) {
    return {
      allowed: false,
      reason: `不同 Project 之间禁止上下文共享（${fromProject} → ${toProject}）。`,
      allowedLayers: []
    };
  }

  // Reviewer never receives private implementer / sibling agent context as full dump.
  if (to.kind === "reviewer") {
    if (from.kind === "reviewer") {
      const sameRun =
        normalizeToken(from.runId!) === normalizeToken(to.runId!)
        && (!fromProject || !toProject || fromProject === toProject);
      if (!sameRun) {
        return {
          allowed: false,
          reason: "Reviewer 会话仅可共享同一 Run 的审查上下文。",
          allowedLayers: []
        };
      }
      return {
        allowed: true,
        reason: "同一 Run 的 Reviewer 会话可共享审查层上下文。",
        allowedLayers: intersectLayers(allowedMemoryLayers(from), allowedMemoryLayers(to))
      };
    }
    // From implementer run/subtask → reviewer: only non-private project facts / task checkpoints for same run.
    if (from.kind === "run" || from.kind === "subtask" || from.kind === "project_firstmate") {
      if (from.kind === "run" || from.kind === "subtask") {
        if (normalizeToken(from.runId ?? "") !== normalizeToken(to.runId!)) {
          return {
            allowed: false,
            reason: "Reviewer 不得读取其他 Run 的实现上下文。",
            allowedLayers: []
          };
        }
      }
      return {
        allowed: true,
        reason: "Reviewer 仅可读取同 Project/Run 的共享事实与检查点，不含私有记忆。",
        allowedLayers: ["project_facts", "task_checkpoints"]
      };
    }
    if (from.kind === "global_firstmate") {
      return {
        allowed: true,
        reason: "全局偏好可只读注入 Reviewer。",
        allowedLayers: ["global_preferences"]
      };
    }
    return {
      allowed: false,
      reason: "Reviewer 隔离：拒绝来源作用域的上下文注入。",
      allowedLayers: []
    };
  }

  // Source is reviewer → never leak reviewer notes into implementer/private scopes by default.
  // (to.kind is already narrowed away from "reviewer" above.)
  if (from.kind === "reviewer" && to.kind !== "global_firstmate") {
    if (
      (to.kind === "run" || to.kind === "subtask")
      && normalizeToken(from.runId!) === normalizeToken(to.runId ?? "")
    ) {
      return {
        allowed: true,
        reason: "同一 Run 可将 Reviewer 结论只读回传给实现会话（无跨项目）。",
        allowedLayers: ["task_checkpoints"]
      };
    }
    return {
      allowed: false,
      reason: "Reviewer 上下文不得泄漏到无关 Project / 客户资料会话。",
      allowedLayers: []
    };
  }

  // Subtask isolation: sibling subtasks do not share private context.
  if (from.kind === "subtask" && to.kind === "subtask") {
    if (normalizeToken(from.runId!) !== normalizeToken(to.runId!)) {
      return {
        allowed: false,
        reason: "不同 Run 的子任务之间禁止上下文共享。",
        allowedLayers: []
      };
    }
    if (normalizeToken(from.subtaskId!) !== normalizeToken(to.subtaskId!)) {
      return {
        allowed: false,
        reason: "不同子任务（subtask）会话之间禁止直接共享上下文，避免串线。",
        allowedLayers: []
      };
    }
    return {
      allowed: true,
      reason: "同一子任务会话可共享自身上下文。",
      allowedLayers: allowedMemoryLayers(to)
    };
  }

  // Run isolation across different runs.
  if (
    (from.kind === "run" || from.kind === "subtask")
    && (to.kind === "run" || to.kind === "subtask")
  ) {
    if (normalizeToken(from.runId ?? "") !== normalizeToken(to.runId ?? "")) {
      return {
        allowed: false,
        reason: "不同 Run 之间禁止任务检查点与私有上下文共享。",
        allowedLayers: []
      };
    }
  }

  // Global → anything: only global_preferences.
  if (from.kind === "global_firstmate") {
    return {
      allowed: true,
      reason: "全局 Firstmate 偏好可只读注入其他作用域。",
      allowedLayers: ["global_preferences"]
    };
  }

  // Same project firstmate / run family within project.
  if (fromProject && toProject && fromProject === toProject) {
    const layers = intersectLayers(allowedMemoryLayers(from), allowedMemoryLayers(to));
    return {
      allowed: layers.length > 0,
      reason:
        layers.length > 0
          ? "同一 Project 内允许共享约定的记忆层。"
          : "同一 Project 但目标作用域不允许任何重叠记忆层。",
      allowedLayers: layers
    };
  }

  // project_firstmate without matching project on destination.
  if (from.kind === "project_firstmate" && !toProject) {
    return {
      allowed: false,
      reason: "Project Firstmate 上下文不得注入无 Project 绑定的会话。",
      allowedLayers: []
    };
  }

  return {
    allowed: false,
    reason: `作用域 ${from.kind} → ${to.kind} 默认禁止上下文共享。`,
    allowedLayers: []
  };
}

/** Throws when a cross-scope share would leak context. */
export function assertNoCrossLeak(from: SessionScopeRef, to: SessionScopeRef): void {
  const decision = canShareContext(from, to);
  if (!decision.allowed) {
    const error = new Error(decision.reason) as Error & { isolation?: IsolationViolation };
    error.isolation = {
      code: classifyIsolationCode(decision.reason),
      message: decision.reason
    };
    throw error;
  }
}

/**
 * Filter a free-form context bag so only allowed layers / fields pass the wall.
 * Unknown keys are stripped when destination is reviewer or cross-project denied.
 */
export function filterContextForScope<T extends Record<string, unknown>>(
  scope: SessionScopeRef,
  context: T,
  options: { includePrivateMemory?: boolean } = {}
): Partial<T> {
  assertScopeValid(scope);
  const layers = new Set(allowedMemoryLayers(scope));
  const allowPrivate = options.includePrivateMemory === true && allowsPrivateMemory(scope);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(context)) {
    if (key === "privateMemory" || key === "role_experience" || key === "MEMORY") {
      if (allowPrivate) out[key] = value;
      continue;
    }
    if (key === "global_preferences" || key === "project_facts" || key === "task_checkpoints" || key === "role_experience") {
      if (layers.has(key as MemoryLayer) || (key === "role_experience" && allowPrivate)) {
        out[key] = value;
      }
      continue;
    }
    // Non-layer metadata (ids, titles) — only same-scope safe fields.
    if (key === "projectId" || key === "runId" || key === "subtaskId" || key === "clientProfileId") {
      out[key] = value;
      continue;
    }
    if (key === "sharedEvidence" || key === "artifacts" || key === "summary") {
      // Reviewer and run scopes may see shared evidence.
      if (scope.kind !== "global_firstmate") out[key] = value;
      continue;
    }
    // Drop anything else for isolation-by-default.
  }

  return out as Partial<T>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function effectiveProjectId(scope: SessionScopeRef): string | undefined {
  const id = trimId(scope.projectId);
  return id ? normalizeToken(id) : undefined;
}

function intersectLayers(a: MemoryLayer[], b: MemoryLayer[]): MemoryLayer[] {
  const setB = new Set(b);
  return a.filter((layer) => setB.has(layer));
}

function classifyIsolationCode(reason: string): IsolationViolation["code"] {
  if (/客户|client/i.test(reason)) return "client_profile_mismatch";
  if (/Reviewer|审查/i.test(reason)) return "reviewer_isolation";
  if (/子任务|subtask/i.test(reason)) return "subtask_mismatch";
  if (/Run/i.test(reason)) return "run_mismatch";
  if (/Project/i.test(reason)) return "project_mismatch";
  if (/Invalid|无效|requires/i.test(reason)) return "invalid_scope";
  return "scope_incompatible";
}

function parseKeyedSegments(parts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const key = parts[i]!;
    const value = parts[i + 1]!;
    if (key && value) out[key] = value;
  }
  return out;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function trimId(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const t = tag.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function normalizeInstructions(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
