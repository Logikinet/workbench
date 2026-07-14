/**
 * Agent capability runtime (Task 22).
 *
 * Resolves Role + plan allowlists into the concrete Skills/Tools an execution
 * instance may see, with trust gates, permission enforcement, harness config
 * application (no silent ignore), and a timeline capability snapshot.
 */

import type { Harness, ReasoningEffort, RolePermissions } from "../roles/roleService.js";
import type { ToolRegistry } from "../tools/toolRegistry.js";
import type { ToolDefinition, ToolPermissionCategory } from "../tools/toolTypes.js";
import type { SkillService } from "./skillService.js";
import type {
  CapabilityBlock,
  CapabilitySnapshot,
  ExposedTool,
  HarnessConfigResolution,
  LoadedSkillExposure,
  PlanCapabilityAllowlist,
  ResolveCapabilitiesInput,
  ResolveCapabilitiesResult,
  RoleCapabilityConfig
} from "./skillTypes.js";

export interface CapabilityRuntimeOptions {
  skills: SkillService;
  tools: ToolRegistry;
}

/** Harnesses known to apply reasoningEffort. */
const REASONING_SUPPORTED_HARNESSES = new Set<Harness>(["api", "codex-cli"]);

export class CapabilityRuntime {
  constructor(private readonly options: CapabilityRuntimeOptions) {}

  /**
   * Resolve effective skills/tools for an execution instance.
   * Only Role-enabled ∩ plan-allowed ∩ catalog-enabled ∩ trusted (when required)
   * capabilities are exposed. Permission conflicts are blocked, not silently allowed.
   */
  resolve(input: ResolveCapabilitiesInput): ResolveCapabilitiesResult {
    const requireTrust = input.requireTrust !== false;
    const enforcePermissions = input.enforceRolePermissions !== false;
    const role = input.role;
    const blocked: CapabilityBlock[] = [];
    const pendingTrust: ResolveCapabilitiesResult["pendingTrust"] = [];

    if (role.enabled === false) {
      const harnessConfig = resolveHarnessConfig(role, input);
      const snapshot = buildSnapshot(role, [], [], harnessConfig, [
        {
          kind: "skill",
          id: "*",
          reason: "role_disabled",
          message: "Role 已停用；不暴露任何 Skill 或 Tool。"
        }
      ]);
      return {
        ok: false,
        skills: [],
        tools: [],
        permissions: { ...role.permissions },
        harnessConfig,
        blocked: snapshot.blocked,
        snapshot,
        composedInstructions: role.systemInstruction?.trim() || "",
        pendingTrust: []
      };
    }

    const roleSkillNames = unique(role.skills);
    const roleToolNames = unique(role.tools);
    const planSkills = input.plan?.skills ? new Set(unique(input.plan.skills)) : undefined;
    const planTools = input.plan?.tools ? new Set(unique(input.plan.tools)) : undefined;

    const skills: LoadedSkillExposure[] = [];
    for (const name of roleSkillNames) {
      if (planSkills && !planSkills.has(name) && !setHasName(planSkills, name)) {
        blocked.push({
          kind: "skill",
          id: name,
          reason: "not_on_plan",
          message: `Skill "${name}" is on the Role but not allowed by the current plan.`
        });
        continue;
      }

      const skill = this.options.skills.resolveByNameOrId(name);
      if (!skill) {
        blocked.push({
          kind: "skill",
          id: name,
          reason: "missing_catalog",
          message: `Skill "${name}" is not in the catalog (name-only Role entry could not be migrated).`
        });
        continue;
      }

      if (!skill.enabled) {
        blocked.push({
          kind: "skill",
          id: skill.id,
          reason: "disabled",
          message: `Skill "${skill.id}" is disabled.`
        });
        continue;
      }

      if (requireTrust && !skill.trusted) {
        blocked.push({
          kind: "skill",
          id: skill.id,
          reason: "untrusted",
          message: `Skill "${skill.id}" requires user trust before first use.`
        });
        pendingTrust.push({ kind: "skill", id: skill.id, name: skill.name });
        continue;
      }

      skills.push({
        id: skill.id,
        name: skill.name,
        version: skill.version,
        source: skill.source,
        trusted: skill.trusted,
        enabled: skill.enabled,
        instructions: skill.instructions,
        requiredTools: [...skill.requiredTools],
        permissionHints: [...skill.permissionHints]
      });
    }

    // Plan-only names not on Role are never exposed (cannot bypass Role).
    if (planSkills) {
      for (const planName of planSkills) {
        if (!roleSkillNames.includes(planName) && !roleHasName(roleSkillNames, planName)) {
          blocked.push({
            kind: "skill",
            id: planName,
            reason: "not_on_role",
            message: `Plan requested Skill "${planName}" but the Role does not authorize it.`
          });
        }
      }
    }

    const tools: ExposedTool[] = [];
    for (const name of roleToolNames) {
      if (planTools && !planTools.has(name) && !setHasName(planTools, name)) {
        blocked.push({
          kind: "tool",
          id: name,
          reason: "not_on_plan",
          message: `Tool "${name}" is on the Role but not allowed by the current plan.`
        });
        continue;
      }

      const tool = this.options.tools.resolveByNameOrId(name);
      if (!tool) {
        blocked.push({
          kind: "tool",
          id: name,
          reason: "missing_catalog",
          message: `Tool "${name}" is not in the registry (name-only Role entry could not be migrated).`
        });
        continue;
      }

      if (!tool.enabled) {
        blocked.push({
          kind: "tool",
          id: tool.id,
          reason: "disabled",
          message: `Tool "${tool.id}" is disabled.`
        });
        continue;
      }

      if (requireTrust && !tool.trusted) {
        blocked.push({
          kind: "tool",
          id: tool.id,
          reason: "untrusted",
          message: `Tool "${tool.id}" requires user trust before first use.`
        });
        pendingTrust.push({ kind: "tool", id: tool.id, name: tool.name });
        continue;
      }

      if (enforcePermissions) {
        const permissionBlock = checkToolAgainstPermissions(tool, role.permissions);
        if (permissionBlock) {
          blocked.push(permissionBlock);
          continue;
        }
      }

      // Dangerous tools always surface approval requirement; still exposed if trusted+enabled
      // but callers must honor requiresApproval (cannot bypass approval boundaries).
      tools.push({
        id: tool.id,
        name: tool.name,
        version: tool.version,
        category: tool.category,
        trusted: tool.trusted,
        enabled: tool.enabled,
        requiresApproval: tool.requiresApproval || tool.category === "dangerous",
        description: tool.description
      });
    }

    if (planTools) {
      for (const planName of planTools) {
        if (!roleToolNames.includes(planName) && !roleHasName(roleToolNames, planName)) {
          blocked.push({
            kind: "tool",
            id: planName,
            reason: "not_on_role",
            message: `Plan requested Tool "${planName}" but the Role does not authorize it.`
          });
        }
      }
    }

    const harnessConfig = resolveHarnessConfig(role, input);
    const snapshot = buildSnapshot(role, skills, tools, harnessConfig, blocked);
    const composedInstructions = composeInstructions(role.systemInstruction, skills);

    return {
      ok: blocked.every((entry) => entry.reason !== "role_disabled"),
      skills,
      tools,
      permissions: { ...role.permissions },
      harnessConfig,
      blocked,
      snapshot,
      composedInstructions,
      pendingTrust
    };
  }

