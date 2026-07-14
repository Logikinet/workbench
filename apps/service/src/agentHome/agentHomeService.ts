/**
 * Agent Home service (Task 37).
 *
 * Long-term roles get isolated homes under longTermRoot/{roleId}.
 * Temporary agents get disposable homes under tempRoot/{tempId}.
 * Private memory never crosses role or shared-export boundaries.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import {
  assertHomeCannotOverrideHardRules,
  composeWithHardRules,
  FIRSTMATE_HARD_RULES
} from "./firstmateHardRules.js";
import {
  allDefaultTemplates,
  CURRENT_TEMPLATE_VERSION,
  defaultTemplateContent,
  migrateTemplates
} from "./homeTemplates.js";
import type {
  AgentHomeDescriptor,
  AgentHomeMeta,
  HomeKind,
  HomeProfileFile,
  HomeSkillSummary,
  LoadedHomeContext,
  LoadHomeContextOptions,
  MemoryEntry,
  MemoryLayer,
  PromoteTempHomeInput,
  SharedHomeExport,
  TemplateDiffResult,
  WriteMemoryInput
} from "./agentHomeTypes.js";
import { HOME_PROFILE_FILES, MEMORY_LAYERS } from "./agentHomeTypes.js";

const META_FILE = ".home.json";
const MEMORY_ENTRIES_FILE = join("memory", "entries.json");
const SKILLS_DIR = "skills";

export interface AgentHomeServiceOptions {
  /** Root for long-term role homes: {root}/{roleId}/ */
  longTermRoot: string;
  /** Root for temporary homes: {root}/{tempId}/ */
  tempRoot: string;
}

export class AgentHomeService {
  private constructor(
    private readonly longTermRoot: string,
    private readonly tempRoot: string
  ) {}

  static async open(options: AgentHomeServiceOptions): Promise<AgentHomeService> {
    const longTermRoot = resolve(options.longTermRoot);
    const tempRoot = resolve(options.tempRoot);
    await mkdir(longTermRoot, { recursive: true });
    await mkdir(tempRoot, { recursive: true });
    return new AgentHomeService(longTermRoot, tempRoot);
  }

  get hardRules(): string {
    return FIRSTMATE_HARD_RULES;
  }

  get currentTemplateVersion(): number {
    return CURRENT_TEMPLATE_VERSION;
  }

  // ── Ensure / create ──────────────────────────────────────────────

  /**
   * Ensure a long-term Home exists for a role. Isolated from other roles.
   * Applies template migration when needed.
   */
  async ensureLongTermHome(
    roleId: string,
    options: { displayName?: string } = {}
  ): Promise<AgentHomeDescriptor> {
    const id = requireId(roleId, "roleId");
    const homePath = this.longTermPath(id);
    await mkdir(homePath, { recursive: true });
    await mkdir(join(homePath, SKILLS_DIR), { recursive: true });
    await mkdir(join(homePath, "memory"), { recursive: true });

    let meta = await this.readMetaAt(homePath);
    const now = nowIso();
    if (!meta) {
      meta = {
        schemaVersion: 1,
        homeId: id,
        roleId: id,
        kind: "long_term",
        displayName: options.displayName?.trim() || undefined,
        templateVersion: 0,
        createdAt: now,
        updatedAt: now
      };
      await this.writeMetaAt(homePath, meta);
      await this.seedDefaults(homePath, meta);
      meta.templateVersion = CURRENT_TEMPLATE_VERSION;
      meta.updatedAt = nowIso();
      await this.writeMetaAt(homePath, meta);
    } else {
      if (meta.kind !== "long_term") {
        throw new Error(`Home at ${homePath} is not a long-term home.`);
      }
      if (options.displayName?.trim()) {
        meta.displayName = options.displayName.trim();
      }
      meta.roleId = id;
      meta.homeId = id;
      await this.migrateHomeAt(homePath, meta);
    }

    return this.toDescriptor(meta, homePath);
  }

