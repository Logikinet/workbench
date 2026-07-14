/**
 * Document / paper writing service (Task 33).
 *
 * Owns sessions under apps/service/src/documents only.
 * ModelProvider is injected (FakeModelProvider in tests).
 * ResearchEvidence types imported from research/.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelProvider } from "../model/types.js";
import type { ResearchEvidence } from "../research/researchTypes.js";
import {
  buildCitationsFromEvidence,
  checkCitations,
  formatBibliography
} from "./citations.js";
import { checkConsistency, compareChapterVersions, consistencyOk } from "./consistency.js";
import type {
  BibliographyStyle,
  Chapter,
  CitationCheckResult,
  ConsistencyIssue,
  DocumentMaterial,
  DocumentSession,
  DocumentStateFile,
  ExportBundleResult,
  ExportedArtifact,
  VersionDiff,
  WriteChapterResult
} from "./documentTypes.js";
import {
  detectExternalChanges,
  watchFromExport,
  type FileStatPort
} from "./externalEdit.js";
import {
  buildDocumentDocx,
  buildDocumentMarkdown,
  buildDocumentPdf,
  contentHash,
  defaultExportPaths,
  DOCUMENT_DOCX_KIND,
  DOCUMENT_MD_KIND,
  DOCUMENT_PDF_KIND
} from "./exportFormats.js";
import {
  importDocxFile,
  importDocxFromBytes,
  importMarkdownFile,
  importMarkdownText,
  importPdfMaterial,
  importPdfMaterialFromBytes,
  materialFromEvidence,
  materialFromProjectFact,
  MaterialImportError
} from "./materialImport.js";
import {
  approveOutline,
  generateOutline,
  OutlineError,
  rejectOutline
} from "./outline.js";
import { writeChapter, WritingError } from "./writing.js";

export interface DocumentServiceOptions {
  statePath?: string;
  model?: ModelProvider;
  now?: () => Date;
  /** Directory for formal export artifacts (source of truth). */
  exportDir?: string;
  filePort?: FileStatPort;
  connectionId?: string;
  modelId?: string;
}

export interface CreateDocumentSessionInput {
  title: string;
  goal: string;
  runId?: string;
  projectId?: string;
  researchSessionId?: string;
  bibliographyStyle?: BibliographyStyle;
  projectFacts?: string[];
}

export interface ArtifactWriter {
  writeFile(path: string, content: string | Buffer): Promise<void>;
}

function emptyState(): DocumentStateFile {
  return { schemaVersion: 1, sessions: [] };
}

export class DocumentService {
  private state: DocumentStateFile = emptyState();
  private readonly now: () => Date;

  private constructor(
    private readonly statePath: string | undefined,
    state: DocumentStateFile,
    private readonly model: ModelProvider | undefined,
    now: (() => Date) | undefined,
    private readonly exportDir: string | undefined,
    private readonly filePort: FileStatPort | undefined,
    private readonly connectionId: string | undefined,
    private readonly modelId: string | undefined
  ) {
    this.state = state;
    this.now = now ?? (() => new Date());
  }

