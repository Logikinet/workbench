/**
 * Skill catalog types (Task 22).
 * Skills encode methods/instructions; Tools encode permission capabilities.
 */

import type { ToolPermissionCategory } from "../tools/toolTypes.js";
import type { Harness, ReasoningEffort, RolePermissions } from "../roles/roleService.js";

export type SkillSource = "builtin" | "trusted_dir" | "imported";

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
  createdAt: string;
  updatedAt: string;
}

export interface SkillState {
  schemaVersion: 1;
  /** Absolute trusted directories the operator approved for skill import. */
  trustedDirectories: string[];
  /** Runtime flags for skills (enable/trust) keyed by skill id. */
  overrides: Record<string, { enabled?: boolean; trusted?: boolean; trustedAt?: string }>;
}

export interface ImportSkillsResult {
  trustedDirectory: string;
  imported: SkillDefinition[];
  skipped: Array<{ id: string; reason: string }>;
  errors: Array<{ path: string; reason: string }>;
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