  /**
   * Create a temporary Home. Only becomes durable after promoteTemporaryToLongTerm.
   */
  async createTemporaryHome(
    options: { displayName?: string; tempId?: string } = {}
  ): Promise<AgentHomeDescriptor> {
    const tempId = options.tempId?.trim() || `temp-${randomUUID()}`;
    const homePath = this.tempPath(tempId);
    if (await pathExists(homePath)) {
      throw new Error(`Temporary home already exists: ${tempId}`);
    }
    await mkdir(homePath, { recursive: true });
    await mkdir(join(homePath, SKILLS_DIR), { recursive: true });
    await mkdir(join(homePath, "memory"), { recursive: true });

    const now = nowIso();
    const meta: AgentHomeMeta = {
      schemaVersion: 1,
      homeId: tempId,
      kind: "temporary",
      displayName: options.displayName?.trim() || undefined,
      templateVersion: CURRENT_TEMPLATE_VERSION,
      createdAt: now,
      updatedAt: now
    };
    await this.writeMetaAt(homePath, meta);
    await this.seedDefaults(homePath, meta);
    return this.toDescriptor(meta, homePath);
  }

  /**
   * Promote a temporary home into a long-term role home.
   * Copies files into the role's isolated directory and removes the temp home.
   */
  async promoteTemporaryToLongTerm(input: PromoteTempHomeInput): Promise<AgentHomeDescriptor> {
    const tempId = requireId(input.tempHomeId, "tempHomeId");
    const roleId = requireId(input.roleId, "roleId");
    const tempPath = this.tempPath(tempId);
    const meta = await this.readMetaAt(tempPath);
    if (!meta || meta.kind !== "temporary") {
      throw new Error(`Temporary home "${tempId}" was not found.`);
    }

    const longPath = this.longTermPath(roleId);
    if (await pathExists(join(longPath, META_FILE))) {
      throw new Error(`Long-term home for role "${roleId}" already exists.`);
    }

    await mkdir(dirname(longPath), { recursive: true });
    await cp(tempPath, longPath, { recursive: true });

    const promoted: AgentHomeMeta = {
      ...meta,
      homeId: roleId,
      roleId,
      kind: "long_term",
      displayName: input.displayName?.trim() || meta.displayName,
      updatedAt: nowIso()
    };
    await this.writeMetaAt(longPath, promoted);
    await this.migrateHomeAt(longPath, promoted);

    await rm(tempPath, { recursive: true, force: true });
    return this.toDescriptor(promoted, longPath);
  }

  async disposeTemporaryHome(tempHomeId: string): Promise<void> {
    const tempId = requireId(tempHomeId, "tempHomeId");
    const tempPath = this.tempPath(tempId);
    const meta = await this.readMetaAt(tempPath);
    if (meta && meta.kind !== "temporary") {
      throw new Error(`Home "${tempId}" is not temporary.`);
    }
    await rm(tempPath, { recursive: true, force: true });
  }

  async getHome(
    homeId: string,
    kind: HomeKind = "long_term"
  ): Promise<AgentHomeDescriptor> {
    const id = requireId(homeId, "homeId");
    const homePath = kind === "long_term" ? this.longTermPath(id) : this.tempPath(id);
    const meta = await this.readMetaAt(homePath);
    if (!meta) throw new Error(`Agent Home "${id}" (${kind}) was not found.`);
    return this.toDescriptor(meta, homePath);
  }

  async listLongTermHomes(): Promise<AgentHomeDescriptor[]> {
    const entries = await safeReaddir(this.longTermRoot);
    const result: AgentHomeDescriptor[] = [];
    for (const name of entries) {
      const homePath = join(this.longTermRoot, name);
      const meta = await this.readMetaAt(homePath);
      if (meta?.kind === "long_term") {
        result.push(this.toDescriptor(meta, homePath));
      }
    }
    return result.sort((a, b) => a.homeId.localeCompare(b.homeId));
  }

