/**
 * Artifact document browser service (Task 42).
 *
 * - Safe browse under Project workspace grant (no path traversal)
 * - On-demand preview for md/text/code/image/pdf + OOXML readonly extract
 * - Catalog: versions, creator, run, review, evidence/diff links
 * - External Office/WPS open + change detection
 * - Reveal / copy path / export / package
 *
 * Local files are the only truth; previews never rewrite formats.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ARTIFACT_CATALOG_SCHEMA_VERSION,
  DEFAULT_BROWSE_LIMIT,
  DEFAULT_INLINE_BINARY_BYTES,
  DEFAULT_MAX_TEXT_CHARS,
  DEFAULT_TEXT_PREVIEW_BYTES,
  LARGE_FILE_THRESHOLD_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_ENTRIES,
  type ArtifactCatalogState,
  type ArtifactListFilter,
  type ArtifactOrigin,
  type ArtifactRecord,
  type ArtifactVersion,
  type BrowseResult,
  type BrowserEntry,
  type ChangeDetectResult,
  type CopyPathResult,
  type ExportRequest,
  type ExportResult,
  type ExternalAppKind,
  type ExternalOpenResult,
  type FileFingerprint,
  type OfficeAvailability,
  type PackageRequest,
  type PackageResult,
  type PathStat,
  type PreviewRange,
  type PreviewResult,
  type RegisterArtifactInput,
  type RevealResult,
  type ReviewStatus,
  type UpdateArtifactInput
} from "./artifactTypes.js";
import {
  detectOfficeAvailability,
  openWithExternalApp,
  revealInFileManager
} from "./officeOpen.js";
import {
  PathSafetyError,
  basenameOf,
  extensionOf,
  parentRelativePath,
  resolveExistingSafePath,
  resolveSafePath,
  safeStat,
  toProjectRelative
} from "./pathSafety.js";
import { classifyPreviewKind, languageHint, looksBinary, mimeFor } from "./previewKinds.js";
import {
  buildStoredZip,
  estimatePdfPageCount,
  previewDocx,
  previewPptx,
  previewXlsx
} from "./zipOoxml.js";

export interface ArtifactProjectPort {
  get(projectId: string): Promise<{ id: string; name: string; workspacePath: string }>;
}

export interface ArtifactRunPort {
  get(runId: string): Promise<{
    id: string;
    todoId?: string;
    status?: string;
    artifacts: Array<{
      id: string;
      path: string;
      kind: string;
      createdAt: string;
      evidence?: {
        source?: string;
        diff?: string;
        changedFiles?: string[];
        summary?: string;
        sessionStatus?: string;
      };
    }>;
    reviews?: Array<{ id: string; status?: string; summary?: string }>;
  }>;
}

export interface ArtifactBrowserFs {
  readdir: typeof readdir;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  mkdir: typeof mkdir;
  stat: typeof stat;
  copyFile: typeof copyFile;
  rename: typeof rename;
}

export interface ArtifactBrowserServiceOptions {
  /** Durable catalog path (JSON). Omit for in-memory. */
  catalogPath?: string;
  projects: ArtifactProjectPort;
  runs?: ArtifactRunPort;
  fs?: Partial<ArtifactBrowserFs>;
  now?: () => Date;
  /** Override office detection. */
  detectOffice?: () => Promise<OfficeAvailability> | OfficeAvailability;
  /** Override external open. */
  openExternal?: typeof openWithExternalApp;
  /** Override reveal. */
  reveal?: typeof revealInFileManager;
  browseLimit?: number;
  textPreviewBytes?: number;
  inlineBinaryBytes?: number;
}

const defaultFs: ArtifactBrowserFs = {
  readdir,
  readFile,
  writeFile,
  mkdir,
  stat,
  copyFile,
  rename
};

function emptyCatalog(): ArtifactCatalogState {
  return { schemaVersion: ARTIFACT_CATALOG_SCHEMA_VERSION, artifacts: [] };
}

export class ArtifactBrowserService {
  private readonly fs: ArtifactBrowserFs;
  private readonly now: () => Date;
  private readonly browseLimit: number;
  private readonly textPreviewBytes: number;
  private readonly inlineBinaryBytes: number;
  private openBaselines = new Map<string, FileFingerprint>();

