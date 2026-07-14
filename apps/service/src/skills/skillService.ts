/**
 * Skill catalog service (Task 22 + Task 40 lifecycle).
 * Loads SKILL.md from operator-trusted / project / catalog roots;
 * enable/disable + trust gates; install/update/drift/rollback with user confirm.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  buildPermissionSummary,
  buildSkillMarkdownFromCatalog,
  catalogEntryAsDefinition,
  hashSkillContent,
  LocalSkillCatalogProvider,
  previewTextDiff,
  resolveInstallStatus,
  searchSkillCatalog,
  skillSourcePriority,
  type SkillCatalogProvider
} from "./skillCatalog.js";
import { parseSkillFrontmatter, stripSkillFrontmatter } from "./skillFrontmatter.js";
import {
  BUILTIN_SKILL_SEEDS,
  type ImportSkillsResult,
  type SkillCatalogEntry,
  type SkillCatalogSearchQuery,
  type SkillCatalogSearchResult,
  type SkillConflict,
  type SkillDefinition,
  type SkillDetail,
  type SkillDriftReport,
  type SkillInstallPreview,
  type SkillInstallRecord,
  type SkillPermissionSummary,
  type SkillSource,
  type SkillState,
  type SkillUpdatePreview,
  type SkillVersionSnapshot
} from "./skillTypes.js";
import type { ToolPermissionCategory } from "../tools/toolTypes.js";

const MAX_HISTORY = 10;

export interface SkillServiceOptions {
  statePath?: string;
  /** Extra trusted directories at open (merged into state) — user_local source. */
  trustedDirectories?: string[];
  /** Project skill roots: higher priority than user_local, cannot override builtin. */
  projectDirectories?: Array<{ projectId: string; directory: string }>;
  /** Directory for catalog installs (created on demand). */
  installRoot?: string;
  /** Seed built-in skill instructions (default true). */
  seedBuiltins?: boolean;
  /** Local catalog provider (default LocalSkillCatalogProvider). */
  catalog?: SkillCatalogProvider;
}