  homePathFor(homeId: string, kind: HomeKind = "long_term"): string {
    const id = requireId(homeId, "homeId");
    return kind === "long_term" ? this.longTermPath(id) : this.tempPath(id);
  }

  // ── Profile files ────────────────────────────────────────────────

  async readProfileFile(
    homeId: string,
    file: HomeProfileFile,
    kind: HomeKind = "long_term"
  ): Promise<string> {
    assertProfileFile(file);
    const homePath = await this.requireHomePath(homeId, kind);
    return readFile(join(homePath, file), "utf8");
  }

  async writeProfileFile(
    homeId: string,
    file: HomeProfileFile,
    content: string,
    kind: HomeKind = "long_term"
  ): Promise<void> {
    assertProfileFile(file);
    if (typeof content !== "string") {
      throw new Error("Profile content must be a string.");
    }
    assertHomeCannotOverrideHardRules(content, file);
    const homePath = await this.requireHomePath(homeId, kind);
    await atomicWrite(join(homePath, file), content);
    await this.touchMeta(homePath);
  }

  // ── Skills under Home ────────────────────────────────────────────

  async listSkills(homeId: string, kind: HomeKind = "long_term"): Promise<HomeSkillSummary[]> {
    const homePath = await this.requireHomePath(homeId, kind);
    const skillsRoot = join(homePath, SKILLS_DIR);
    await mkdir(skillsRoot, { recursive: true });
    const files = await collectFiles(skillsRoot);
    return files
      .filter((abs) => abs.endsWith(".md"))
      .map((abs) => {
        const relativePath = relative(skillsRoot, abs).split(/[/\\]/).join("/");
        const id = skillIdFromRelative(relativePath);
        return { id, relativePath, absolutePath: abs };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async writeSkill(
    homeId: string,
    relativePath: string,
    content: string,
    kind: HomeKind = "long_term"
  ): Promise<HomeSkillSummary> {
    if (typeof content !== "string") throw new Error("Skill content must be a string.");
    assertHomeCannotOverrideHardRules(content, `skills/${relativePath}`);
    const homePath = await this.requireHomePath(homeId, kind);
    const skillsRoot = join(homePath, SKILLS_DIR);
    const safeRel = safeRelativeSkillPath(relativePath);
    const abs = join(skillsRoot, safeRel);
    assertInside(abs, skillsRoot);
    await mkdir(dirname(abs), { recursive: true });
    await atomicWrite(abs, content);
    await this.touchMeta(homePath);
    return {
      id: skillIdFromRelative(safeRel),
      relativePath: safeRel.split(/[/\\]/).join("/"),
      absolutePath: abs
    };
  }

  async readSkill(
    homeId: string,
    relativePath: string,
    kind: HomeKind = "long_term"
  ): Promise<string> {
    const homePath = await this.requireHomePath(homeId, kind);
    const skillsRoot = join(homePath, SKILLS_DIR);
    const safeRel = safeRelativeSkillPath(relativePath);
    const abs = join(skillsRoot, safeRel);
    assertInside(abs, skillsRoot);
    return readFile(abs, "utf8");
  }

  // ── Layered memory ───────────────────────────────────────────────

  /**
   * Append a memory entry. Source is required. Inferences are never stored as facts.
   */
  async writeMemory(
    homeId: string,
    input: WriteMemoryInput,
    kind: HomeKind = "long_term"
  ): Promise<MemoryEntry> {
    const homePath = await this.requireHomePath(homeId, kind);
    const layer = input.layer;
    if (!MEMORY_LAYERS.includes(layer)) {
      throw new Error(`Unknown memory layer: ${String(layer)}`);
    }
    const source = input.source?.trim();
    if (!source) {
      throw new Error("Memory writes must record a source.");
    }
    const content = input.content?.trim();
    if (!content) {
      throw new Error("Memory content is required.");
    }
    assertHomeCannotOverrideHardRules(content, `memory:${layer}`);

    const confidence = input.confidence ?? "fact";
    if (confidence !== "fact" && confidence !== "inference") {
      throw new Error('Memory confidence must be "fact" or "inference".');
    }
    // Explicit rule: uncertain inferences must not be saved as facts.
    // Callers that pass confidence:"inference" stay as inference; we never coerce to fact.
    if (confidence === "fact" && looksLikeUncertainInference(content)) {
      throw new Error(
        "Uncertain inferences must not be saved as facts. Pass confidence: \"inference\" or confirm the fact first."
      );
    }

    if (layer === "project_facts" && !input.projectId?.trim()) {
      throw new Error("project_facts entries require projectId.");
    }
    if (layer === "task_checkpoints" && !input.taskId?.trim()) {
      throw new Error("task_checkpoints entries require taskId.");
    }

    const entry: MemoryEntry = {
      id: randomUUID(),
      layer,
      content,
      source,
      confidence,
      projectId: input.projectId?.trim() || undefined,
      taskId: input.taskId?.trim() || undefined,
      createdAt: nowIso()
    };

    const entries = await this.readMemoryEntries(homePath);
    entries.push(entry);
    await this.writeMemoryEntries(homePath, entries);
    await this.touchMeta(homePath);
    return { ...entry };
  }

  async listMemory(
    homeId: string,
    options: {
      kind?: HomeKind;
      layers?: MemoryLayer[];
      projectId?: string;
      taskId?: string;
      confidence?: MemoryEntry["confidence"];
    } = {}
  ): Promise<MemoryEntry[]> {
    const kind = options.kind ?? "long_term";
    const homePath = await this.requireHomePath(homeId, kind);
    let entries = await this.readMemoryEntries(homePath);
    if (options.layers?.length) {
      const allow = new Set(options.layers);
      entries = entries.filter((e) => allow.has(e.layer));
    }
    if (options.projectId) {
      entries = entries.filter(
        (e) => e.layer !== "project_facts" && e.layer !== "task_checkpoints"
          ? true
          : e.projectId === options.projectId
      );
    }
    if (options.taskId) {
      entries = entries.filter((e) =>
        e.layer === "task_checkpoints" ? e.taskId === options.taskId : true
      );
    }
    if (options.confidence) {
      entries = entries.filter((e) => e.confidence === options.confidence);
    }
    return entries.map((e) => ({ ...e }));
  }

  // ── Context load (minimal) ───────────────────────────────────────

  /**
   * Minimally load Home context for a session. Private MEMORY.md / role_experience
   * only when includePrivateMemory is true (owning role private session).
   */
  async loadContext(
    homeId: string,
    options: LoadHomeContextOptions & { kind?: HomeKind } = {}
  ): Promise<LoadedHomeContext> {
    const kind = options.kind ?? "long_term";
    const homePath = await this.requireHomePath(homeId, kind);
    const meta = (await this.readMetaAt(homePath))!;
    const omitted: string[] = [];

    const defaultProfile: HomeProfileFile[] = ["AGENTS.md", "IDENTITY.md", "USER.md", "TOOLS.md"];
    const profileFiles = options.profileFiles ?? defaultProfile;
    const profile: LoadedHomeContext["profile"] = {};

    // Private long-term memory is omitted unless explicitly requested for the owner.
    if (!options.includePrivateMemory) {
      omitted.push("MEMORY.md", "memory:role_experience");
    }

    for (const file of profileFiles) {
      assertProfileFile(file);
      if (file === "MEMORY.md" && !options.includePrivateMemory) {
        continue;
      }
      try {
        profile[file] = await readFile(join(homePath, file), "utf8");
      } catch (error: unknown) {
        if (isEnoent(error)) omitted.push(file);
        else throw error;
      }
    }

    const memoryLayers: LoadedHomeContext["memoryLayers"] = {};
    const requestedLayers = options.layers ?? [];
    if (requestedLayers.length > 0) {
      const entries = await this.readMemoryEntries(homePath);
      for (const layer of requestedLayers) {
        if (!MEMORY_LAYERS.includes(layer)) continue;
        if (layer === "role_experience" && !options.includePrivateMemory) {
          continue;
        }
        let layerEntries = entries.filter((e) => e.layer === layer);
        if (layer === "project_facts" && options.projectId) {
          layerEntries = layerEntries.filter((e) => e.projectId === options.projectId);
        }
        if (layer === "task_checkpoints") {
          if (options.taskId) {
            layerEntries = layerEntries.filter((e) => e.taskId === options.taskId);
          }
          if (options.projectId) {
            layerEntries = layerEntries.filter(
              (e) => !e.projectId || e.projectId === options.projectId
            );
          }
        }
        memoryLayers[layer] = layerEntries.map((e) => ({ ...e }));
      }
    }

    const skills: LoadedHomeContext["skills"] = [];
    if (options.includeSkills) {
      const listed = await this.listSkills(homeId, kind);
      for (const skill of listed) {
        skills.push({
          id: skill.id,
          relativePath: skill.relativePath,
          content: await readFile(skill.absolutePath, "utf8")
        });
      }
    }

    return {
      homeId: meta.homeId,
      roleId: meta.roleId,
      kind: meta.kind,
      path: homePath,
      firstmateHardRules: FIRSTMATE_HARD_RULES,
      hardRulesSource: "system",
      profile,
      memoryLayers,
      skills,
      omitted: [...new Set(omitted)]
    };
  }

  /**
   * Compose system+home instructions. Hard rules always prepend and win.
   */
  composeInstructions(context: LoadedHomeContext): string {
    const supplements: string[] = [];
    for (const file of HOME_PROFILE_FILES) {
      if (file === "MEMORY.md") continue;
      const body = context.profile[file];
      if (body?.trim()) supplements.push(`### ${file}\n${body.trim()}`);
    }
    if (context.profile["MEMORY.md"]?.trim()) {
      supplements.push(`### MEMORY.md (private)\n${context.profile["MEMORY.md"]!.trim()}`);
    }
    for (const [layer, entries] of Object.entries(context.memoryLayers)) {
      if (!entries?.length) continue;
      const body = entries
        .map(
          (e) =>
            `- [${e.confidence}] (${e.source}) ${e.content}` +
            (e.projectId ? ` {project:${e.projectId}}` : "") +
            (e.taskId ? ` {task:${e.taskId}}` : "")
        )
        .join("\n");
      supplements.push(`### memory:${layer}\n${body}`);
    }
    for (const skill of context.skills) {
      supplements.push(`### skill:${skill.id}\n${skill.content.trim()}`);
    }
    return composeWithHardRules(supplements);
  }

  /**
   * Export a shareable snapshot. Private long-term memory is never included.
   */
  async exportShared(homeId: string, kind: HomeKind = "long_term"): Promise<SharedHomeExport> {
    const homePath = await this.requireHomePath(homeId, kind);
    const meta = (await this.readMetaAt(homePath))!;
    const profile: SharedHomeExport["profile"] = {};
    for (const file of ["AGENTS.md", "IDENTITY.md", "USER.md", "TOOLS.md"] as const) {
      try {
        profile[file] = await readFile(join(homePath, file), "utf8");
      } catch (error: unknown) {
        if (!isEnoent(error)) throw error;
      }
    }
    const skills = (await this.listSkills(homeId, kind)).map((s) => ({
      id: s.id,
      relativePath: s.relativePath
    }));
    return {
      homeId: meta.homeId,
      roleId: meta.roleId,
      kind: meta.kind,
      profile,
      privateMemoryIncluded: false,
      skills
    };
  }

  /**
   * Cross-role private memory access is forbidden.
   * Other roles may not read this home's MEMORY.md or private layers.
   */
  async assertPrivateMemoryIsolated(
    ownerHomeId: string,
    requesterHomeId: string,
    kind: HomeKind = "long_term"
  ): Promise<void> {
    if (ownerHomeId === requesterHomeId) return;
    // Requester is a different home — they must not receive private memory.
    const ownerPath = this.homePathFor(ownerHomeId, kind);
    const ownerMeta = await this.readMetaAt(ownerPath);
    if (!ownerMeta) throw new Error(`Owner home "${ownerHomeId}" was not found.`);
    throw new Error(
      `Private long-term memory of home "${ownerHomeId}" is not accessible to home "${requesterHomeId}" (or shared evidence / ordinary artifacts).`
    );
  }

  // ── Template versioning ──────────────────────────────────────────

  async migrateHome(homeId: string, kind: HomeKind = "long_term"): Promise<AgentHomeDescriptor> {
    const homePath = await this.requireHomePath(homeId, kind);
    const meta = (await this.readMetaAt(homePath))!;
    await this.migrateHomeAt(homePath, meta);
    return this.toDescriptor(meta, homePath);
  }

  async restoreDefaults(
    homeId: string,
    options: { files?: HomeProfileFile[]; kind?: HomeKind } = {}
  ): Promise<AgentHomeDescriptor> {
    const kind = options.kind ?? "long_term";
    const homePath = await this.requireHomePath(homeId, kind);
    const meta = (await this.readMetaAt(homePath))!;
    const ctx = {
      displayName: meta.displayName,
      roleId: meta.roleId,
      kind: meta.kind
    };
    const targets = options.files?.length ? options.files : [...HOME_PROFILE_FILES];
    for (const file of targets) {
      assertProfileFile(file);
      await atomicWrite(join(homePath, file), defaultTemplateContent(file, ctx));
    }
    meta.templateVersion = CURRENT_TEMPLATE_VERSION;
    meta.updatedAt = nowIso();
    await this.writeMetaAt(homePath, meta);
    return this.toDescriptor(meta, homePath);
  }

  async diffAgainstDefaults(
    homeId: string,
    kind: HomeKind = "long_term"
  ): Promise<TemplateDiffResult> {
    const homePath = await this.requireHomePath(homeId, kind);
    const meta = (await this.readMetaAt(homePath))!;
    const ctx = {
      displayName: meta.displayName,
      roleId: meta.roleId,
      kind: meta.kind
    };
    const defaults = allDefaultTemplates(ctx);
    const files = [];
    for (const file of HOME_PROFILE_FILES) {
      let current = "";
      try {
        current = await readFile(join(homePath, file), "utf8");
      } catch (error: unknown) {
        if (!isEnoent(error)) throw error;
      }
      const defaultContent = defaults[file];
      files.push({
        file,
        current,
        defaultContent,
        changed: normalizeNewlines(current) !== normalizeNewlines(defaultContent)
      });
    }
    return {
      homeId: meta.homeId,
      templateVersion: meta.templateVersion,
      currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
      files
    };
  }

  // ── Internals ────────────────────────────────────────────────────

  private longTermPath(roleId: string): string {
    return join(this.longTermRoot, sanitizeSegment(roleId));
  }

  private tempPath(tempId: string): string {
    return join(this.tempRoot, sanitizeSegment(tempId));
  }

  private async requireHomePath(homeId: string, kind: HomeKind): Promise<string> {
    const id = requireId(homeId, "homeId");
    const homePath = kind === "long_term" ? this.longTermPath(id) : this.tempPath(id);
    const meta = await this.readMetaAt(homePath);
    if (!meta) throw new Error(`Agent Home "${id}" (${kind}) was not found.`);
    if (meta.kind !== kind) {
      throw new Error(`Agent Home "${id}" kind mismatch: expected ${kind}, found ${meta.kind}.`);
    }
    return homePath;
  }

  private async seedDefaults(homePath: string, meta: AgentHomeMeta): Promise<void> {
    const ctx = {
      displayName: meta.displayName,
      roleId: meta.roleId,
      kind: meta.kind
    };
    const defaults = allDefaultTemplates(ctx);
    for (const file of HOME_PROFILE_FILES) {
      const target = join(homePath, file);
      if (!(await pathExists(target))) {
        await atomicWrite(target, defaults[file]);
      }
    }
    await mkdir(join(homePath, SKILLS_DIR), { recursive: true });
    await mkdir(join(homePath, "memory"), { recursive: true });
    if (!(await pathExists(join(homePath, MEMORY_ENTRIES_FILE)))) {
      await atomicWrite(join(homePath, MEMORY_ENTRIES_FILE), "[]\n");
    }
  }

  private async migrateHomeAt(homePath: string, meta: AgentHomeMeta): Promise<void> {
    if (meta.templateVersion >= CURRENT_TEMPLATE_VERSION) {
      // Still ensure skills/memory dirs exist
      await mkdir(join(homePath, SKILLS_DIR), { recursive: true });
      await mkdir(join(homePath, "memory"), { recursive: true });
      return;
    }

    const currentFiles: Partial<Record<HomeProfileFile, string>> = {};
    for (const file of HOME_PROFILE_FILES) {
      try {
        currentFiles[file] = await readFile(join(homePath, file), "utf8");
      } catch (error: unknown) {
        if (!isEnoent(error)) throw error;
      }
    }

    const result = migrateTemplates({
      fromVersion: meta.templateVersion,
      currentFiles,
      ctx: {
        displayName: meta.displayName,
        roleId: meta.roleId,
        kind: meta.kind
      }
    });

    for (const file of result.migrated) {
      const content = result.files[file];
      if (content !== undefined) {
        await atomicWrite(join(homePath, file), content);
      }
    }

    meta.templateVersion = result.toVersion;
    meta.updatedAt = nowIso();
    await this.writeMetaAt(homePath, meta);
    await mkdir(join(homePath, SKILLS_DIR), { recursive: true });
    await mkdir(join(homePath, "memory"), { recursive: true });
    if (!(await pathExists(join(homePath, MEMORY_ENTRIES_FILE)))) {
      await atomicWrite(join(homePath, MEMORY_ENTRIES_FILE), "[]\n");
    }
  }

  private async readMetaAt(homePath: string): Promise<AgentHomeMeta | undefined> {
    try {
      const raw = JSON.parse(await readFile(join(homePath, META_FILE), "utf8")) as Partial<AgentHomeMeta>;
      if (raw.schemaVersion !== 1 || typeof raw.homeId !== "string" || !raw.kind) {
        throw new Error(`Agent Home meta is not compatible at ${homePath}.`);
      }
      return {
        schemaVersion: 1,
        homeId: raw.homeId,
        roleId: typeof raw.roleId === "string" ? raw.roleId : undefined,
        kind: raw.kind,
        displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
        templateVersion: typeof raw.templateVersion === "number" ? raw.templateVersion : 0,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso()
      };
    } catch (error: unknown) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  }

  private async writeMetaAt(homePath: string, meta: AgentHomeMeta): Promise<void> {
    await mkdir(homePath, { recursive: true });
    await atomicWrite(join(homePath, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  }

  private async touchMeta(homePath: string): Promise<void> {
    const meta = await this.readMetaAt(homePath);
    if (!meta) return;
    meta.updatedAt = nowIso();
    await this.writeMetaAt(homePath, meta);
  }

  private async readMemoryEntries(homePath: string): Promise<MemoryEntry[]> {
    const path = join(homePath, MEMORY_ENTRIES_FILE);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter(isMemoryEntry).map((e) => ({ ...e }));
    } catch (error: unknown) {
      if (isEnoent(error)) return [];
      throw error;
    }
  }

  private async writeMemoryEntries(homePath: string, entries: MemoryEntry[]): Promise<void> {
    await mkdir(join(homePath, "memory"), { recursive: true });
    await atomicWrite(join(homePath, MEMORY_ENTRIES_FILE), `${JSON.stringify(entries, null, 2)}\n`);
  }

  private toDescriptor(meta: AgentHomeMeta, homePath: string): AgentHomeDescriptor {
    return {
      homeId: meta.homeId,
      roleId: meta.roleId,
      kind: meta.kind,
      path: homePath,
      templateVersion: meta.templateVersion,
      displayName: meta.displayName,
      files: [...HOME_PROFILE_FILES],
      skillsDir: join(homePath, SKILLS_DIR),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt
    };
  }
}

// ── helpers ────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function requireId(value: string, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  if (trimmed.includes("..") || /[/\\]/.test(trimmed)) {
    throw new Error(`${label} contains invalid path characters.`);
  }
  return trimmed;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}

function assertProfileFile(file: string): asserts file is HomeProfileFile {
  if (!(HOME_PROFILE_FILES as readonly string[]).includes(file)) {
    throw new Error(`Unsupported Home profile file: ${file}`);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content.endsWith("\n") ? content : `${content}\n`, {
    encoding: "utf8",
    mode: constants.S_IRUSR | constants.S_IWUSR
  });
  await rename(temporaryPath, path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error: unknown) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error: unknown) {
      if (isEnoent(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  }
  await walk(root);
  return out;
}

function safeRelativeSkillPath(relativePath: string): string {
  const trimmed = relativePath?.trim().replace(/\\/g, "/");
  if (!trimmed) throw new Error("Skill relative path is required.");
  if (trimmed.startsWith("/") || trimmed.includes("..")) {
    throw new Error("Skill path must be relative and stay under skills/.");
  }
  return normalize(trimmed);
}

function assertInside(child: string, parent: string): void {
  const resolvedChild = resolve(child);
  const resolvedParent = resolve(parent);
  const rel = relative(resolvedParent, resolvedChild);
  if (rel.startsWith("..") || rel === "" && resolvedChild !== resolvedParent) {
    // empty rel means same path — for files we need child under parent
  }
  if (resolvedChild !== resolvedParent && !resolvedChild.startsWith(resolvedParent + sep) && !resolvedChild.startsWith(resolvedParent + "/")) {
    // On Windows, normalize comparison
    const childN = resolvedChild.toLowerCase();
    const parentN = resolvedParent.toLowerCase();
    if (childN !== parentN && !childN.startsWith(parentN + sep.toLowerCase()) && !childN.startsWith(parentN + "\\")) {
      throw new Error("Path escapes Home skills directory.");
    }
  }
}

function skillIdFromRelative(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.endsWith("/SKILL.md") || normalized === "SKILL.md") {
    const dir = dirname(normalized);
    return dir === "." ? "skill" : dir.split("/").filter(Boolean).join(".");
  }
  return normalized.replace(/\.md$/i, "").split("/").filter(Boolean).join(".");
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as MemoryEntry;
  return (
    typeof e.id === "string" &&
    typeof e.layer === "string" &&
    MEMORY_LAYERS.includes(e.layer as MemoryLayer) &&
    typeof e.content === "string" &&
    typeof e.source === "string" &&
    (e.confidence === "fact" || e.confidence === "inference") &&
    typeof e.createdAt === "string"
  );
}

/**
 * Heuristic: content that presents itself as uncertain should not be written as fact.
 */
function looksLikeUncertainInference(content: string): boolean {
  return (
    /\b(i think|i believe|might be|maybe|possibly|probably|not sure|uncertain|guess)\b/i.test(
      content
    ) || /^\s*\[inference\]/i.test(content)
  );
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
}

// re-export for tests that want the heuristic
export { looksLikeUncertainInference, CURRENT_TEMPLATE_VERSION };