  /**
   * Migrate name-only Role skill/tool arrays against the live catalogs.
   * Unknown names are returned for verify UIs; known names normalize to catalog ids.
   * Does not mutate historical Run data.
   */
  migrateRoleNames(role: Pick<RoleCapabilityConfig, "skills" | "tools">): {
    skills: string[];
    tools: string[];
    unknownSkills: string[];
    unknownTools: string[];
    /** True when every name resolved — safe for historical Role configs. */
    complete: boolean;
  } {
    const skills: string[] = [];
    const unknownSkills: string[] = [];
    for (const name of unique(role.skills)) {
      const skill = this.options.skills.resolveByNameOrId(name);
      if (skill) skills.push(skill.id);
      else unknownSkills.push(name);
    }

    const tools: string[] = [];
    const unknownTools: string[] = [];
    for (const name of unique(role.tools)) {
      const tool = this.options.tools.resolveByNameOrId(name);
      if (tool) tools.push(tool.id);
      else unknownTools.push(name);
    }

    return {
      skills,
      tools,
      unknownSkills,
      unknownTools,
      complete: unknownSkills.length === 0 && unknownTools.length === 0
    };
  }

  /** Build a timeline-ready snapshot without re-filtering (e.g. after execution). */
  captureSnapshot(result: ResolveCapabilitiesResult, role?: RoleCapabilityConfig): CapabilitySnapshot {
    if (role) {
      return buildSnapshot(role, result.skills, result.tools, result.harnessConfig, result.blocked);
    }
    return result.snapshot;
  }
}

