/**
 * Skill catalog types (Task 22 + Task 40 lifecycle).
 * Skills encode methods/instructions; Tools encode permission capabilities.
 *
 * Source priority (higher wins; builtin is never silently overwritten):
 *   builtin (100) > project (80) > user_local/trusted_dir (60) > imported (50) > catalog (40)
 */

import type { ToolPermissionCategory } from "../tools/toolTypes.js";
import type { Harness, ReasoningEffort, RolePermissions } from "../roles/roleService.js";

/** Origin of a skill package. `trusted_dir` is kept as an alias of user_local for Task 22. */
export type SkillSource =
  | "builtin"
  | "user_local"
  | "project"
  | "catalog"
  | "trusted_dir"
  | "imported";

/** Higher number = stronger claim when resolving name conflicts. */
export const SKILL_SOURCE_PRIORITY: Readonly<Record<SkillSource, number>> = {
  builtin: 100,
  project: 80,
  user_local: 60,
  trusted_dir: 60,
  imported: 50,
  catalog: 40
};

export interface SkillFrontmatterMeta {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  tags?: string[];
  /** Tools this skill expects (names/ids). */
  requiredTools?: string[];
  /** Permission category hints for trust UI. */
  permissionHints?: ToolPermissionCategory[];
}

export type SkillInstallStatus =
  | "builtin"
  | "not_installed"
  | "installed"
  | "update_available"
  | "drifted"
  | "disabled";

export interface SkillVersionSnapshot {
  version: string;
  contentHash: string;
  rawContent: string;
  capturedAt: string;
  /** Catalog id when this snapshot came from the catalog. */
  catalogId?: string;
}

