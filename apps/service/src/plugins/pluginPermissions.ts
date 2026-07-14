/**
 * Permission isolation for plugins (Task 46).
 * Extensions only receive Manifest-declared permissions that the operator approved.
 */

import {
  PLUGIN_PERMISSIONS,
  type PluginContributionKind,
  type PluginPermission,
  type PluginPermissionDenial
} from "./pluginTypes.js";

const CONTRIBUTION_PERMISSION: Record<PluginContributionKind, PluginPermission> = {
  provider: "provider.register",
  harness: "harness.register",
  tool: "tool.register",
  skill_source: "skill_source.register",
  artifact_renderer: "artifact_renderer.register",
  trigger: "trigger.register"
};

export function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === "string" && (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}

export function normalizePermissions(values: unknown): PluginPermission[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<PluginPermission>();
  const out: PluginPermission[] = [];
  for (const value of values) {
    if (!isPluginPermission(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function permissionForContribution(kind: PluginContributionKind): PluginPermission {
  return CONTRIBUTION_PERMISSION[kind];
}

/**
 * Validate operator approvals against declared permissions.
 * By default every declared permission must be approved (explicit trust).
 */
export function validatePermissionApproval(input: {
  declared: PluginPermission[];
  approved: PluginPermission[];
  requireAllDeclared?: boolean;
}): { ok: true; approved: PluginPermission[] } | { ok: false; denials: PluginPermissionDenial[] } {
  const declared = normalizePermissions(input.declared);
  const approved = normalizePermissions(input.approved);
  const declaredSet = new Set(declared);
  const denials: PluginPermissionDenial[] = [];

  for (const perm of approved) {
    if (!declaredSet.has(perm)) {
      denials.push({
        permission: perm,
        reason: `Permission "${perm}" was not declared in the plugin manifest.`
      });
    }
  }

  if (input.requireAllDeclared !== false) {
    const approvedSet = new Set(approved);
    for (const perm of declared) {
      if (!approvedSet.has(perm)) {
        denials.push({
          permission: perm,
          reason: `Declared permission "${perm}" was not approved by the operator.`
        });
      }
    }
  }

  if (denials.length > 0) {
    return { ok: false, denials };
  }
  // Intersection: only declared ∩ approved is effective.
  return {
    ok: true,
    approved: approved.filter((p) => declaredSet.has(p))
  };
}

export function assertPermission(
  approved: readonly PluginPermission[],
  required: PluginPermission,
  action: string
): void {
  if (!approved.includes(required)) {
    throw new PluginPermissionError(
      `Plugin is not permitted to ${action} (missing "${required}").`,
      required
    );
  }
}

export function hasPermission(
  approved: readonly PluginPermission[],
  required: PluginPermission
): boolean {
  return approved.includes(required);
}

export class PluginPermissionError extends Error {
  readonly code = "plugin_permission_denied" as const;

  constructor(
    message: string,
    readonly permission: PluginPermission
  ) {
    super(message);
    this.name = "PluginPermissionError";
  }
}