  static async open(options: DocumentServiceOptions = {}): Promise<DocumentService> {
    let state = emptyState();
    if (options.statePath) {
      try {
        const decoded = JSON.parse(await readFile(options.statePath, "utf8")) as Partial<DocumentStateFile>;
        if (decoded.schemaVersion !== 1) {
          throw new Error("Document state is not compatible with this service version.");
        }
        state = {
          schemaVersion: 1,
          sessions: Array.isArray(decoded.sessions) ? (decoded.sessions as DocumentSession[]) : []
        };
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
          throw error;
        }
      }
    }
    return new DocumentService(
      options.statePath,
      state,
      options.model,
      options.now,
      options.exportDir,
      options.filePort,
      options.connectionId,
      options.modelId
    );
  }

  async listSessions(): Promise<DocumentSession[]> {
    return this.state.sessions.map((s) => structuredClone(s));
  }

  async getSession(sessionId: string): Promise<DocumentSession> {
    return structuredClone(this.require(sessionId));
  }

  async createSession(input: CreateDocumentSessionInput): Promise<DocumentSession> {
    const title = input.title?.trim();
    const goal = input.goal?.trim();
    if (!title) throw new Error("title is required.");
    if (!goal) throw new Error("goal is required.");
    const ts = this.now().toISOString();
    const facts = (input.projectFacts ?? []).map((f) => f.trim()).filter(Boolean);

    const session: DocumentSession = {
      id: randomUUID(),
      runId: input.runId,
      projectId: input.projectId,
      researchSessionId: input.researchSessionId,
      title,
      goal,
      status: "collecting_materials",
      bibliographyStyle: input.bibliographyStyle ?? "apa",
      materials: facts.map((f) => materialFromProjectFact(f, { now: this.now })),
      outline: undefined,
      chapters: [],
      citations: [],
      exports: [],
      externalWatches: [],
      consistencyIssues: [],
      evidence: [],
      projectFacts: facts,
      artifacts: [],
      createdAt: ts,
      updatedAt: ts
    };

    this.state.sessions.push(session);
    await this.persist();
    return structuredClone(session);
  }

  async addProjectFacts(sessionId: string, facts: string[]): Promise<DocumentSession> {
    const session = this.require(sessionId);
    for (const f of facts) {
      const t = f.trim();
      if (!t) continue;
      if (!session.projectFacts.includes(t)) session.projectFacts.push(t);
      session.materials.push(materialFromProjectFact(t, { now: this.now }));
    }
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async importMarkdown(
    sessionId: string,
    input: { text: string; title?: string; kind?: "template" | "user_material"; sourcePath?: string }
  ): Promise<{ session: DocumentSession; material: DocumentMaterial }> {
    const session = this.require(sessionId);
    const material = importMarkdownText({
      text: input.text,
      title: input.title,
      kind: input.kind,
      sourcePath: input.sourcePath,
      now: this.now
    });
    session.materials.push(material);
    session.status = "collecting_materials";
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return { session: structuredClone(session), material: structuredClone(material) };
  }

  async importMarkdownPath(
    sessionId: string,
    path: string,
    options: { kind?: "template" | "user_material"; title?: string } = {}
  ): Promise<{ session: DocumentSession; material: DocumentMaterial }> {
    const session = this.require(sessionId);
    const material = await importMarkdownFile(path, { ...options, now: this.now });
    session.materials.push(material);
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return { session: structuredClone(session), material: structuredClone(material) };
  }

  async importDocxBytes(
    sessionId: string,
    bytes: Buffer,
    options: { title?: string; kind?: "template" | "user_material"; sourcePath?: string } = {}
  ): Promise<{ session: DocumentSession; material: DocumentMaterial }> {
    const session = this.require(sessionId);
    const material = importDocxFromBytes({
      bytes,
      title: options.title,
      kind: options.kind,
      sourcePath: options.sourcePath,
      now: this.now
    });
    session.materials.push(material);
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return { session: structuredClone(session), material: structuredClone(material) };
  }

  async importDocxPath(
    sessionId: string,
    path: string,
    options: { kind?: "template" | "user_material"; title?: string } = {}
  ): Promise<{ session: DocumentSession; material: DocumentMaterial }> {
    const session = this.require(sessionId);
    const material = await importDocxFile(path, { ...options, now: this.now });
    session.materials.push(material);
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return { session: structuredClone(session), material: structuredClone(material) };
  }

  async importPdfPath(
    sessionId: string,
    path: string,
    options: {
      kind?: "template" | "user_material";
      title?: string;
      pageTexts?: Array<{ page: number; text: string }>;
    } = {}
  ): Promise<{ session: DocumentSession; material: DocumentMaterial }> {
    const session = this.require(sessionId);
    const material = await importPdfMaterial(path, { ...options, now: this.now });
    session.materials.push(material);
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return { session: structuredClone(session), material: structuredClone(material) };
  }

  async importPdfBytes(
    sessionId: string,
    bytes: Buffer,
    options: {
      title?: string;
      kind?: "template" | "user_material";
      sourcePath?: string;
      pageTexts?: Array<{ page: number; text: string }>;
    } = {}
  ): Promise<{ session: DocumentSession; material: DocumentMaterial }> {
    const session = this.require(sessionId);
    const material = importPdfMaterialFromBytes({
      bytes,
      title: options.title,
      kind: options.kind,
      sourcePath: options.sourcePath,
      pageTexts: options.pageTexts,
      now: this.now
    });
    session.materials.push(material);
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return { session: structuredClone(session), material: structuredClone(material) };
  }

  /** Import ResearchEvidence list (from Task 32) as bound evidence + materials. */
  async importEvidence(
    sessionId: string,
    evidenceList: ResearchEvidence[]
  ): Promise<DocumentSession> {
    const session = this.require(sessionId);
    for (const ev of evidenceList) {
      if (session.evidence.some((e) => e.id === ev.id)) continue;
      session.evidence.push(structuredClone(ev));
      session.materials.push(materialFromEvidence(ev, { now: this.now }));
    }
    session.citations = buildCitationsFromEvidence(session.evidence, session.materials, this.now);
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  /** Secondmate outline — awaiting user approval before writing. */
  async generateOutline(sessionId: string): Promise<DocumentSession> {
    if (!this.model) throw new OutlineError("Model provider is not configured.", "model_failed");
    const session = this.require(sessionId);
    session.status = "outlining";
    const outline = await generateOutline({
      title: session.title,
      goal: session.goal,
      materials: session.materials,
      evidence: session.evidence,
      projectFacts: session.projectFacts,
      model: this.model,
      connectionId: this.connectionId,
      modelId: this.modelId,
      now: this.now
    });
    session.outline = outline;
    session.status = "awaiting_outline_approval";
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async approveOutline(sessionId: string): Promise<DocumentSession> {
    const session = this.require(sessionId);
    if (!session.outline) throw new OutlineError("No outline present.", "not_awaiting");
    session.outline = approveOutline(session.outline, this.now);
    session.status = "writing";
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async rejectOutline(sessionId: string, reason: string): Promise<DocumentSession> {
    const session = this.require(sessionId);
    if (!session.outline) throw new OutlineError("No outline present.", "not_awaiting");
    session.outline = rejectOutline(session.outline, reason);
    session.status = "outlining";
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async writeChapter(
    sessionId: string,
    sectionId: string,
    options: { revisionNote?: string; enforceGrounding?: boolean } = {}
  ): Promise<WriteChapterResult> {
    if (!this.model) throw new WritingError("Model provider is not configured.", "model_failed");
    const session = this.require(sessionId);
    if (!session.outline) throw new WritingError("No outline present.", "outline_not_approved");

    const existing = session.chapters.find((c) => c.sectionId === sectionId);
    const outcome = await writeChapter({
      outline: session.outline,
      sectionId,
      materials: session.materials,
      evidence: session.evidence,
      projectFacts: session.projectFacts,
      existing,
      revisionNote: options.revisionNote,
      model: this.model,
      connectionId: this.connectionId,
      modelId: this.modelId,
      now: this.now,
      enforceGrounding: options.enforceGrounding
    });

    if (!outcome.blocked) {
      const idx = session.chapters.findIndex((c) => c.id === outcome.chapter.id || c.sectionId === sectionId);
      if (idx >= 0) session.chapters[idx] = outcome.chapter;
      else session.chapters.push(outcome.chapter);

      const sec = session.outline.sections.find((s) => s.id === sectionId);
      if (sec) {
        sec.status = outcome.chapter.currentVersion > 1 ? "revised" : "written";
      }
      session.citations = buildCitationsFromEvidence(session.evidence, session.materials, this.now);
      session.status = "writing";
    }

    session.updatedAt = this.now().toISOString();
    await this.persist();
    return {
      session: structuredClone(session),
      chapter: structuredClone(outcome.chapter),
      blocked: outcome.blocked,
      blockReasons: outcome.blockReasons
    };
  }

  compareVersions(sessionId: string, chapterId: string, from: number, to: number): VersionDiff {
    const session = this.require(sessionId);
    const chapter = session.chapters.find((c) => c.id === chapterId);
    if (!chapter) throw new WritingError(`Chapter “${chapterId}” not found.`, "chapter_not_found");
    return compareChapterVersions(chapter, from, to);
  }

  async runConsistencyCheck(sessionId: string): Promise<{
    session: DocumentSession;
    issues: ConsistencyIssue[];
    ok: boolean;
  }> {
    const session = this.require(sessionId);
    const issues = checkConsistency(session.chapters);
    session.consistencyIssues = issues;
    session.status = "reviewing";
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return {
      session: structuredClone(session),
      issues: structuredClone(issues),
      ok: consistencyOk(issues)
    };
  }

  async checkCitations(sessionId: string): Promise<CitationCheckResult> {
    const session = this.require(sessionId);
    if (session.citations.length === 0) {
      session.citations = buildCitationsFromEvidence(session.evidence, session.materials, this.now);
    }
    return checkCitations(session.chapters, session.citations, session.bibliographyStyle);
  }

  async setBibliographyStyle(sessionId: string, style: BibliographyStyle): Promise<DocumentSession> {
    const session = this.require(sessionId);
    session.bibliographyStyle = style;
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  /**
   * Export Markdown + DOCX + PDF. Local files are formal source of truth.
   */
  async exportAll(sessionId: string, options: { dir?: string } = {}): Promise<ExportBundleResult> {
    const session = this.require(sessionId);
    const markdown = buildDocumentMarkdown(session);
    const docx = buildDocumentDocx(session);
    const pdf = buildDocumentPdf(session);
    const paths = defaultExportPaths(session);
    const dir = options.dir ?? this.exportDir;
    const ts = this.now().toISOString();

    const artifacts: ExportedArtifact[] = [
      {
        path: dir ? join(dir, paths.markdown) : paths.markdown,
        format: "markdown",
        contentHash: contentHash(markdown),
        exportedAt: ts,
        sizeBytes: Buffer.byteLength(markdown, "utf8"),
        kind: DOCUMENT_MD_KIND
      },
      {
        path: dir ? join(dir, paths.docx) : paths.docx,
        format: "docx",
        contentHash: contentHash(docx),
        exportedAt: ts,
        sizeBytes: docx.length,
        kind: DOCUMENT_DOCX_KIND
      },
      {
        path: dir ? join(dir, paths.pdf) : paths.pdf,
        format: "pdf",
        contentHash: contentHash(pdf),
        exportedAt: ts,
        sizeBytes: pdf.length,
        kind: DOCUMENT_PDF_KIND
      }
    ];

    if (dir) {
      await mkdir(dir, { recursive: true });
      await writeFile(artifacts[0]!.path, markdown, "utf8");
      await writeFile(artifacts[1]!.path, docx);
      await writeFile(artifacts[2]!.path, pdf);
    }

    session.exports = artifacts;
    session.externalWatches = artifacts.map((a) => watchFromExport(a));
    session.artifacts = artifacts.map((a) => ({
      path: a.path,
      kind: a.kind,
      summary: `Exported ${a.format} (${a.sizeBytes} bytes)`
    }));
    session.status = "exported";
    session.updatedAt = ts;
    await this.persist();

    return {
      session: structuredClone(session),
      markdown,
      docx,
      pdf,
      artifacts: structuredClone(artifacts)
    };
  }

  /** Detect Office/WPS external saves; trigger re-review when content changes. */
  async detectExternalEdits(sessionId: string): Promise<{
    session: DocumentSession;
    anyChanged: boolean;
    rereviewRequired: boolean;
  }> {
    const session = this.require(sessionId);
    const result = await detectExternalChanges(session.externalWatches, {
      port: this.filePort,
      now: this.now
    });
    session.externalWatches = result.watches;
    if (result.rereviewRequired) {
      session.status = "needs_rereview";
    }
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return {
      session: structuredClone(session),
      anyChanged: result.anyChanged,
      rereviewRequired: result.rereviewRequired
    };
  }

  async complete(sessionId: string): Promise<DocumentSession> {
    const session = this.require(sessionId);
    session.status = "completed";
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  /** Bibliography markdown for current style. */
  bibliographyMarkdown(sessionId: string): string {
    const session = this.require(sessionId);
    return formatBibliography(session.citations, session.bibliographyStyle);
  }

  private require(sessionId: string): DocumentSession {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Document session “${sessionId}” not found.`);
    return session;
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    try {
      await rename(tmp, this.statePath);
    } catch {
      await writeFile(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      try {
        await access(tmp, constants.F_OK);
      } catch {
        /* ignore */
      }
    }
  }
}

export { MaterialImportError, OutlineError, WritingError };
