/**
 * Local Skill catalog (Task 40).
 * Offline-first discovery: no third-party marketplace brand or network dependency.
 * Catalog can be marked offline for tests; installed skills still manage locally.
 */

import { createHash } from "node:crypto";
import type { ToolPermissionCategory } from "../tools/toolTypes.js";
import {
  SKILL_SOURCE_PRIORITY,
  type SkillCatalogEntry,
  type SkillCatalogSearchQuery,
  type SkillCatalogSearchResult,
  type SkillDefinition,
  type SkillInstallStatus,
  type SkillPermissionSummary,
  type SkillSource
} from "./skillTypes.js";

export interface SkillCatalogProvider {
  /** When false, search returns catalogAvailable:false but installed work continues. */
  isAvailable(): boolean;
  list(): SkillCatalogEntry[];
  get(catalogId: string): SkillCatalogEntry | undefined;
}

/** Built-in local catalog seeds (not NextClaw brand). */
export const LOCAL_SKILL_CATALOG_SEEDS: readonly SkillCatalogEntry[] = [
  {
    id: "catalog-evidence-notes",
    name: "evidence-notes",
    version: "1.0.0",
    description: "Capture research notes with source attribution.",
    tags: ["research", "writing"],
    author: "workbench",
    recommended: true,
    requiredTools: ["filesystem", "web"],
    permissionHints: ["write", "network"],
    instructions: [
      "# Evidence Notes",
      "",
      "Record claims with citations. Prefer primary sources.",
      "Store notes under the Project workspace only."
    ].join("\n")
  },
  {
    id: "catalog-safe-refactor",
    name: "safe-refactor",
    version: "1.1.0",
    description: "Incremental refactors with tests first.",
    tags: ["coding", "testing", "refactor"],
    author: "workbench",
    recommended: true,
    requiredTools: ["filesystem", "shell"],
    permissionHints: ["write", "shell"],
    instructions: [
      "# Safe Refactor",
      "",
      "Change one behavior at a time. Keep tests green.",
      "Do not expand scope beyond the approved plan."
    ].join("\n")
  },
  {
    id: "catalog-release-checklist",
    name: "release-checklist",
    version: "1.0.0",
    description: "Pre-release verification checklist skill.",
    tags: ["release", "verification"],
    author: "workbench",
    recommended: false,
    requiredTools: ["filesystem", "shell"],
    permissionHints: ["readonly", "shell"],
    instructions: [
      "# Release Checklist",
      "",
      "Verify tests, typecheck, and packaging gates.",
      "Never publish secrets or skip human acceptance."
    ].join("\n")
  }
];

export class LocalSkillCatalogProvider implements SkillCatalogProvider {
  private available = true;
  private readonly entries = new Map<string, SkillCatalogEntry>();

