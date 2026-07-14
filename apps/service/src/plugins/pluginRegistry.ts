/**
 * Contribution registry for plugin-provided capabilities (Task 46).
 * Provider / Harness / Tool / Skill Source / Artifact Renderer / Trigger.
 */

import {
  type ArtifactRendererContribution,
  type HarnessContribution,
  type PluginContributionKind,
  type PluginContributes,
  type ProviderContribution,
  type RegisteredContribution,
  type SkillSourceContribution,
  type ToolContribution,
  type TriggerContribution
} from "./pluginTypes.js";
import {
  assertPermission,
  permissionForContribution,
  type PluginPermissionError
} from "./pluginPermissions.js";
import type { PluginPermission } from "./pluginTypes.js";

function nowIso(): string {
  return new Date().toISOString();
}

type ContributionMap = {
  provider: ProviderContribution;
  harness: HarnessContribution;
  tool: ToolContribution;
  skill_source: SkillSourceContribution;
  artifact_renderer: ArtifactRendererContribution;
  trigger: TriggerContribution;
};

export class PluginContributionRegistry {
  private readonly byKind = new Map<PluginContributionKind, Map<string, RegisteredContribution>>();

  constructor() {
    for (const kind of [
      "provider",
      "harness",
      "tool",
      "skill_source",
      "artifact_renderer",
      "trigger"
    ] as PluginContributionKind[]) {
      this.byKind.set(kind, new Map());
    }
  }

  /**
   * Register all contributions from a plugin, enforcing approved permissions.
   * Partial failure rolls back that plugin's registrations.
   */
  registerFromManifest(input: {
    pluginId: string;
    contributes: PluginContributes;
    approvedPermissions: readonly PluginPermission[];
  }): RegisteredContribution[] {
    const registered: RegisteredContribution[] = [];
    try {
      for (const item of input.contributes.providers ?? []) {
        registered.push(
          this.registerOne("provider", input.pluginId, item.id, item, input.approvedPermissions)
        );
      }
      for (const item of input.contributes.harnesses ?? []) {
        registered.push(
          this.registerOne("harness", input.pluginId, item.id, item, input.approvedPermissions)
        );
      }
      for (const item of input.contributes.tools ?? []) {
        registered.push(
          this.registerOne("tool", input.pluginId, item.id, item, input.approvedPermissions)
        );
      }
      for (const item of input.contributes.skillSources ?? []) {
        registered.push(
          this.registerOne("skill_source", input.pluginId, item.id, item, input.approvedPermissions)
        );
      }
      for (const item of input.contributes.artifactRenderers ?? []) {
        registered.push(
          this.registerOne(
            "artifact_renderer",
            input.pluginId,
            item.id,
            item,
            input.approvedPermissions
          )
        );
      }
      for (const item of input.contributes.triggers ?? []) {
        registered.push(
          this.registerOne("trigger", input.pluginId, item.id, item, input.approvedPermissions)
        );
      }
    } catch (error) {
      this.unregisterPlugin(input.pluginId);
      throw error;
    }
    return registered;
  }

  unregisterPlugin(pluginId: string): number {
    let removed = 0;
    for (const map of this.byKind.values()) {
      for (const [key, entry] of [...map.entries()]) {
        if (entry.pluginId === pluginId) {
          map.delete(key);
          removed++;
        }
      }
    }
    return removed;
  }

  list<K extends PluginContributionKind>(
    kind: K
  ): Array<RegisteredContribution<ContributionMap[K]>> {
    const map = this.byKind.get(kind)!;
    return [...map.values()]
      .map((entry) => entry as RegisteredContribution<ContributionMap[K]>)
      .sort((a, b) => a.contributionId.localeCompare(b.contributionId));
  }

  listAll(): RegisteredContribution[] {
    const all: RegisteredContribution[] = [];
    for (const kind of this.byKind.keys()) {
      all.push(...this.list(kind));
    }
    return all.sort((a, b) => {
      const byKind = a.kind.localeCompare(b.kind);
      if (byKind !== 0) return byKind;
      return a.contributionId.localeCompare(b.contributionId);
    });
  }

  get<K extends PluginContributionKind>(
    kind: K,
    contributionId: string
  ): RegisteredContribution<ContributionMap[K]> | undefined {
    return this.byKind.get(kind)!.get(contributionId) as
      | RegisteredContribution<ContributionMap[K]>
      | undefined;
  }

  clear(): void {
    for (const map of this.byKind.values()) {
      map.clear();
    }
  }

  private registerOne<K extends PluginContributionKind>(
    kind: K,
    pluginId: string,
    contributionId: string,
    contribution: ContributionMap[K],
    approved: readonly PluginPermission[]
  ): RegisteredContribution<ContributionMap[K]> {
    const required = permissionForContribution(kind);
    assertPermission(approved, required, `register ${kind} "${contributionId}"`);

    const map = this.byKind.get(kind)!;
    const existing = map.get(contributionId);
    if (existing && existing.pluginId !== pluginId) {
      throw new Error(
        `Contribution ${kind}:"${contributionId}" is already registered by plugin "${existing.pluginId}".`
      );
    }
    const entry: RegisteredContribution<ContributionMap[K]> = {
      pluginId,
      kind,
      contributionId,
      contribution,
      registeredAt: nowIso()
    };
    map.set(contributionId, entry as RegisteredContribution);
    return entry;
  }
}

export type { PluginPermissionError };