/** Durable install inventory for a skill (source + version + rollback history). */
export interface SkillInstallRecord {
  skillId: string;
  source: SkillSource;
  catalogId?: string;
  version: string;
  contentHash: string;
  installedAt: string;
  updatedAt: string;
  /** Previous versions for rollback (newest first, capped). */
  history: SkillVersionSnapshot[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Absolute path to SKILL.md when loaded from disk. */
  path?: string;
  /** Directory that contained the skill (must be under a trusted root). */
  sourceDir?: string;
  source: SkillSource;
  /** Optional project id when source is project. */
  projectId?: string;
  /** Catalog entry id when installed from the local catalog. */
  catalogId?: string;
  enabled: boolean;
  trusted: boolean;
  trustedAt?: string;
  tags: string[];
  requiredTools: string[];
  permissionHints: ToolPermissionCategory[];
  author?: string;
  /** Full SKILL.md raw text (frontmatter + body). */
  rawContent?: string;
  /** Instruction body with frontmatter stripped. */
  instructions: string;
  /** sha256 of raw content for drift detection. */
  contentHash?: string;
  installStatus?: SkillInstallStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SkillConflict {
  skillId: string;
  winner: SkillSource;
  losers: Array<{ source: SkillSource; path?: string; reason: string }>;
}

export interface SkillDetail extends SkillDefinition {
  installStatus: SkillInstallStatus;
  installRecord?: SkillInstallRecord;
  contentHash: string;
  permissionSummary: SkillPermissionSummary;
  conflicts: SkillConflict["losers"];
  /** Whether a newer catalog version exists. */
  updateAvailable: boolean;
  catalogVersion?: string;
  drifted: boolean;
}

export interface SkillPermissionSummary {
  skillId: string;
  name: string;
  version: string;
  source: SkillSource;
  permissionHints: ToolPermissionCategory[];
  requiredTools: string[];
  trusted: boolean;
  /** Human-readable lines for first-run trust UI. */
  lines: string[];
  requiresTrustConfirmation: boolean;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  author?: string;
  recommended?: boolean;
  requiredTools: string[];
  permissionHints: ToolPermissionCategory[];
  instructions: string;
  /** Optional prebuilt SKILL.md; otherwise synthesized. */
  rawContent?: string;
}

export interface SkillCatalogSearchQuery {
  query?: string;
  tags?: string[];
  recommendedOnly?: boolean;
  /** When true, only return catalog rows that are not yet installed. */
  notInstalledOnly?: boolean;
}

export interface SkillCatalogSearchResult {
  /** False when the catalog provider is offline — installed skills remain manageable. */
  catalogAvailable: boolean;
  entries: Array<
    SkillCatalogEntry & {
      installed: boolean;
      installedVersion?: string;
      recommended: boolean;
    }
  >;
  installedCount: number;
}

export interface SkillDriftReport {
  skillId: string;
  drifted: boolean;
  expectedHash?: string;
  actualHash?: string;
  expectedVersion?: string;
  actualVersion?: string;
  message: string;
}

export interface SkillUpdatePreview {
  skillId: string;
  currentVersion: string;
  targetVersion: string;
  drifted: boolean;
  drift?: SkillDriftReport;
  /** Unified-style text diff (local/current → target). */
  diff: string;
  permissionSummary: SkillPermissionSummary;
  requiresConfirm: true;
  catalogId?: string;
}

export interface SkillInstallPreview {
  catalogId: string;
  entry: SkillCatalogEntry;
  permissionSummary: SkillPermissionSummary;
  wouldOverwrite?: { skillId: string; source: SkillSource; version: string };
  blockedByBuiltin: boolean;
  requiresConfirm: true;
}

export interface SkillState {
  schemaVersion: 1;
  /** Absolute trusted directories the operator approved for skill import (user_local). */
  trustedDirectories: string[];
  /** Project-scoped skill roots (project source, higher than user_local). */
  projectDirectories?: Array<{ projectId: string; directory: string }>;
  /** Directory where catalog installs are written (absolute). */
  installRoot?: string;
  /** Runtime flags for skills (enable/trust) keyed by skill id. */
  overrides: Record<string, { enabled?: boolean; trusted?: boolean; trustedAt?: string }>;
  /** Install inventory keyed by skill id. */
  installs?: Record<string, SkillInstallRecord>;
}

export interface ImportSkillsResult {
  trustedDirectory: string;
  imported: SkillDefinition[];
  skipped: Array<{ id: string; reason: string }>;
  errors: Array<{ path: string; reason: string }>;
  conflicts?: SkillConflict[];
}

/** Role-shaped input for capability resolution (name-only skills/tools supported). */
export interface RoleCapabilityConfig {
  id?: string;
  name?: string;
  harness: Harness;
  reasoningEffort: ReasoningEffort;
  skills: string[];
  tools: string[];
  permissions: RolePermissions;
  enabled?: boolean;
  systemInstruction?: string;
}

export interface PlanCapabilityAllowlist {
  /** When set, only these skill names/ids from the Role are exposed. */
  skills?: string[];
  /** When set, only these tool names/ids from the Role are exposed. */
  tools?: string[];
}

export type HarnessConfigStatus = "applied" | "unsupported" | "partial";

export interface HarnessConfigFieldResolution<T> {
  requested: T;
  supported: boolean;
  /** Present only when the harness actually applied the value. */
  applied?: T;
  status: HarnessConfigStatus;
  /** User-visible reason when not fully applied — never silently ignored. */
  message?: string;
}

export interface HarnessConfigResolution {
  harness: Harness;
  reasoningEffort: HarnessConfigFieldResolution<ReasoningEffort>;
  /** Other harness knobs can be added later without silent drops. */
  unsupportedRequested: Array<{ key: string; value: unknown; message: string }>;
}

export interface LoadedSkillExposure {
  id: string;
  name: string;
  version: string;
  source: SkillSource;
  trusted: boolean;
  enabled: boolean;
  instructions: string;
  requiredTools: string[];
  permissionHints: ToolPermissionCategory[];
}

export interface ExposedTool {
  id: string;
  name: string;
  version: string;
  category: ToolPermissionCategory;
  trusted: boolean;
  enabled: boolean;
  requiresApproval: boolean;
  description: string;
}

export type CapabilityBlockReason =
  | "role_disabled"
  | "not_on_role"
  | "not_on_plan"
  | "disabled"
  | "untrusted"
  | "missing_catalog"
  | "permission_denied"
  | "requires_approval_gate";

export interface CapabilityBlock {
  kind: "skill" | "tool";
  id: string;
  reason: CapabilityBlockReason;
  message: string;
}

/**
 * Durable, secret-free snapshot for Run timeline:
 * what was actually loaded, versions, and permission snapshot.
 */
export interface CapabilitySnapshot {
  schemaVersion: 1;
  capturedAt: string;
  roleId?: string;
  roleName?: string;
  skills: Array<{
    id: string;
    name: string;
    version: string;
    source: SkillSource;
    trusted: boolean;
  }>;
  tools: Array<{
    id: string;
    name: string;
    version: string;
    category: ToolPermissionCategory;
    trusted: boolean;
    requiresApproval: boolean;
  }>;
  permissions: RolePermissions;
  harnessConfig: HarnessConfigResolution;
  blocked: CapabilityBlock[];
}

export interface ResolveCapabilitiesInput {
  role: RoleCapabilityConfig;
  plan?: PlanCapabilityAllowlist;
  /**
   * When true, untrusted skills/tools are reported as blocked and omitted
   * from exposures (default true — first use requires trust).
   */
  requireTrust?: boolean;
  /**
   * When true, tools that conflict with role.permissions are blocked (default true).
   */
  enforceRolePermissions?: boolean;
  /**
   * Optional harness capability probe (e.g. RuntimeCapabilities.reasoning).
   * When omitted, built-in harness matrix is used.
   */
  harnessSupportsReasoning?: boolean;
  /** Extra requested harness keys that must not be silently dropped. */
  extraHarnessConfig?: Record<string, unknown>;
}

export interface ResolveCapabilitiesResult {
  ok: boolean;
  skills: LoadedSkillExposure[];
  tools: ExposedTool[];
  permissions: RolePermissions;
  harnessConfig: HarnessConfigResolution;
  blocked: CapabilityBlock[];
  /** Ready for timeline attachment. */
  snapshot: CapabilitySnapshot;
  /**
   * System prompt fragment: role instruction + loaded skill bodies.
   * Callers may inject into model/runtime; empty skills contribute nothing.
   */
  composedInstructions: string;
  /** Skill/tool names that still need user trust before first use. */
  pendingTrust: Array<{ kind: "skill" | "tool"; id: string; name: string }>;
}

/** Built-in skill instruction seeds for name-only Role migration. */
export const BUILTIN_SKILL_SEEDS: ReadonlyArray<{
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  requiredTools: string[];
  permissionHints: ToolPermissionCategory[];
  instructions: string;
}> = [
  {
    id: "implement",
    name: "implement",
    version: "1.0.0",
    description: "Minimal, test-backed implementation inside the approved workspace.",
    tags: ["coding", "implementation"],
    requiredTools: ["filesystem"],
    permissionHints: ["write"],
    instructions: [
      "# Implement",
      "",
      "Make the smallest correct change that satisfies the approved plan.",
      "Prefer existing patterns. Do not expand scope.",
      "Stay inside the Project workspace and respect Role tool permissions."
    ].join("\n")
  },
  {
    id: "tdd",
    name: "tdd",
    version: "1.0.0",
    description: "Test-driven development workflow.",
    tags: ["coding", "testing"],
    requiredTools: ["filesystem", "shell"],
    permissionHints: ["write", "shell"],
    instructions: [
      "# TDD",
      "",
      "Write or update failing tests first, then implement until green.",
      "Keep verification commands within the approved plan."
    ].join("\n")
  },
  {
    id: "code-review",
    name: "code-review",
    version: "1.0.0",
    description: "Structured code review without mutating formal artifacts unless approved.",
    tags: ["review"],
    requiredTools: ["filesystem", "read_file"],
    permissionHints: ["readonly"],
    instructions: [
      "# Code Review",
      "",
      "Review diffs for correctness, security, and plan alignment.",
      "Report findings; do not apply fixes unless the plan authorizes write tools."
    ].join("\n")
  },
  {
    id: "research",
    name: "research",
    version: "1.0.0",
    description: "Evidence-first research with citations.",
    tags: ["research"],
    requiredTools: ["web", "filesystem"],
    permissionHints: ["network", "write"],
    instructions: [
      "# Research",
      "",
      "Gather evidence before conclusions. Record sources.",
      "Do not send external content without network and externalSend permissions."
    ].join("\n")
  },
  {
    id: "documents",
    name: "documents",
    version: "1.0.0",
    description: "Structured document and paper drafting.",
    tags: ["writing", "documents"],
    requiredTools: ["filesystem"],
    permissionHints: ["write"],
    instructions: [
      "# Documents",
      "",
      "Produce structured drafts aligned with the approved outline.",
      "Keep artifacts under the Project workspace."
    ].join("\n")
  },
  {
    id: "skill-creator",
    name: "skill-creator",
    version: "1.0.0",
    description: "Author new SKILL.md packages for trusted directories.",
    tags: ["meta", "skills"],
    requiredTools: ["filesystem"],
    permissionHints: ["write"],
    instructions: [
      "# Skill Creator",
      "",
      "Write SKILL.md with YAML frontmatter (name, version, description, tags).",
      "Skills are methods; do not grant tools silently."
    ].join("\n")
  }
];