  constructor(seeds: readonly SkillCatalogEntry[] = LOCAL_SKILL_CATALOG_SEEDS) {
    for (const entry of seeds) {
      this.entries.set(entry.id, cloneCatalogEntry(entry));
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  list(): SkillCatalogEntry[] {
    return [...this.entries.values()]
      .map(cloneCatalogEntry)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(catalogId: string): SkillCatalogEntry | undefined {
    const entry = this.entries.get(catalogId);
    return entry ? cloneCatalogEntry(entry) : undefined;
  }

  /** Test/helper: replace or add a catalog row (e.g. newer version). */
  upsert(entry: SkillCatalogEntry): void {
    this.entries.set(entry.id, cloneCatalogEntry(entry));
  }
}

export function hashSkillContent(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function buildSkillMarkdownFromCatalog(entry: SkillCatalogEntry): string {
  if (entry.rawContent?.trim()) return entry.rawContent;
  const tags = entry.tags.join(", ");
  const tools = entry.requiredTools.join(", ");
  const hints = entry.permissionHints.join(", ");
  return [
    "---",
    `name: ${entry.name}`,
    `version: ${entry.version}`,
    `description: ${entry.description}`,
    entry.author ? `author: ${entry.author}` : undefined,
    `tags: [${tags}]`,
    `requiredTools: [${tools}]`,
    `permissionHints: [${hints}]`,
    "---",
    "",
    entry.instructions,
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function skillSourcePriority(source: SkillSource): number {
  return SKILL_SOURCE_PRIORITY[source] ?? 0;
}

/** True when `challenger` may replace `incumbent` (strictly higher priority). */
export function canSourceOverride(incumbent: SkillSource, challenger: SkillSource): boolean {
  if (incumbent === "builtin") return false;
  return skillSourcePriority(challenger) > skillSourcePriority(incumbent);
}

export function searchSkillCatalog(
  provider: SkillCatalogProvider,
  installed: ReadonlyMap<string, SkillDefinition>,
  query: SkillCatalogSearchQuery = {}
): SkillCatalogSearchResult {
  const catalogAvailable = provider.isAvailable();
  const installedByNameOrCatalog = indexInstalled(installed);
  const installedCount = countNonBuiltinInstalled(installed);

  if (!catalogAvailable) {
    return { catalogAvailable: false, entries: [], installedCount };
  }

  const q = query.query?.trim().toLowerCase() ?? "";
  const tags = (query.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const recommendedOnly = query.recommendedOnly === true;
  const notInstalledOnly = query.notInstalledOnly === true;

  const entries = provider
    .list()
    .filter((entry) => {
      if (recommendedOnly && !entry.recommended) return false;
      if (tags.length > 0) {
        const entryTags = entry.tags.map((t) => t.toLowerCase());
        if (!tags.every((tag) => entryTags.includes(tag))) return false;
      }
      if (q) {
        const hay = `${entry.id} ${entry.name} ${entry.description} ${entry.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const match = findInstalledMatch(entry, installedByNameOrCatalog);
      if (notInstalledOnly && match) return false;
      return true;
    })
    .map((entry) => {
      const match = findInstalledMatch(entry, installedByNameOrCatalog);
      return {
        ...cloneCatalogEntry(entry),
        recommended: entry.recommended === true,
        installed: Boolean(match),
        installedVersion: match?.version
      };
    })
    .sort((a, b) => {
      // Recommended first, then name
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return { catalogAvailable: true, entries, installedCount };
}

export function buildPermissionSummary(
  skill: Pick<
    SkillDefinition,
    | "id"
    | "name"
    | "version"
    | "source"
    | "trusted"
    | "permissionHints"
    | "requiredTools"
    | "description"
  >
): SkillPermissionSummary {
  const requiresTrustConfirmation = skill.source !== "builtin" && !skill.trusted;
  const lines: string[] = [
    `Skill: ${skill.name} (${skill.version})`,
    `Source: ${skill.source}`,
    skill.description ? `Description: ${skill.description}` : "Description: (none)",
    `Required tools: ${skill.requiredTools.length ? skill.requiredTools.join(", ") : "(none)"}`,
    `Permission hints: ${
      skill.permissionHints.length ? skill.permissionHints.join(", ") : "(none)"
    }`
  ];
  if (requiresTrustConfirmation) {
    lines.push("Trust required before first use — unknown code will not run silently.");
  } else if (skill.source === "builtin") {
    lines.push("Built-in skill is trusted by default.");
  } else {
    lines.push("Already trusted by the operator.");
  }

  return {
    skillId: skill.id,
    name: skill.name,
    version: skill.version,
    source: skill.source,
    permissionHints: [...skill.permissionHints],
    requiredTools: [...skill.requiredTools],
    trusted: skill.trusted,
    lines,
    requiresTrustConfirmation
  };
}

export function resolveInstallStatus(input: {
  skill: SkillDefinition;
  installRecord?: { version: string; contentHash: string };
  catalogEntry?: SkillCatalogEntry;
  actualHash?: string;
}): SkillInstallStatus {
  if (input.skill.source === "builtin") return "builtin";
  if (!input.skill.enabled) return "disabled";
  if (input.actualHash && input.installRecord && input.actualHash !== input.installRecord.contentHash) {
    return "drifted";
  }
  if (
    input.catalogEntry
    && input.installRecord
    && compareSemverLike(input.catalogEntry.version, input.installRecord.version) > 0
  ) {
    return "update_available";
  }
  if (input.installRecord || input.skill.source === "catalog" || input.skill.source === "user_local" || input.skill.source === "project" || input.skill.source === "trusted_dir" || input.skill.source === "imported") {
    return "installed";
  }
  return "not_installed";
}

/** Simple unified-style diff for preview UIs (not a full patch algorithm). */
export function previewTextDiff(before: string, after: string, maxLines = 200): string {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  if (before === after) return "(no content changes)";

  const lines: string[] = ["--- current", "+++ target"];
  const max = Math.max(a.length, b.length);
  let emitted = 0;
  for (let i = 0; i < max && emitted < maxLines; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) {
      lines.push(` ${left ?? ""}`);
      emitted++;
      continue;
    }
    if (left !== undefined) {
      lines.push(`-${left}`);
      emitted++;
    }
    if (right !== undefined && emitted < maxLines) {
      lines.push(`+${right}`);
      emitted++;
    }
  }
  if (max > maxLines) {
    lines.push(`… (${max - maxLines} more line pairs truncated)`);
  }
  return lines.join("\n");
}

/** Compare dotted version strings; non-numeric segments sort as 0. */
export function compareSemverLike(left: string, right: string): number {
  const l = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const r = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(l.length, r.length);
  for (let i = 0; i < len; i++) {
    const lv = l[i] ?? 0;
    const rv = r[i] ?? 0;
    if (lv !== rv) return lv < rv ? -1 : 1;
  }
  return 0;
}

export function catalogEntryAsDefinition(
  entry: SkillCatalogEntry,
  options: {
    trusted?: boolean;
    enabled?: boolean;
    path?: string;
    sourceDir?: string;
    now?: string;
  } = {}
): SkillDefinition {
  const raw = buildSkillMarkdownFromCatalog(entry);
  const timestamp = options.now ?? new Date().toISOString();
  const trusted = options.trusted === true;
  return {
    id: slugify(entry.name),
    name: entry.name,
    version: entry.version,
    description: entry.description,
    path: options.path,
    sourceDir: options.sourceDir,
    source: "catalog",
    catalogId: entry.id,
    enabled: options.enabled !== false,
    trusted,
    trustedAt: trusted ? timestamp : undefined,
    tags: [...entry.tags],
    requiredTools: [...entry.requiredTools],
    permissionHints: [...entry.permissionHints] as ToolPermissionCategory[],
    author: entry.author,
    rawContent: raw,
    instructions: entry.instructions,
    contentHash: hashSkillContent(raw),
    installStatus: "installed",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function indexInstalled(
  installed: ReadonlyMap<string, SkillDefinition>
): Map<string, SkillDefinition> {
  const map = new Map<string, SkillDefinition>();
  for (const skill of installed.values()) {
    map.set(skill.id, skill);
    map.set(skill.name.toLowerCase(), skill);
    if (skill.catalogId) map.set(`catalog:${skill.catalogId}`, skill);
  }
  return map;
}

function findInstalledMatch(
  entry: SkillCatalogEntry,
  index: Map<string, SkillDefinition>
): SkillDefinition | undefined {
  return (
    index.get(`catalog:${entry.id}`)
    ?? index.get(slugify(entry.name))
    ?? index.get(entry.name.toLowerCase())
  );
}

function countNonBuiltinInstalled(installed: ReadonlyMap<string, SkillDefinition>): number {
  let count = 0;
  for (const skill of installed.values()) {
    if (skill.source !== "builtin") count++;
  }
  return count;
}

function cloneCatalogEntry(entry: SkillCatalogEntry): SkillCatalogEntry {
  return {
    ...entry,
    tags: [...entry.tags],
    requiredTools: [...entry.requiredTools],
    permissionHints: [...entry.permissionHints]
  };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