export function resolveHarnessConfig(
  role: Pick<RoleCapabilityConfig, "harness" | "reasoningEffort">,
  input: Pick<ResolveCapabilitiesInput, "harnessSupportsReasoning" | "extraHarnessConfig"> = {}
): HarnessConfigResolution {
  const supportsReasoning =
    input.harnessSupportsReasoning
    ?? REASONING_SUPPORTED_HARNESSES.has(role.harness);

  const reasoningEffort = supportsReasoning
    ? {
        requested: role.reasoningEffort,
        supported: true,
        applied: role.reasoningEffort,
        status: "applied" as const
      }
    : {
        requested: role.reasoningEffort,
        supported: false,
        applied: undefined,
        status: "unsupported" as const,
        message:
          `Harness "${role.harness}" does not support reasoningEffort; `
          + `requested "${role.reasoningEffort}" was not applied (not silently ignored).`
      };

  const unsupportedRequested: HarnessConfigResolution["unsupportedRequested"] = [];
  if (input.extraHarnessConfig) {
    for (const [key, value] of Object.entries(input.extraHarnessConfig)) {
      if (key === "reasoningEffort") continue;
      // No other harness knobs are applied by this runtime yet — surface explicitly.
      unsupportedRequested.push({
        key,
        value,
        message: `Harness config "${key}" is not supported by capability runtime and was not applied.`
      });
    }
  }

  return {
    harness: role.harness,
    reasoningEffort,
    unsupportedRequested
  };
}

function checkToolAgainstPermissions(
  tool: ToolDefinition,
  permissions: RolePermissions
): CapabilityBlock | undefined {
  if (tool.category === "shell" && !permissions.shell) {
    return {
      kind: "tool",
      id: tool.id,
      reason: "permission_denied",
      message: `Tool "${tool.id}" requires shell permission which the Role does not grant.`
    };
  }
  if (tool.category === "network" && !permissions.network) {
    return {
      kind: "tool",
      id: tool.id,
      reason: "permission_denied",
      message: `Tool "${tool.id}" requires network permission which the Role does not grant.`
    };
  }
  if (tool.category === "write" && permissions.workspace === "read_only") {
    return {
      kind: "tool",
      id: tool.id,
      reason: "permission_denied",
      message: `Tool "${tool.id}" requires write access but Role workspace is read_only.`
    };
  }
  if (tool.category === "dangerous") {
    // Dangerous tools may be listed only when shell is also granted; still require approval.
    if (!permissions.shell) {
      return {
        kind: "tool",
        id: tool.id,
        reason: "permission_denied",
        message: `Dangerous tool "${tool.id}" requires shell permission and explicit approval; Role lacks shell.`
      };
    }
  }
  return undefined;
}

function buildSnapshot(
  role: RoleCapabilityConfig,
  skills: LoadedSkillExposure[],
  tools: ExposedTool[],
  harnessConfig: HarnessConfigResolution,
  blocked: CapabilityBlock[]
): CapabilitySnapshot {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    roleId: role.id,
    roleName: role.name,
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      source: skill.source,
      trusted: skill.trusted
    })),
    tools: tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      version: tool.version,
      category: tool.category,
      trusted: tool.trusted,
      requiresApproval: tool.requiresApproval
    })),
    permissions: { ...role.permissions },
    harnessConfig,
    blocked: blocked.map((entry) => ({ ...entry }))
  };
}

function composeInstructions(
  systemInstruction: string | undefined,
  skills: LoadedSkillExposure[]
): string {
  const parts: string[] = [];
  if (systemInstruction?.trim()) parts.push(systemInstruction.trim());
  for (const skill of skills) {
    if (skill.instructions.trim()) {
      parts.push(`## Skill: ${skill.name} (v${skill.version})\n\n${skill.instructions.trim()}`);
    }
  }
  return parts.join("\n\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function setHasName(set: Set<string>, name: string): boolean {
  if (set.has(name)) return true;
  for (const entry of set) {
    if (entry === name) return true;
  }
  return false;
}

function roleHasName(roleNames: string[], name: string): boolean {
  return roleNames.includes(name);
}

export type {
  CapabilityBlock,
  CapabilitySnapshot,
  ExposedTool,
  HarnessConfigResolution,
  LoadedSkillExposure,
  PlanCapabilityAllowlist,
  ResolveCapabilitiesInput,
  ResolveCapabilitiesResult,
  RoleCapabilityConfig,
  ReasoningEffort,
  ToolPermissionCategory
};