function emptyState(): SkillState {
  return {
    schemaVersion: 1,
    trustedDirectories: [],
    projectDirectories: [],
    overrides: {},
    installs: {}
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SkillService {
  private skills = new Map<string, SkillDefinition>();
  private readonly catalog: SkillCatalogProvider;
  private installRoot: string | undefined;

  private constructor(
    private readonly statePath: string | undefined,
    private state: SkillState,
    catalog: SkillCatalogProvider | undefined,
    installRoot: string | undefined
  ) {
    this.catalog = catalog ?? new LocalSkillCatalogProvider();
    this.installRoot = installRoot ?? state.installRoot;
  }

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
          projectDirectories: Array.isArray(decoded.projectDirectories)
            ? decoded.projectDirectories
                .filter(
                  (entry): entry is { projectId: string; directory: string } =>
                    !!entry
                    && typeof entry === "object"
                    && typeof (entry as { projectId?: unknown }).projectId === "string"
                    && typeof (entry as { directory?: unknown }).directory === "string"
                )
                .map((entry) => ({
                  projectId: entry.projectId.trim(),
                  directory: resolve(entry.directory)
                }))
            : [],
          installRoot:
            typeof decoded.installRoot === "string" && decoded.installRoot.trim()
              ? resolve(decoded.installRoot)
              : undefined,
          overrides:
            decoded.overrides && typeof decoded.overrides === "object" && !Array.isArray(decoded.overrides)
              ? { ...decoded.overrides }
              : {},
          installs:
            decoded.installs && typeof decoded.installs === "object" && !Array.isArray(decoded.installs)
              ? (decoded.installs as Record<string, SkillInstallRecord>)
              : {}
        };
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }

    if (options.installRoot) {
      state.installRoot = resolve(options.installRoot);
    }

    const service = new SkillService(options.statePath, state, options.catalog, state.installRoot);

    if (options.seedBuiltins !== false) {
      service.seedBuiltins();
    }

    for (const dir of options.trustedDirectories ?? []) {
      await service.addTrustedDirectory(dir, { persist: false, rescan: false });
    }

    for (const entry of options.projectDirectories ?? []) {
      await service.addProjectDirectory(entry.projectId, entry.directory, {
        persist: false,
        rescan: false
      });
    }

    // Rescan trusted + project directories so disk skills are available offline.
    for (const dir of [...service.state.trustedDirectories]) {
      await service.scanDirectory(dir, {
        source: "user_local",
        requireTrustForNew: true
      });
    }
    for (const entry of [...(service.state.projectDirectories ?? [])]) {
      await service.scanDirectory(entry.directory, {
        source: "project",
        projectId: entry.projectId,
        requireTrustForNew: true
      });
    }

    // Restore catalog installs that live under installRoot
    if (service.installRoot) {
      try {
        await access(service.installRoot);
        await service.scanDirectory(service.installRoot, {
          source: "catalog",
          requireTrustForNew: true,
          preferInstallRecords: true
        });
      } catch {
        // install root may not exist yet
      }
    }

    await service.persist();
    return service;
  }

  static async createMemory(options: Omit<SkillServiceOptions, "statePath"> = {}): Promise<SkillService> {
    return SkillService.open(options);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()]
      .map((skill) => this.enrichDefinition(skill))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  get(skillId: string): SkillDefinition {
    const skill = this.resolve(skillId);
    if (!skill) throw new Error(`Skill "${skillId}" was not found.`);
    return this.enrichDefinition(skill);
  }

  tryGet(skillId: string): SkillDefinition | undefined {
    const skill = this.resolve(skillId);
    return skill ? this.enrichDefinition(skill) : undefined;
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

  projectDirectories(): Array<{ projectId: string; directory: string }> {
    return [...(this.state.projectDirectories ?? [])];
  }

  /**
   * Mark a local directory as trusted for skill import (user_local), then scan it.
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
      await this.scanDirectory(resolved, { source: "user_local", requireTrustForNew: true });
    }
    if (options.persist !== false) await this.persist();
    return resolved;
  }

  /**
   * Register a Project-scoped skill directory (higher priority than user_local).
   * Cannot override built-ins.
   */
  async addProjectDirectory(
    projectId: string,
    directory: string,
    options: { persist?: boolean; rescan?: boolean } = {}
  ): Promise<string> {
    const id = projectId?.trim();
    if (!id) throw new Error("projectId is required.");
    const resolved = assertAbsoluteDir(directory);
    await ensureDirectory(resolved);
    if (!this.state.projectDirectories) this.state.projectDirectories = [];
    const existing = this.state.projectDirectories.findIndex((entry) => entry.projectId === id);
    if (existing >= 0) {
      this.state.projectDirectories[existing] = { projectId: id, directory: resolved };
    } else {
      this.state.projectDirectories.push({ projectId: id, directory: resolved });
    }
    if (options.rescan !== false) {
      await this.scanDirectory(resolved, {
        source: "project",
        projectId: id,
        requireTrustForNew: true
      });
    }
    if (options.persist !== false) await this.persist();
    return resolved;
  }

  /**
   * Import / re-scan skills from a trusted directory.
   * Rejects directories that are not on the trusted or project list.
   */
  async importFromTrustedDirectory(directory: string): Promise<ImportSkillsResult> {
    const resolved = assertAbsoluteDir(directory);
    const project = (this.state.projectDirectories ?? []).find((entry) => samePath(entry.directory, resolved));
    if (project) {
      return this.scanDirectory(resolved, {
        source: "project",
        projectId: project.projectId,
        requireTrustForNew: true
      });
    }
    if (!this.isTrustedDirectory(resolved)) {
      throw new Error(
        `Directory is not a trusted skill source: ${resolved}. Add it with addTrustedDirectory first.`
      );
    }
    return this.scanDirectory(resolved, { source: "user_local", requireTrustForNew: true });
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
    return this.enrichDefinition(skill);
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
    return this.enrichDefinition(skill);
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
    return this.enrichDefinition(skill);
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

  // ── Task 40 catalog lifecycle ───────────────────────────────────────────

  /** Search local catalog (tags / query / recommended). Offline → empty catalog, installed still listed elsewhere. */
  searchCatalog(query: SkillCatalogSearchQuery = {}): SkillCatalogSearchResult {
    return searchSkillCatalog(this.catalog, this.skills, query);
  }

  getCatalogEntry(catalogId: string): SkillCatalogEntry | undefined {
    return this.catalog.get(catalogId);
  }

  /** Full detail for UI: content, install status, permissions, drift, conflicts. */
  async getDetail(skillId: string): Promise<SkillDetail> {
    const skill = this.resolve(skillId);
    if (!skill) throw new Error(`Skill "${skillId}" was not found.`);
    const raw = skill.rawContent ?? (skill.path ? await readFile(skill.path, "utf8") : skill.instructions);
    const contentHash = hashSkillContent(raw);
    const installRecord = this.state.installs?.[skill.id];
    const catalogEntry = skill.catalogId
      ? this.catalog.get(skill.catalogId)
      : this.catalog.list().find((entry) => slugify(entry.name) === skill.id);
    const installStatus = resolveInstallStatus({
      skill,
      installRecord,
      catalogEntry,
      actualHash: contentHash
    });
    const drifted = Boolean(
      installRecord && contentHash !== installRecord.contentHash
    );
    const conflicts = this.listConflictsFor(skill.id);
    const enriched = this.enrichDefinition({ ...skill, rawContent: raw, contentHash });
    return {
      ...enriched,
      rawContent: raw,
      contentHash,
      installStatus,
      installRecord: installRecord ? cloneInstallRecord(installRecord) : undefined,
      permissionSummary: buildPermissionSummary(enriched),
      conflicts,
      updateAvailable: installStatus === "update_available",
      catalogVersion: catalogEntry?.version,
      drifted
    };
  }

  permissionSummary(skillId: string): SkillPermissionSummary {
    return buildPermissionSummary(this.get(skillId));
  }

  /** Preview install — no side effects; always requires user confirm to proceed. */
  previewInstall(catalogId: string): SkillInstallPreview {
    const entry = this.catalog.get(catalogId);
    if (!entry) throw new Error(`Catalog skill "${catalogId}" was not found.`);
    if (!this.catalog.isAvailable()) {
      throw new Error("Skill catalog is offline. Installed skills can still be managed.");
    }
    const skillId = slugify(entry.name);
    const existing = this.skills.get(skillId);
    const blockedByBuiltin = existing?.source === "builtin";
    const def = catalogEntryAsDefinition(entry, { trusted: false });
    return {
      catalogId,
      entry,
      permissionSummary: buildPermissionSummary(def),
      wouldOverwrite: existing && !blockedByBuiltin
        ? { skillId: existing.id, source: existing.source, version: existing.version }
        : undefined,
      blockedByBuiltin,
      requiresConfirm: true
    };
  }

  /**
   * Install from local catalog into installRoot.
   * Requires explicit confirm:true — never silent.
   * New installs are untrusted until operator trusts them.
   */
  async installFromCatalog(
    catalogId: string,
    options: { confirm?: boolean } = {}
  ): Promise<SkillDefinition> {
    if (options.confirm !== true) {
      throw new Error(
        "Install requires explicit user confirmation (confirm: true). Unknown code is never installed silently."
      );
    }
    if (!this.catalog.isAvailable()) {
      throw new Error("Skill catalog is offline. Cannot install; existing installed skills remain available.");
    }
    const preview = this.previewInstall(catalogId);
    if (preview.blockedByBuiltin) {
      throw new Error(
        `Cannot install catalog skill "${preview.entry.name}": a built-in skill with the same id cannot be overwritten.`
      );
    }
    const entry = preview.entry;
    const skillId = slugify(entry.name);
    const root = await this.ensureInstallRoot();
    const skillDir = join(root, skillId);
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    const raw = buildSkillMarkdownFromCatalog(entry);
    const contentHash = hashSkillContent(raw);

    // Snapshot existing for rollback if overwriting
    const existing = this.skills.get(skillId);
    const history: SkillVersionSnapshot[] = [];
    if (existing?.rawContent) {
      history.push({
        version: existing.version,
        contentHash: existing.contentHash ?? hashSkillContent(existing.rawContent),
        rawContent: existing.rawContent,
        capturedAt: nowIso(),
        catalogId: existing.catalogId
      });
    }
    const prior = this.state.installs?.[skillId];
    if (prior?.history?.length) {
      history.push(...prior.history);
    }

    await writeFile(skillPath, raw, "utf8");

    const timestamp = nowIso();
    // Version changes / new installs require re-trust
    const skill: SkillDefinition = {
      id: skillId,
      name: entry.name,
      version: entry.version,
      description: entry.description,
      path: skillPath,
      sourceDir: root,
      source: "catalog",
      catalogId: entry.id,
      enabled: this.state.overrides[skillId]?.enabled ?? true,
      trusted: false,
      trustedAt: undefined,
      tags: [...entry.tags],
      requiredTools: [...entry.requiredTools],
      permissionHints: [...entry.permissionHints] as ToolPermissionCategory[],
      author: entry.author,
      rawContent: raw,
      instructions: entry.instructions,
      contentHash,
      installStatus: "installed",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    // Clear prior trust override on install/update
    const override = this.state.overrides[skillId] ?? {};
    override.trusted = false;
    override.trustedAt = undefined;
    this.state.overrides[skillId] = override;

    if (!this.state.installs) this.state.installs = {};
    this.state.installs[skillId] = {
      skillId,
      source: "catalog",
      catalogId: entry.id,
      version: entry.version,
      contentHash,
      installedAt: prior?.installedAt ?? timestamp,
      updatedAt: timestamp,
      history: history.slice(0, MAX_HISTORY)
    };

    this.skills.set(skillId, skill);
    await this.persist();
    return this.enrichDefinition(skill);
  }

  async checkDrift(skillId: string): Promise<SkillDriftReport> {
    const skill = this.resolve(skillId);
    if (!skill) throw new Error(`Skill "${skillId}" was not found.`);
    const install = this.state.installs?.[skill.id];
    if (!install) {
      return {
        skillId: skill.id,
        drifted: false,
        message: "No install inventory record — drift detection applies to installed catalog/local packages."
      };
    }
    const raw = skill.rawContent ?? (skill.path ? await readFile(skill.path, "utf8") : skill.instructions);
    const actualHash = hashSkillContent(raw);
    const meta = parseSkillFrontmatter(raw);
    const actualVersion = meta.version?.trim() || skill.version;
    const drifted = actualHash !== install.contentHash;
    return {
      skillId: skill.id,
      drifted,
      expectedHash: install.contentHash,
      actualHash,
      expectedVersion: install.version,
      actualVersion,
      message: drifted
        ? "Local skill content differs from the install inventory (local drift detected)."
        : "Local skill content matches the install inventory."
    };
  }

  async previewUpdate(skillId: string): Promise<SkillUpdatePreview> {
    const skill = this.resolve(skillId);
    if (!skill) throw new Error(`Skill "${skillId}" was not found.`);
    if (skill.source === "builtin") {
      throw new Error("Built-in skills cannot be updated from the catalog.");
    }
    const catalogId = skill.catalogId
      ?? this.catalog.list().find((entry) => slugify(entry.name) === skill.id)?.id;
    if (!catalogId) {
      throw new Error(`No catalog entry found for skill "${skillId}".`);
    }
    if (!this.catalog.isAvailable()) {
      throw new Error("Skill catalog is offline. Cannot preview updates; installed skill remains usable.");
    }
    const entry = this.catalog.get(catalogId);
    if (!entry) throw new Error(`Catalog skill "${catalogId}" was not found.`);

    const currentRaw =
      skill.rawContent ?? (skill.path ? await readFile(skill.path, "utf8") : skill.instructions);
    const targetRaw = buildSkillMarkdownFromCatalog(entry);
    const drift = await this.checkDrift(skill.id);
    const targetDef = catalogEntryAsDefinition(entry, { trusted: false });

    return {
      skillId: skill.id,
      currentVersion: skill.version,
      targetVersion: entry.version,
      drifted: drift.drifted,
      drift,
      diff: previewTextDiff(currentRaw, targetRaw),
      permissionSummary: buildPermissionSummary(targetDef),
      requiresConfirm: true,
      catalogId
    };
  }

  /**
   * Apply catalog update. Requires confirm:true.
   * Detects drift; refuses unless forceDespiteDrift:true.
   * Resets trust so the new version shows a permission summary before first use.
   */
  async updateFromCatalog(
    skillId: string,
    options: { confirm?: boolean; forceDespiteDrift?: boolean } = {}
  ): Promise<SkillDefinition> {
    if (options.confirm !== true) {
      throw new Error("Update requires explicit user confirmation (confirm: true).");
    }
    const preview = await this.previewUpdate(skillId);
    if (preview.drifted && options.forceDespiteDrift !== true) {
      throw new Error(
        `Local drift detected for skill "${skillId}". Review the diff and pass forceDespiteDrift: true to overwrite local changes.`
      );
    }
    if (!preview.catalogId) {
      throw new Error(`No catalog id for skill "${skillId}".`);
    }
    return this.installFromCatalog(preview.catalogId, { confirm: true });
  }

  /**
   * Roll back to a previous install snapshot (default: most recent history entry).
   * Requires confirm:true.
   */
  async rollback(
    skillId: string,
    options: { confirm?: boolean; version?: string } = {}
  ): Promise<SkillDefinition> {
    if (options.confirm !== true) {
      throw new Error("Rollback requires explicit user confirmation (confirm: true).");
    }
    const skill = this.resolve(skillId);
    if (!skill) throw new Error(`Skill "${skillId}" was not found.`);
    if (skill.source === "builtin") {
      throw new Error("Built-in skills cannot be rolled back.");
    }
    const install = this.state.installs?.[skill.id];
    if (!install?.history?.length) {
      throw new Error(`No rollback history for skill "${skillId}".`);
    }

    let snapshot = install.history[0];
    if (options.version) {
      const found = install.history.find((entry) => entry.version === options.version);
      if (!found) throw new Error(`Version "${options.version}" not found in rollback history.`);
      snapshot = found;
    }

    const raw = snapshot.rawContent;
    const contentHash = hashSkillContent(raw);
    const meta = parseSkillFrontmatter(raw);
    const body = stripSkillFrontmatter(raw);
    const timestamp = nowIso();

    // Push current into history before overwrite
    const currentRaw =
      skill.rawContent ?? (skill.path ? await readFile(skill.path, "utf8") : skill.instructions);
    const nextHistory: SkillVersionSnapshot[] = [
      {
        version: skill.version,
        contentHash: skill.contentHash ?? hashSkillContent(currentRaw),
        rawContent: currentRaw,
        capturedAt: timestamp,
        catalogId: skill.catalogId
      },
      ...install.history.filter((entry) => entry.contentHash !== snapshot.contentHash)
    ].slice(0, MAX_HISTORY);

    if (skill.path) {
      await writeFile(skill.path, raw, "utf8");
    } else {
      const root = await this.ensureInstallRoot();
      const skillDir = join(root, skill.id);
      await mkdir(skillDir, { recursive: true });
      skill.path = join(skillDir, "SKILL.md");
      skill.sourceDir = root;
      await writeFile(skill.path, raw, "utf8");
    }

    skill.version = meta.version?.trim() || snapshot.version;
    skill.description = meta.description?.trim() || skill.description;
    skill.tags = meta.tags ?? skill.tags;
    skill.requiredTools = meta.requiredTools ?? skill.requiredTools;
    skill.permissionHints = (meta.permissionHints ?? skill.permissionHints) as ToolPermissionCategory[];
    skill.author = meta.author ?? skill.author;
    skill.rawContent = raw;
    skill.instructions = body;
    skill.contentHash = contentHash;
    skill.catalogId = snapshot.catalogId ?? skill.catalogId;
    skill.updatedAt = timestamp;
    // Restored known snapshot: keep trust only if operator already trusted this skill id
    // but still surface permission summary for version change — untrusted until re-confirm.
    skill.trusted = false;
    skill.trustedAt = undefined;
    const override = this.state.overrides[skill.id] ?? {};
    override.trusted = false;
    override.trustedAt = undefined;
    this.state.overrides[skill.id] = override;

    install.version = skill.version;
    install.contentHash = contentHash;
    install.updatedAt = timestamp;
    install.history = nextHistory;
    if (!this.state.installs) this.state.installs = {};
    this.state.installs[skill.id] = install;

    await this.persist();
    return this.enrichDefinition(skill);
  }

  /** Conflicts observed for a skill id (losers that were skipped). */
  listConflicts(): SkillConflict[] {
    // Recompute lightly from install skips is not stored; report builtin protections statically.
    const conflicts: SkillConflict[] = [];
    for (const skill of this.skills.values()) {
      const losers = this.listConflictsFor(skill.id);
      if (losers.length > 0) {
        conflicts.push({ skillId: skill.id, winner: skill.source, losers });
      }
    }
    return conflicts;
  }

  private listConflictsFor(skillId: string): SkillConflict["losers"] {
    // Catalog entries blocked by higher-priority installed skill
    const skill = this.skills.get(skillId);
    if (!skill) return [];
    const losers: SkillConflict["losers"] = [];
    if (skill.source === "builtin") {
      for (const entry of this.catalog.list()) {
        if (slugify(entry.name) === skillId) {
          losers.push({
            source: "catalog",
            reason: "Built-in skill cannot be overwritten by catalog or local files."
          });
        }
      }
    }
    return losers;
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
      const raw = buildSkillMarkdown(seed);
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
        rawContent: raw,
        contentHash: hashSkillContent(raw),
        installStatus: "builtin",
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

  private async scanDirectory(
    directory: string,
    options: {
      source: SkillSource;
      projectId?: string;
      requireTrustForNew: boolean;
      preferInstallRecords?: boolean;
    }
  ): Promise<ImportSkillsResult> {
    const resolved = resolve(directory);
    const result: ImportSkillsResult = {
      trustedDirectory: resolved,
      imported: [],
      skipped: [],
      errors: [],
      conflicts: []
    };

    let entries: string[];
    try {
      entries = await readdir(resolved);
    } catch (error) {
      result.errors.push({
        path: resolved,
        reason: error instanceof Error ? error.message : "Unable to read skill directory."
      });
      return result;
    }

    for (const entry of entries) {
      const skillDir = join(resolved, entry);
      let skillMdPath = join(skillDir, "SKILL.md");
      try {
        const info = await stat(skillDir);
        if (!info.isDirectory()) {
          if (entry.toLowerCase() === "skill.md" || entry.toLowerCase().endsWith(".md")) {
            skillMdPath = skillDir;
          } else {
            continue;
          }
        } else {
          await access(skillMdPath);
        }
      } catch {
        const alt = join(skillDir, "skill.md");
        try {
          await access(alt);
          skillMdPath = alt;
        } catch {
          continue;
        }
      }

      try {
        const raw = await readFile(skillMdPath, "utf8");
        const meta = parseSkillFrontmatter(raw);
        const body = stripSkillFrontmatter(raw);
        const id = slugify(meta.name ?? (entry.replace(/\.md$/i, "") || "skill"));
        if (!id) {
          result.errors.push({ path: skillMdPath, reason: "Skill id could not be derived." });
          continue;
        }

        const existing = this.skills.get(id);
        if (existing) {
          // Same source may refresh from disk; lower priority never overrides higher; builtin never overridden.
          const challengerPriority = skillSourcePriority(options.source);
          const incumbentPriority = skillSourcePriority(existing.source);
          const blocked =
            existing.source === "builtin"
            || challengerPriority < incumbentPriority;
          if (blocked) {
            const reason =
              existing.source === "builtin"
                ? "Built-in skill cannot be overwritten by a local file."
                : `Skill source "${options.source}" cannot override existing source "${existing.source}" (priority).`;
            result.skipped.push({ id, reason });
            result.conflicts?.push({
              skillId: id,
              winner: existing.source,
              losers: [{ source: options.source, path: skillMdPath, reason }]
            });
            continue;
          }
        }

        const timestamp = nowIso();
        const override = this.state.overrides[id];
        const isNew = !existing;
        const install = this.state.installs?.[id];
        const contentHash = hashSkillContent(raw);

        let trusted: boolean;
        if (override?.trusted !== undefined) {
          trusted = override.trusted;
        } else if (options.requireTrustForNew && isNew) {
          trusted = false;
        } else {
          trusted = existing?.trusted ?? false;
        }

        // Prefer install-record source for catalog reloads
        let source = options.source;
        let catalogId = existing?.catalogId;
        if (options.preferInstallRecords && install) {
          source = install.source;
          catalogId = install.catalogId ?? catalogId;
        }

        const skill: SkillDefinition = {
          id,
          name: meta.name?.trim() || id,
          version: meta.version?.trim() || existing?.version || "1.0.0",
          description: meta.description?.trim() || existing?.description || "",
          path: skillMdPath,
          sourceDir: resolved,
          source,
          projectId: options.projectId ?? existing?.projectId,
          catalogId,
          enabled: override?.enabled ?? existing?.enabled ?? true,
          trusted,
          trustedAt: trusted ? (override?.trustedAt ?? existing?.trustedAt ?? timestamp) : undefined,
          tags: meta.tags ?? existing?.tags ?? [],
          requiredTools: meta.requiredTools ?? existing?.requiredTools ?? [],
          permissionHints: (meta.permissionHints ?? existing?.permissionHints ?? []) as ToolPermissionCategory[],
          author: meta.author,
          rawContent: raw,
          instructions: body,
          contentHash,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp
        };

        // Track install inventory for non-builtin disk skills if missing
        if (source !== "builtin") {
          if (!this.state.installs) this.state.installs = {};
          if (!this.state.installs[id]) {
            this.state.installs[id] = {
              skillId: id,
              source,
              catalogId,
              version: skill.version,
              contentHash,
              installedAt: timestamp,
              updatedAt: timestamp,
              history: []
            };
          }
        }

        this.skills.set(id, skill);
        result.imported.push(this.enrichDefinition(skill));
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

  private enrichDefinition(skill: SkillDefinition): SkillDefinition {
    const install = this.state.installs?.[skill.id];
    const catalogEntry = skill.catalogId
      ? this.catalog.get(skill.catalogId)
      : this.catalog.isAvailable()
        ? this.catalog.list().find((entry) => slugify(entry.name) === skill.id)
        : undefined;
    const contentHash =
      skill.contentHash
      ?? (skill.rawContent ? hashSkillContent(skill.rawContent) : undefined);
    const installStatus = resolveInstallStatus({
      skill,
      installRecord: install,
      catalogEntry,
      actualHash: contentHash
    });
    return {
      ...skill,
      tags: [...skill.tags],
      requiredTools: [...skill.requiredTools],
      permissionHints: [...skill.permissionHints],
      contentHash,
      installStatus
    };
  }

  private async ensureInstallRoot(): Promise<string> {
    if (this.installRoot) {
      await mkdir(this.installRoot, { recursive: true });
      this.state.installRoot = this.installRoot;
      return this.installRoot;
    }
    if (this.statePath) {
      this.installRoot = join(dirnameSafe(this.statePath), "installed-skills");
      await mkdir(this.installRoot, { recursive: true });
      this.state.installRoot = this.installRoot;
      return this.installRoot;
    }
    throw new Error(
      "No installRoot configured. Pass installRoot to SkillService.open for catalog installs."
    );
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirnameSafe(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    const durable: SkillState = {
      schemaVersion: 1,
      trustedDirectories: [...this.state.trustedDirectories],
      projectDirectories: [...(this.state.projectDirectories ?? [])],
      installRoot: this.state.installRoot ?? this.installRoot,
      overrides: { ...this.state.overrides },
      installs: this.state.installs ? { ...this.state.installs } : {}
    };
    await writeFile(temporaryPath, `${JSON.stringify(durable, null, 2)}\n`, {
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

function cloneInstallRecord(record: SkillInstallRecord): SkillInstallRecord {
  return {
    ...record,
    history: record.history.map((entry) => ({ ...entry }))
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
  return (
    childPath === parentPath
    || childPath.startsWith(`${parentPath}${sep}`)
    || childPath.startsWith(`${parentPath}/`)
  );
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
