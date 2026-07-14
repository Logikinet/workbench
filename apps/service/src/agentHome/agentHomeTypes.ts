/**
 * Agent Home, profile files, and layered memory (Task 37).
 *
 * Each long-term Agent Role owns an isolated Home directory.
 * Temporary agents use a disposable temp home until promoted.
 */

/** Profile / continuity files seeded into every Home. */
export const HOME_PROFILE_FILES = [
  "AGENTS.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "MEMORY.md"
] as const;

export type HomeProfileFile = (typeof HOME_PROFILE_FILES)[number];

export type HomeKind = "long_term" | "temporary";

/**
 * Layered memory scopes — load only what the session needs.
 * - global_preferences: user prefs that apply across projects (still role-private)
 * - project_facts: durable facts scoped to a project
 * - task_checkpoints: short-lived task/run checkpoints
 * - role_experience: long-term role methods/lessons (private)
 */
export type MemoryLayer =
  | "global_preferences"
  | "project_facts"
  | "task_checkpoints"
  | "role_experience";

export const MEMORY_LAYERS: readonly MemoryLayer[] = [
  "global_preferences",
  "project_facts",
  "task_checkpoints",
  "role_experience"
] as const;

/** Only durable facts may be stored as facts; inferences stay tagged. */
export type MemoryConfidence = "fact" | "inference";

export interface AgentHomeMeta {
  schemaVersion: 1;
  /** Stable owner id: roleId for long-term, tempId for temporary. */
  homeId: string;
  /** Bound Agent Role id when known (long-term always; temp may be unbound). */
  roleId?: string;
  kind: HomeKind;
  /** Display name seed for templates. */
  displayName?: string;
  /** Template content version applied to this home. */
  templateVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentHomeDescriptor {
  homeId: string;
  roleId?: string;
  kind: HomeKind;
  /** Absolute path to the Home directory. */
  path: string;
  templateVersion: number;
  displayName?: string;
  files: HomeProfileFile[];
  skillsDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface HomeSkillSummary {
  id: string;
  /** Relative path under skills/ (e.g. "review/SKILL.md" or "notes.md"). */
  relativePath: string;
  absolutePath: string;
}

export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  content: string;
  /** Required provenance — who/what produced this entry. */
  source: string;
  confidence: MemoryConfidence;
  projectId?: string;
  taskId?: string;
  createdAt: string;
}

export interface WriteMemoryInput {
  layer: MemoryLayer;
  content: string;
  /** Required. Memory writes without a source are rejected. */
  source: string;
  /**
   * Defaults to "fact". Uncertain inferences must use "inference"
   * and are never upgraded to fact by this service.
   */
  confidence?: MemoryConfidence;
  projectId?: string;
  taskId?: string;
}

export interface LoadHomeContextOptions {
  /** Which memory layers to include (minimal load). Empty = none. */
  layers?: MemoryLayer[];
  /**
   * When true, include private MEMORY.md and role_experience.
   * Must only be used for the owning role's private session — never for
   * shared evidence, other agents, or ordinary artifacts.
   */
  includePrivateMemory?: boolean;
  /** Filter project_facts / task_checkpoints to a project. */
  projectId?: string;
  /** Filter task_checkpoints to a task/run. */
  taskId?: string;
  /** Profile files to load (default: AGENTS, IDENTITY, USER, TOOLS — not MEMORY). */
  profileFiles?: HomeProfileFile[];
  /** When true, load skills/ bodies into the context. */
  includeSkills?: boolean;
}

/**
 * Context composition for a single owner. Private long-term memory is only
 * present when includePrivateMemory was requested for that owner.
 */
export interface LoadedHomeContext {
  homeId: string;
  roleId?: string;
  kind: HomeKind;
  path: string;
  /** Always the system hard rules — Home files cannot replace these. */
  firstmateHardRules: string;
  /** True marker that hard rules are system-owned. */
  hardRulesSource: "system";
  profile: Partial<Record<HomeProfileFile, string>>;
  /** Layer payloads keyed by layer (only requested layers). */
  memoryLayers: Partial<Record<MemoryLayer, MemoryEntry[]>>;
  skills: Array<{ id: string; relativePath: string; content: string }>;
  /** Files that were intentionally omitted (privacy / minimal load). */
  omitted: string[];
}

export interface TemplateFileDiff {
  file: HomeProfileFile;
  current: string;
  defaultContent: string;
  changed: boolean;
}

export interface TemplateDiffResult {
  homeId: string;
  templateVersion: number;
  currentTemplateVersion: number;
  files: TemplateFileDiff[];
}

export interface PromoteTempHomeInput {
  tempHomeId: string;
  roleId: string;
  displayName?: string;
}

/** Shared export surface — deliberately excludes private memory. */
export interface SharedHomeExport {
  homeId: string;
  roleId?: string;
  kind: HomeKind;
  /** Public profile only (never MEMORY.md or private layers). */
  profile: Partial<Record<Exclude<HomeProfileFile, "MEMORY.md">, string>>;
  /** Always empty: private memory never enters shared evidence/artifacts. */
  privateMemoryIncluded: false;
  skills: Array<{ id: string; relativePath: string }>;
}