  private constructor(
    private readonly catalogPath: string | undefined,
    private state: ArtifactCatalogState,
    private readonly options: ArtifactBrowserServiceOptions
  ) {
    this.fs = { ...defaultFs, ...options.fs };
    this.now = options.now ?? (() => new Date());
    this.browseLimit = options.browseLimit ?? DEFAULT_BROWSE_LIMIT;
    this.textPreviewBytes = options.textPreviewBytes ?? DEFAULT_TEXT_PREVIEW_BYTES;
    this.inlineBinaryBytes = options.inlineBinaryBytes ?? DEFAULT_INLINE_BINARY_BYTES;
  }

  static async open(options: ArtifactBrowserServiceOptions): Promise<ArtifactBrowserService> {
    if (!options.catalogPath) {
      return new ArtifactBrowserService(undefined, emptyCatalog(), options);
    }
    try {
      const raw = await (options.fs?.readFile ?? readFile)(options.catalogPath, "utf8");
      const decoded = JSON.parse(raw) as Partial<ArtifactCatalogState>;
      if (decoded.schemaVersion !== ARTIFACT_CATALOG_SCHEMA_VERSION || !Array.isArray(decoded.artifacts)) {
        throw new Error("Artifact catalog is not compatible with this service version.");
      }
      return new ArtifactBrowserService(options.catalogPath, {
        schemaVersion: ARTIFACT_CATALOG_SCHEMA_VERSION,
        artifacts: decoded.artifacts as ArtifactRecord[]
      }, options);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error as { code: string }).code === "ENOENT") {
        return new ArtifactBrowserService(options.catalogPath, emptyCatalog(), options);
      }
      throw error;
    }
  }

  static async createMemory(options: Omit<ArtifactBrowserServiceOptions, "catalogPath">): Promise<ArtifactBrowserService> {
    return new ArtifactBrowserService(undefined, emptyCatalog(), options);
  }

  // ── Browse / stat ──────────────────────────────────────────────────────────

  async browse(projectId: string, relativePath = "", limit?: number): Promise<BrowseResult> {
    const project = await this.requireProject(projectId);
    const max = Math.min(limit ?? this.browseLimit, this.browseLimit);
    const { absolutePath, relativePath: rel } = await resolveExistingSafePath(
      project.workspacePath,
      relativePath
    );
    const info = await this.fs.stat(absolutePath);
    if (!info.isDirectory()) {
      throw Object.assign(new Error("Browse path must be a directory."), { statusCode: 400 });
    }

    const dirents = await this.fs.readdir(absolutePath, { withFileTypes: true });
    const sorted = dirents
      .slice()
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const entries: BrowserEntry[] = [];
    for (const dirent of sorted.slice(0, max)) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      const childAbs = join(absolutePath, dirent.name);
      let size = 0;
      let mtime = this.now().toISOString();
      try {
        const st = await this.fs.stat(childAbs);
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch {
        // skip unreadable metadata
      }
      const kind = dirent.isDirectory() ? "directory" : "file";
      const previewKind = classifyPreviewKind(dirent.name, kind === "directory");
      entries.push({
        name: dirent.name,
        relativePath: toProjectRelative(childRel),
        kind,
        sizeBytes: size,
        modifiedAt: mtime,
        extension: extensionOf(dirent.name),
        previewKind,
        large: kind === "file" && size > LARGE_FILE_THRESHOLD_BYTES
      });
    }

    return {
      projectId,
      workspacePath: project.workspacePath,
      path: rel,
      entries,
      parentPath: parentRelativePath(rel),
      truncated: sorted.length > max,
      totalEntries: sorted.length
    };
  }

  async pathStat(projectId: string, relativePath: string): Promise<PathStat> {
    const project = await this.requireProject(projectId);
    try {
      const st = await safeStat(project.workspacePath, relativePath);
      const previewKind = classifyPreviewKind(st.relativePath || basenameOf(relativePath), st.isDirectory);
      let contentHash: string | undefined;
      if (st.isFile && st.size <= this.inlineBinaryBytes) {
        const buf = await this.fs.readFile(st.absolutePath);
        contentHash = hashBuffer(buf);
      } else if (st.isFile) {
        contentHash = await this.hashFilePartial(st.absolutePath, st.size);
      }
      return {
        projectId,
        relativePath: st.relativePath,
        absolutePath: st.absolutePath,
        kind: st.isDirectory ? "directory" : "file",
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
        createdAt: st.birthtime?.toISOString(),
        extension: extensionOf(st.relativePath),
        previewKind,
        exists: true,
        contentHash
      };
    } catch (error) {
      if (error instanceof PathSafetyError && error.code === "not_found") {
        const resolved = resolveSafePath(project.workspacePath, relativePath);
        return {
          projectId,
          relativePath: resolved.relativePath,
          absolutePath: resolved.absolutePath,
          kind: "file",
          sizeBytes: 0,
          modifiedAt: this.iso(),
          extension: extensionOf(resolved.relativePath),
          previewKind: classifyPreviewKind(resolved.relativePath),
          exists: false
        };
      }
      throw error;
    }
  }

  // ── Preview (on-demand; failures never mutate source) ──────────────────────

  async preview(projectId: string, relativePath: string, range: PreviewRange = {}): Promise<PreviewResult> {
    const project = await this.requireProject(projectId);
    const offset = Math.max(0, range.offset ?? 0);
    const limit = Math.min(range.limit ?? this.textPreviewBytes, this.textPreviewBytes);
    const maxTextChars = Math.min(range.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS, DEFAULT_MAX_TEXT_CHARS);

    let resolved: { absolutePath: string; relativePath: string; realPath: string };
    try {
      resolved = await resolveExistingSafePath(project.workspacePath, relativePath);
    } catch (error) {
      return this.previewError(projectId, relativePath, error);
    }

    try {
      const info = await this.fs.stat(resolved.realPath);
      if (info.isDirectory()) {
        return {
          projectId,
          relativePath: resolved.relativePath,
          previewKind: "directory",
          mimeType: "inode/directory",
          sizeBytes: 0,
          truncated: false,
          ok: false,
          error: "Path is a directory; use browse instead.",
          errorCode: "is_directory"
        };
      }

      const previewKind = classifyPreviewKind(resolved.relativePath);
      const mimeType = mimeFor(resolved.relativePath, previewKind);
      const sizeBytes = info.size;

      if (previewKind === "image") {
        return await this.previewImage(projectId, resolved, sizeBytes, mimeType);
      }
      if (previewKind === "pdf") {
        return await this.previewPdf(projectId, resolved, sizeBytes, mimeType);
      }
      if (previewKind === "docx" || previewKind === "xlsx" || previewKind === "pptx") {
        return await this.previewOffice(projectId, resolved, sizeBytes, mimeType, previewKind, maxTextChars);
      }

      // text / markdown / code / unknown — range read
      const fdBuf = await this.fs.readFile(resolved.realPath);
      if (looksBinary(fdBuf) && previewKind === "unknown") {
        return {
          projectId,
          relativePath: resolved.relativePath,
          previewKind: "binary",
          mimeType,
          sizeBytes,
          truncated: false,
          ok: true,
          error: "Binary file — open with external app or download.",
          errorCode: "unsupported"
        };
      }

      const slice = fdBuf.subarray(offset, Math.min(fdBuf.length, offset + limit));
      const text = slice.toString("utf8");
      const truncated = offset + slice.length < fdBuf.length || offset > 0;
      const kind =
        previewKind === "unknown" || previewKind === "text"
          ? looksBinary(slice)
            ? "binary"
            : previewKind === "unknown"
              ? "text"
              : previewKind
          : previewKind;

      return {
        projectId,
        relativePath: resolved.relativePath,
        previewKind: kind,
        mimeType,
        sizeBytes,
        truncated,
        ok: true,
        text: kind === "binary" ? undefined : text,
        language: kind === "code" || kind === "markdown" ? languageHint(resolved.relativePath) : undefined,
        encoding: "utf-8",
        range: { offset, length: slice.length, total: fdBuf.length }
      };
    } catch (error) {
      return this.previewError(projectId, relativePath, error);
    }
  }

  private async previewImage(
    projectId: string,
    resolved: { absolutePath: string; relativePath: string; realPath: string },
    sizeBytes: number,
    mimeType: string
  ): Promise<PreviewResult> {
    if (sizeBytes > this.inlineBinaryBytes) {
      return {
        projectId,
        relativePath: resolved.relativePath,
        previewKind: "image",
        mimeType,
        sizeBytes,
        truncated: true,
        ok: true,
        error: "Image too large for inline preview; use raw/download or external open.",
        errorCode: "too_large"
      };
    }
    const buf = await this.fs.readFile(resolved.realPath);
    return {
      projectId,
      relativePath: resolved.relativePath,
      previewKind: "image",
      mimeType,
      sizeBytes,
      truncated: false,
      ok: true,
      base64: buf.toString("base64")
    };
  }

  private async previewPdf(
    projectId: string,
    resolved: { absolutePath: string; relativePath: string; realPath: string },
    sizeBytes: number,
    mimeType: string
  ): Promise<PreviewResult> {
    // Always read for page estimate, but only inline small PDFs as base64.
    const buf = await this.fs.readFile(resolved.realPath);
    const pageCount = estimatePdfPageCount(buf);
    if (sizeBytes > this.inlineBinaryBytes) {
      return {
        projectId,
        relativePath: resolved.relativePath,
        previewKind: "pdf",
        mimeType,
        sizeBytes,
        truncated: true,
        ok: true,
        pageCount,
        error: "PDF too large for inline embed; use raw URL or external open.",
        errorCode: "too_large"
      };
    }
    return {
      projectId,
      relativePath: resolved.relativePath,
      previewKind: "pdf",
      mimeType,
      sizeBytes,
      truncated: false,
      ok: true,
      base64: buf.toString("base64"),
      pageCount
    };
  }

  private async previewOffice(
    projectId: string,
    resolved: { absolutePath: string; relativePath: string; realPath: string },
    sizeBytes: number,
    mimeType: string,
    kind: "docx" | "xlsx" | "pptx",
    maxTextChars: number
  ): Promise<PreviewResult> {
    try {
      const buf = await this.fs.readFile(resolved.realPath);
      const extracted =
        kind === "docx"
          ? previewDocx(buf, maxTextChars)
          : kind === "xlsx"
            ? previewXlsx(buf, maxTextChars)
            : previewPptx(buf, maxTextChars);
      return {
        projectId,
        relativePath: resolved.relativePath,
        previewKind: kind,
        mimeType,
        sizeBytes,
        truncated: extracted.text.length >= maxTextChars,
        ok: true,
        text: extracted.text,
        html: extracted.html,
        parts: extracted.parts
      };
    } catch (error) {
      return {
        projectId,
        relativePath: resolved.relativePath,
        previewKind: kind,
        mimeType,
        sizeBytes,
        truncated: false,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: "parse_failed"
      };
    }
  }

  private previewError(projectId: string, relativePath: string, error: unknown): PreviewResult {
    if (error instanceof PathSafetyError) {
      return {
        projectId,
        relativePath: toProjectRelative(relativePath ?? ""),
        previewKind: "unknown",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
        truncated: false,
        ok: false,
        error: error.message,
        errorCode: error.code === "not_found" ? "not_found" : "outside_workspace"
      };
    }
    return {
      projectId,
      relativePath: toProjectRelative(relativePath ?? ""),
      previewKind: "unknown",
      mimeType: "application/octet-stream",
      sizeBytes: 0,
      truncated: false,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: "read_failed"
    };
  }

  // ── Catalog ────────────────────────────────────────────────────────────────

  listArtifacts(filter: ArtifactListFilter = {}): ArtifactRecord[] {
    const q = filter.q?.trim().toLowerCase();
    const tag = filter.tag?.trim().toLowerCase();
    return this.state.artifacts
      .filter((a) => {
        if (filter.projectId && a.projectId !== filter.projectId) return false;
        if (filter.runId && a.runId !== filter.runId) return false;
        if (filter.origin && a.origin !== filter.origin) return false;
        if (filter.reviewStatus && a.reviewStatus !== filter.reviewStatus) return false;
        if (tag && !a.tags.some((t) => t.toLowerCase() === tag)) return false;
        if (q) {
          const hay = `${a.title} ${a.relativePath} ${a.kind} ${a.createdBy ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((a) => structuredClone(a));
  }

  getArtifact(artifactId: string): ArtifactRecord {
    return structuredClone(this.requireArtifact(artifactId));
  }

  async registerArtifact(input: RegisterArtifactInput): Promise<ArtifactRecord> {
    const project = await this.requireProject(input.projectId);
    const resolved = resolveSafePath(project.workspacePath, input.relativePath);
    if (!resolved.relativePath) {
      throw Object.assign(new Error("Artifact path must be a file path, not the workspace root."), {
        statusCode: 400
      });
    }

    let sizeBytes = 0;
    let contentHash = "";
    let previewKind = classifyPreviewKind(resolved.relativePath);
    try {
      const st = await safeStat(project.workspacePath, resolved.relativePath);
      if (st.isDirectory) {
        throw Object.assign(new Error("Cannot register a directory as an artifact file."), { statusCode: 400 });
      }
      sizeBytes = st.size;
      const buf = await this.fs.readFile(st.absolutePath);
      contentHash = hashBuffer(buf);
      previewKind = classifyPreviewKind(resolved.relativePath);
    } catch (error) {
      if (error instanceof PathSafetyError && error.code === "not_found") {
        // Allow registering a path that will be produced; hash empty
        contentHash = hashBuffer(Buffer.alloc(0));
      } else if ((error as { statusCode?: number }).statusCode === 400) {
        throw error;
      } else if (!(error instanceof PathSafetyError)) {
        // keep going with empty hash for race conditions
        contentHash = hashBuffer(Buffer.alloc(0));
      } else {
        throw error;
      }
    }

    const now = this.iso();
    const version: ArtifactVersion = {
      id: randomUUID(),
      version: 1,
      relativePath: resolved.relativePath,
      contentHash,
      sizeBytes,
      createdAt: now,
      createdBy: input.createdBy,
      note: input.note,
      runId: input.runId
    };

    const record: ArtifactRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      relativePath: resolved.relativePath,
      kind: (input.kind ?? "file").trim() || "file",
      title: (input.title ?? basenameOf(resolved.relativePath)).trim() || resolved.relativePath,
      origin: input.origin ?? "other",
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy,
      runId: input.runId,
      todoId: input.todoId,
      sessionId: input.sessionId,
      reviewStatus: input.reviewStatus ?? "none",
      reviewSummary: input.reviewSummary,
      evidenceLinks: input.evidenceLinks ?? [],
      diffLinks: input.diffLinks ?? [],
      sourceLinks: input.sourceLinks ?? [],
      tags: normalizeTags(input.tags),
      currentVersion: 1,
      versions: [version],
      contentHash,
      sizeBytes,
      previewKind
    };

    this.state.artifacts.push(record);
    await this.persist();
    return structuredClone(record);
  }

  async updateArtifact(artifactId: string, input: UpdateArtifactInput): Promise<ArtifactRecord> {
    const artifact = this.requireArtifact(artifactId);
    if (typeof input.title === "string") artifact.title = input.title.trim() || artifact.title;
    if (typeof input.kind === "string") artifact.kind = input.kind.trim() || artifact.kind;
    if (input.reviewStatus) artifact.reviewStatus = input.reviewStatus;
    if (input.reviewSummary === null) delete artifact.reviewSummary;
    else if (typeof input.reviewSummary === "string") artifact.reviewSummary = input.reviewSummary;
    if (input.evidenceLinks) artifact.evidenceLinks = input.evidenceLinks;
    if (input.diffLinks) artifact.diffLinks = input.diffLinks;
    if (input.sourceLinks) artifact.sourceLinks = input.sourceLinks;
    if (input.tags) artifact.tags = normalizeTags(input.tags);
    if (input.createdBy === null) delete artifact.createdBy;
    else if (typeof input.createdBy === "string") artifact.createdBy = input.createdBy;
    artifact.updatedAt = this.iso();
    await this.persist();
    return structuredClone(artifact);
  }

  async addVersion(
    artifactId: string,
    input: { note?: string; createdBy?: string; runId?: string } = {}
  ): Promise<ArtifactRecord> {
    const artifact = this.requireArtifact(artifactId);
    const project = await this.requireProject(artifact.projectId);
    const st = await safeStat(project.workspacePath, artifact.relativePath);
    if (st.isDirectory) throw new Error("Artifact path is a directory.");
    const buf = await this.fs.readFile(st.absolutePath);
    const contentHash = hashBuffer(buf);
    const last = artifact.versions[artifact.versions.length - 1];
    if (last && last.contentHash === contentHash) {
      // Idempotent: no new version when content unchanged
      return structuredClone(artifact);
    }
    const version: ArtifactVersion = {
      id: randomUUID(),
      version: artifact.currentVersion + 1,
      relativePath: artifact.relativePath,
      contentHash,
      sizeBytes: st.size,
      createdAt: this.iso(),
      createdBy: input.createdBy ?? artifact.createdBy,
      note: input.note,
      runId: input.runId ?? artifact.runId
    };
    artifact.versions.push(version);
    artifact.currentVersion = version.version;
    artifact.contentHash = contentHash;
    artifact.sizeBytes = st.size;
    artifact.updatedAt = version.createdAt;
    await this.persist();
    return structuredClone(artifact);
  }

  listVersions(artifactId: string): ArtifactVersion[] {
    return structuredClone(this.requireArtifact(artifactId).versions);
  }

  /**
   * Import Run artifacts into the catalog (idempotent by projectId+path+runId).
   * Attaches diff links from Codex worktree evidence when present.
   */
  async importRunArtifacts(runId: string, projectId: string): Promise<ArtifactRecord[]> {
    if (!this.options.runs) {
      throw Object.assign(new Error("Run port is not configured for artifact import."), { statusCode: 501 });
    }
    const run = await this.options.runs.get(runId);
    const imported: ArtifactRecord[] = [];
    const lastReview = run.reviews?.[run.reviews.length - 1];
    const reviewStatus = mapReviewStatus(lastReview?.status);

    for (const item of run.artifacts) {
      const existing = this.state.artifacts.find(
        (a) => a.projectId === projectId && a.runId === runId && a.relativePath === toProjectRelative(item.path)
      );
      if (existing) {
        imported.push(structuredClone(existing));
        continue;
      }

      const diffLinks =
        item.evidence?.diff || item.evidence?.changedFiles?.length
          ? [
              {
                runId,
                path: item.path,
                kind: "worktree" as const,
                summary: item.evidence.summary ?? "worktree diff"
              }
            ]
          : [];

      const evidenceLinks =
        item.evidence?.source === "codex-worktree"
          ? [
              {
                id: item.id,
                summary: item.evidence.summary ?? "Codex worktree evidence",
                path: item.path,
                origin: "codex"
              }
            ]
          : [];

      const record = await this.registerArtifact({
        projectId,
        relativePath: item.path,
        kind: item.kind,
        title: basenameOf(item.path),
        origin: item.kind.includes("research")
          ? "research"
          : item.kind.includes("worktree") || item.kind.includes("codex")
            ? "codex"
            : "run",
        runId,
        todoId: run.todoId,
        reviewStatus,
        reviewSummary: lastReview?.summary,
        diffLinks,
        evidenceLinks,
        note: `Imported from run ${runId}`
      });
      imported.push(record);
    }
    return imported;
  }

  // ── External open / change detect / reveal / copy ──────────────────────────

  async openExternal(
    projectId: string,
    relativePath: string,
    preferred: ExternalAppKind = "auto"
  ): Promise<ExternalOpenResult> {
    const project = await this.requireProject(projectId);
    const resolved = await resolveExistingSafePath(project.workspacePath, relativePath);
    const open = this.options.openExternal ?? openWithExternalApp;
    const result = await open({
      absolutePath: resolved.realPath,
      relativePath: resolved.relativePath,
      preferred,
      detect: this.options.detectOffice
    });
    const baseline = await this.captureFingerprint(projectId, resolved.relativePath);
    this.openBaselines.set(baselineKey(projectId, resolved.relativePath), baseline);
    return { ...result, baseline };
  }

  async detectChanges(
    projectId: string,
    relativePath: string,
    previous?: FileFingerprint
  ): Promise<ChangeDetectResult> {
    const baseline =
      previous ?? this.openBaselines.get(baselineKey(projectId, toProjectRelative(relativePath)));
    const current = await this.captureFingerprint(projectId, relativePath);
    if (!baseline) {
      return {
        relativePath: current.relativePath,
        changed: false,
        current,
        reason: "No baseline fingerprint; open externally first or pass previous."
      };
    }
    const changed =
      baseline.contentHash !== current.contentHash ||
      baseline.sizeBytes !== current.sizeBytes ||
      baseline.modifiedAt !== current.modifiedAt;
    return {
      relativePath: current.relativePath,
      changed,
      previous: baseline,
      current,
      reason: changed ? "File content or mtime differs from baseline." : "Unchanged."
    };
  }

  async reveal(projectId: string, relativePath: string): Promise<RevealResult> {
    const project = await this.requireProject(projectId);
    const resolved = await resolveExistingSafePath(project.workspacePath, relativePath);
    const reveal = this.options.reveal ?? revealInFileManager;
    const result = await reveal({
      absolutePath: resolved.realPath,
      relativePath: resolved.relativePath
    });
    return {
      ok: result.ok,
      relativePath: resolved.relativePath,
      absolutePath: resolved.realPath,
      message: result.message,
      stub: result.stub
    };
  }

  async copyPath(projectId: string, relativePath: string): Promise<CopyPathResult> {
    const project = await this.requireProject(projectId);
    const resolved = await resolveExistingSafePath(project.workspacePath, relativePath);
    return {
      relativePath: resolved.relativePath,
      absolutePath: resolved.realPath,
      path: resolved.realPath
    };
  }

  async officeStatus(): Promise<OfficeAvailability> {
    const detect = this.options.detectOffice ?? detectOfficeAvailability;
    return detect();
  }

  // ── Export / package ───────────────────────────────────────────────────────

  async exportFiles(request: ExportRequest): Promise<ExportResult> {
    const project = await this.requireProject(request.projectId);
    const mode = request.mode ?? "copy";
    const destRoot = request.destinationDir;
    await this.fs.mkdir(destRoot, { recursive: true });

    const files: ExportResult["files"] = [];
    for (const rel of request.paths) {
      const resolved = await resolveExistingSafePath(project.workspacePath, rel);
      const st = await this.fs.stat(resolved.realPath);
      if (!st.isFile()) continue;
      const destination = join(destRoot, resolved.relativePath.replace(/\//g, "_"));
      if (mode === "copy") {
        await this.fs.copyFile(resolved.realPath, destination);
      }
      files.push({
        relativePath: resolved.relativePath,
        destination,
        bytes: st.size
      });
    }

    const manifest = {
      exportedAt: this.iso(),
      projectId: request.projectId,
      files: files.map((f) => ({ relativePath: f.relativePath, bytes: f.bytes })),
      artifacts: (request.artifactIds ?? [])
        .map((id) => this.state.artifacts.find((a) => a.id === id))
        .filter(Boolean)
    };
    const manifestPath = join(destRoot, "artifact-export-manifest.json");
    await this.fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    return {
      ok: true,
      mode,
      destinationDir: destRoot,
      files,
      manifestPath,
      message: `Exported ${files.length} file(s) with manifest.`
    };
  }

  async packageFiles(request: PackageRequest): Promise<PackageResult> {
    const project = await this.requireProject(request.projectId);
    if (request.paths.length > MAX_PACKAGE_ENTRIES) {
      throw Object.assign(new Error(`Too many package entries (max ${MAX_PACKAGE_ENTRIES}).`), {
        statusCode: 400
      });
    }

    const zipEntries: Array<{ name: string; data: Buffer }> = [];
    let totalBytes = 0;

    for (const rel of request.paths) {
      const resolved = await resolveExistingSafePath(project.workspacePath, rel);
      const st = await this.fs.stat(resolved.realPath);
      if (!st.isFile()) continue;
      totalBytes += st.size;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw Object.assign(new Error("Package exceeds maximum size budget."), { statusCode: 400 });
      }
      const data = await this.fs.readFile(resolved.realPath);
      zipEntries.push({ name: resolved.relativePath, data });
    }

    if (request.includeManifest !== false) {
      const manifest = {
        packagedAt: this.iso(),
        projectId: request.projectId,
        entries: zipEntries.map((e) => e.name),
        artifacts: (request.artifactIds ?? [])
          .map((id) => this.state.artifacts.find((a) => a.id === id))
          .filter(Boolean)
      };
      zipEntries.push({
        name: "artifact-package-manifest.json",
        data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8")
      });
    }

    const zip = buildStoredZip(zipEntries);
    const out = resolveSafeOutputPath(request.outputPath);
    await this.fs.mkdir(dirname(out), { recursive: true });
    await this.fs.writeFile(out, zip);

    return {
      ok: true,
      outputPath: out,
      entryCount: zipEntries.length,
      bytesWritten: zip.length,
      message: `Packaged ${zipEntries.length} entries into zip.`
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async captureFingerprint(projectId: string, relativePath: string): Promise<FileFingerprint> {
    const project = await this.requireProject(projectId);
    const st = await safeStat(project.workspacePath, relativePath);
    if (st.isDirectory) {
      throw Object.assign(new Error("Cannot fingerprint a directory."), { statusCode: 400 });
    }
    const contentHash =
      st.size <= this.inlineBinaryBytes
        ? hashBuffer(await this.fs.readFile(st.absolutePath))
        : await this.hashFilePartial(st.absolutePath, st.size);
    return {
      relativePath: st.relativePath,
      absolutePath: st.absolutePath,
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      contentHash,
      capturedAt: this.iso()
    };
  }

  private async hashFilePartial(absolutePath: string, size: number): Promise<string> {
    // Hash size + head + tail for large files (change detection without full read).
    const buf = await this.fs.readFile(absolutePath);
    const head = buf.subarray(0, Math.min(64 * 1024, buf.length));
    const tail = buf.length > 64 * 1024 ? buf.subarray(buf.length - 64 * 1024) : Buffer.alloc(0);
    return createHash("sha256")
      .update(String(size))
      .update(head)
      .update(tail)
      .digest("hex");
  }

  private async requireProject(projectId: string) {
    try {
      return await this.options.projects.get(projectId);
    } catch (error) {
      throw Object.assign(
        new Error(error instanceof Error ? error.message : `Project ${projectId} was not found.`),
        { statusCode: 404 }
      );
    }
  }

  private requireArtifact(artifactId: string): ArtifactRecord {
    const artifact = this.state.artifacts.find((a) => a.id === artifactId);
    if (!artifact) {
      throw Object.assign(new Error(`Artifact ${artifactId} was not found.`), { statusCode: 404 });
    }
    return artifact;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private async persist(): Promise<void> {
    if (!this.catalogPath) return;
    await this.fs.mkdir(dirname(this.catalogPath), { recursive: true });
    const tmp = `${this.catalogPath}.${process.pid}.tmp`;
    await this.fs.writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await this.fs.rename(tmp, this.catalogPath);
  }
}

function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function baselineKey(projectId: string, relativePath: string): string {
  return `${projectId}::${toProjectRelative(relativePath)}`;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const t = tag.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function mapReviewStatus(status: string | undefined): ReviewStatus {
  if (!status) return "none";
  const s = status.toLowerCase();
  if (s.includes("pass") || s === "approved") return "passed";
  if (s.includes("fail") || s === "rejected") return "failed";
  if (s.includes("change") || s.includes("remediat")) return "needs_changes";
  if (s.includes("accept")) return "accepted";
  if (s.includes("pending") || s.includes("review")) return "pending";
  return "none";
}

/** Package output path is absolute host path (export destination), not workspace-relative. */
function resolveSafeOutputPath(outputPath: string): string {
  const trimmed = outputPath.trim();
  if (!trimmed) throw new Error("outputPath is required.");
  if (trimmed.includes("\0")) throw new Error("Invalid outputPath.");
  return trimmed;
}

export type { ArtifactOrigin, ReviewStatus };
