/**
 * Skill catalog service (Task 22).
 * Loads SKILL.md from operator-trusted directories; enable/disable + trust gates.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { parseSkillFrontmatter, stripSkillFrontmatter } from "./skillFrontmatter.js";
import {
  BUILTIN_SKILL_SEEDS,
  type ImportSkillsResult,
  type SkillDefinition,
  type SkillSource,
  type SkillState
} from "./skillTypes.js";
import type { ToolPermissionCategory } from "../tools/toolTypes.js";

export interface SkillServiceOptions {
  statePath?: string;
  /** Extra trusted directories at open (merged into state). */
  trustedDirectories?: string[];
  /** Seed built-in skill instructions (default true). */
  seedBuiltins?: boolean;
}

function emptyState(): SkillState {
  return { schemaVersion: 1, trustedDirectories: [], overrides: {} };
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SkillService {
  private skills = new Map<string, SkillDefinition>();

  private constructor(
    private readonly statePath: string | undefined,
    private state: SkillState
  ) {}

  static async open(options: SkillServiceOptions = {}): Promise<SkillService> {
    let state = emptyState();
    if (options.statePath) {
      try {
        const decoded = JSON.parse(await readFile(options.statePath, "utf8")) as Partial<SkillState>;
        if (decoded.schemaVersion !== 1) {
          throw new Error("Skill state is not compatible with this service version.");
        }
        state = {
          schemaVersion: 1,
          trustedDirectories: Array.isArray(decoded.trustedDirectories)
            ? decoded.trustedDirectories.filter((d): d is string => typeof d === "string")
            : [],
          overrides:
            decoded.overrides && typeof decoded.overrides === "object" && !Array.isArray(decoded.overrides)
              ? { ...decoded.overrides }
              : {}
        };
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }

    const service = new SkillService(options.statePath, state);

    if (options.seedBuiltins !== false) {
      service.seedBuiltins();
    }

    for (const dir of options.trustedDirectories ?? []) {
      await service.addTrustedDirectory(dir, { persist: false, rescan: false });
    }

    // Rescan all trusted directories so disk skills are available.
    for (const dir of [...service.state.trustedDirectories]) {
      await service.scanTrustedDirectory(dir, { requireTrustForNew: true });
    }

    await service.persist();
    return service;
  }

  static async createMemory(options: Omit<SkillServiceOptions, "statePath"> = {}): Promise<SkillService> {
    return SkillService.open(options);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()]
      .map(cloneSkill)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  get(skillId: string): SkillDefinition {
    const skill = this.resolve(skillId);
    if (!skill) throw new Error(`Skill "${skillId}" was not found.`);
    return cloneSkill(skill);
  }

  tryGet(skillId: string): SkillDefinition | undefined {
    const skill = this.resolve(skillId);
    return skill ? cloneSkill(skill) : undefined;
  }

  /** Resolve by id or name for name-only Role configs. */
  resolveByNameOrId(nameOrId: string): SkillDefinition | undefined {
    return this.tryGet(nameOrId);
  }

  has(skillId: string): boolean {
    return this.resolve(skillId) !== undefined;
  }

  trustedDirectories(): string[] {
    return [...this.state.trustedDirectories];
  }

  /**
   * Mark a local directory as trusted for skill import, then scan it.
   * Paths must be absolute.
   */
  async addTrustedDirectory(
    directory: string,
    options: { persist?: boolean; rescan?: boolean } = {}
  ): Promise<string> {
    const resolved = assertAbsoluteDir(directory);
    await ensureDirectory(resolved);
    if (!this.state.trustedDirectories.some((entry) => samePath(entry, resolved))) {
      this.state.trustedDirectories.push(resolved);
    }
    if (options.rescan !== false) {
      await this.scanTrustedDirectory(resolved, { requireTrustForNew: true });
    }
    if (options.persist !== false) await this.persist();
    return resolved;
  }

  /**
   * Import / re-scan skills from a trusted directory.
   * Rejects directories that are not on the trusted list.
   */
  async importFromTrustedDirectory(directory: string): Promise<ImportSkillsResult> {
    const resolved = assertAbsoluteDir(directory);
    if (!this.isTrustedDirectory(resolved)) {
      throw new Error(
        `Directory is not a trusted skill source: ${resolved}. Add it with addTrustedDirectory first.`
      );
    }
    return this.scanTrustedDirectory(resolved, { requireTrustForNew: true });
  }

  async setEnabled(skillId: string, enabled: boolean): Promise<SkillDefinition> {
    const skill = this.resolve(skillId);
    if (!skill) throw new Error(`Skill "${skillId}" was not found.`);
    skill.enabled = enabled;
    skill.updatedAt = nowIso();
    const override = this.state.overrides[skill.id] ?? {};
    override.enabled = enabled;
    this.state.overrides[skill.id] = override;
    await this.persist();
    return cloneSkill(skill);
  }

  async trust(skillId: string): Promise<SkillDefinition> {
    const skill = this.resolve(skillId);
    if (!skill) throw new Error(`Skill "${skillId}" was not found.`);
    const timestamp = nowIso();
    skill.trusted = true;
    skill.trustedAt = timestamp;
    skill.updatedAt = timestamp;
    const override = this.state.overrides[skill.id] ?? {};
    override.trusted = true;
    override.trustedAt = timestamp;
    this.state.overrides[skill.id] = override;
    await this.persist();
    return cloneSkill(skill);
  }

  async revokeTrust(skillId: string): Promise<SkillDefinition> {
    const skill = this.resolve(skillId);
    if (!skill) throw new Error(`Skill "${skillId}" was not found.`);
    if (skill.source === "builtin") {
      throw new Error(`Cannot revoke trust for built-in skill "${skillId}".`);
    }
    skill.trusted = false;
    skill.trustedAt = undefined;
    skill.updatedAt = nowIso();
    const override = this.state.overrides[skill.id] ?? {};
    override.trusted = false;
    override.trustedAt = undefined;
    this.state.overrides[skill.id] = override;
    await this.persist();
    return cloneSkill(skill);
  }

  /** Load actual instruction content (body). */
  loadInstructions(skillId: string): string {
    const skill = this.get(skillId);
    return skill.instructions;
  }

  /** Load full raw SKILL.md when available. */
  async loadRaw(skillId: string): Promise<string> {
    const skill = this.get(skillId);
    if (skill.rawContent) return skill.rawContent;
    if (skill.path) {
      return readFile(skill.path, "utf8");
    }
    return skill.instructions;
  }

  private resolve(nameOrId: string): SkillDefinition | undefined {
    const key = nameOrId.trim();
    if (!key) return undefined;
    const byId = this.skills.get(key);
    if (byId) return byId;
    for (const skill of this.skills.values()) {
      if (skill.name === key || skill.id === key) return skill;
    }
    return undefined;
  }

  private seedBuiltins(): void {
    const timestamp = nowIso();
    for (const seed of BUILTIN_SKILL_SEEDS) {
      if (this.skills.has(seed.id)) continue;
      const override = this.state.overrides[seed.id];
      this.skills.set(seed.id, {
        id: seed.id,
        name: seed.name,
        version: seed.version,
        description: seed.description,
        source: "builtin",
        enabled: override?.enabled ?? true,
        trusted: override?.trusted ?? true,
        trustedAt: override?.trustedAt ?? timestamp,
        tags: [...seed.tags],
        requiredTools: [...seed.requiredTools],
        permissionHints: [...seed.permissionHints],
        instructions: seed.instructions,
        rawContent: buildSkillMarkdown(seed),
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }
  }

  private isTrustedDirectory(directory: string): boolean {
    const resolved = resolve(directory);
    return this.state.trustedDirectories.some(
      (entry) => samePath(entry, resolved) || isPathInside(resolved, entry)
    );
  }

  private async scanTrustedDirectory(
    directory: string,
    options: { requireTrustForNew: boolean }
  ): Promise<ImportSkillsResult> {
    const resolved = resolve(directory);
    const result: ImportSkillsResult = {
      trustedDirectory: resolved,
      imported: [],
      skipped: [],
      errors: []
    };

    let entries: string[];
    try {
      entries = await readdir(resolved);
    } catch (error) {
      result.errors.push({
        path: resolved,
        reason: error instanceof Error ? error.message : "Unable to read trusted skill directory."
      });
      return result;
    }

    for (const entry of entries) {
      const skillDir = join(resolved, entry);
      let skillMdPath = join(skillDir, "SKILL.md");
      try {
        const info = await stat(skillDir);
        if (!info.isDirectory()) {
          // Allow flat SKILL.md named files: implement.SKILL.md or direct md
          if (entry.toLowerCase() === "skill.md" || entry.toLowerCase().endsWith(".md")) {
            skillMdPath = skillDir;
          } else {
            continue;
          }
        } else {
          await access(skillMdPath);
        }
      } catch {
        // Also try skill.md lowercase
        const alt = join(skillDir, "skill.md");
        try {
          await access(alt);
          skillMdPath = alt;
        } catch {
          continue;
        }
      }

      try {
        if (!this.isTrustedDirectory(skillDir) && !this.isTrustedDirectory(dirnameSafe(skillMdPath))) {
          result.errors.push({
            path: skillMdPath,
            reason: "Skill path is outside trusted directories."
          });
          continue;
        }

        const raw = await readFile(skillMdPath, "utf8");
        const meta = parseSkillFrontmatter(raw);
        const body = stripSkillFrontmatter(raw);
        const id = slugify(meta.name ?? (entry.replace(/\.md$/i, "") || "skill"));
        if (!id) {
          result.errors.push({ path: skillMdPath, reason: "Skill id could not be derived." });
          continue;
        }

        const existing = this.skills.get(id);
        if (existing?.source === "builtin") {
          // Built-ins cannot be silently overwritten by local files (Task 40 alignment).
          result.skipped.push({
            id,
            reason: "Built-in skill cannot be overwritten by a local file."
          });
          continue;
        }

        const timestamp = nowIso();
        const override = this.state.overrides[id];
        const isNew = !existing;
        const trusted =
          override?.trusted
          ?? (options.requireTrustForNew && isNew ? false : existing?.trusted ?? false);
        const skill: SkillDefinition = {
          id,
          name: meta.name?.trim() || id,
          version: meta.version?.trim() || existing?.version || "1.0.0",
          description: meta.description?.trim() || existing?.description || "",
          path: skillMdPath,
          sourceDir: resolved,
          source: "trusted_dir",
          enabled: override?.enabled ?? existing?.enabled ?? true,
          trusted,
          trustedAt: trusted ? (override?.trustedAt ?? existing?.trustedAt ?? timestamp) : undefined,
          tags: meta.tags ?? existing?.tags ?? [],
          requiredTools: meta.requiredTools ?? existing?.requiredTools ?? [],
          permissionHints: (meta.permissionHints ?? existing?.permissionHints ?? []) as ToolPermissionCategory[],
          author: meta.author,
          rawContent: raw,
          instructions: body,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp
        };
        this.skills.set(id, skill);
        result.imported.push(cloneSkill(skill));
      } catch (error) {
        result.errors.push({
          path: skillMdPath,
          reason: error instanceof Error ? error.message : "Unable to import skill."
        });
      }
    }

    await this.persist();
    return result;
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirnameSafe(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: constants.S_IRUSR | constants.S_IWUSR
    });
    await rename(temporaryPath, this.statePath);
  }
}

function buildSkillMarkdown(seed: (typeof BUILTIN_SKILL_SEEDS)[number]): string {
  const tags = seed.tags.join(", ");
  const tools = seed.requiredTools.join(", ");
  const hints = seed.permissionHints.join(", ");
  return [
    "---",
    `name: ${seed.name}`,
    `version: ${seed.version}`,
    `description: ${seed.description}`,
    `tags: [${tags}]`,
    `requiredTools: [${tools}]`,
    `permissionHints: [${hints}]`,
    "---",
    "",
    seed.instructions,
    ""
  ].join("\n");
}

function cloneSkill(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    tags: [...skill.tags],
    requiredTools: [...skill.requiredTools],
    permissionHints: [...skill.permissionHints]
  };
}

function assertAbsoluteDir(directory: string): string {
  const trimmed = directory?.trim();
  if (!trimmed) throw new Error("A skill directory path is required.");
  if (!isAbsolute(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error("Trusted skill directories must be absolute paths.");
  }
  return resolve(trimmed);
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`Skill path is not a directory: ${path}`);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await mkdir(path, { recursive: true });
      return;
    }
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function isPathInside(child: string, parent: string): boolean {
  const childPath = normalizePath(child);
  const parentPath = normalizePath(parent);
  return childPath === parentPath || childPath.startsWith(`${parentPath}${sep}`) || childPath.startsWith(`${parentPath}/`);
}

function normalizePath(value: string): string {
  return normalize(resolve(value)).replace(/[\\/]+$/, "").toLowerCase();
}

function dirnameSafe(filePath: string): string {
  const normalized = normalize(filePath);
  const idx = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return idx <= 0 ? normalized : normalized.slice(0, idx);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type { SkillDefinition, SkillSource, SkillState, ImportSkillsResult };
