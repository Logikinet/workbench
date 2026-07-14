/**
 * Evidence-first research service (Task 32).
 *
 * Owns research sessions under apps/service/src/research only.
 * Web tools are injected (fakes in tests). PDF import uses pure metadata helpers.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createClaim,
  createEvidence,
  evidenceFromWebPage,
  markEvidence,
  type EvidenceBindingError
} from "./evidence.js";
import {
  importPdf,
  importPdfFromBytes,
  type PdfImportOptions,
  type PdfPageExtractor
} from "./pdfImport.js";
import {
  produceResearchArtifacts,
  writeResearchArtifacts,
  type ArtifactWriter
} from "./researchArtifacts.js";
import {
  checkResearchEvidence,
  researchReviewMayPass,
  toReviewerFindingRows
} from "./reviewerEvidenceHooks.js";
import type {
  AggregateResult,
  ClaimKind,
  EvidenceQualityFlag,
  ProduceArtifactsResult,
  ResearchClaim,
  ResearchEvidence,
  ResearchSession,
  ResearchStateFile,
  ReviewerEvidenceCheckResult,
  WebSearchHit
} from "./researchTypes.js";
import {
  aggregateSession,
  completeStep,
  createStepsFromQuestions,
  splitResearchQuestions,
  startStep
} from "./researchWorkflow.js";
import type { WebFetchPort, WebSearchPort } from "./webTools.js";
import { WebToolError } from "./webTools.js";

export interface ResearchServiceOptions {
  statePath?: string;
  search?: WebSearchPort;
  fetch?: WebFetchPort;
  pdfExtractor?: PdfPageExtractor;
  now?: () => Date;
  /** Optional workspace writer for research.md artifacts. */
  artifactWriter?: ArtifactWriter;
}

export interface CreateResearchSessionInput {
  title: string;
  goal: string;
  runId?: string;
  projectId?: string;
  /** Default true. Set false for creative tasks. */
  forceEvidenceMode?: boolean;
  /** Optional pre-split questions; otherwise derived from goal. */
  subQuestions?: string[];
  parallelSteps?: boolean;
}

export interface AddClaimInput {
  text: string;
  kind: ClaimKind;
  evidenceIds?: string[];
  notes?: string;
  stepId?: string;
}

function emptyState(): ResearchStateFile {
  return { schemaVersion: 1, sessions: [] };
}

export class ResearchService {
  private state: ResearchStateFile = emptyState();
  private readonly now: () => Date;

  private constructor(
    private readonly statePath: string | undefined,
    state: ResearchStateFile,
    private readonly searchPort: WebSearchPort | undefined,
    private readonly fetchPort: WebFetchPort | undefined,
    private readonly pdfExtractor: PdfPageExtractor | undefined,
    now: (() => Date) | undefined,
    private readonly artifactWriter: ArtifactWriter | undefined
  ) {
    this.state = state;
    this.now = now ?? (() => new Date());
  }

  static async open(options: ResearchServiceOptions = {}): Promise<ResearchService> {
    let state = emptyState();
    if (options.statePath) {
      try {
        const decoded = JSON.parse(await readFile(options.statePath, "utf8")) as Partial<ResearchStateFile>;
        if (decoded.schemaVersion !== 1) {
          throw new Error("Research state is not compatible with this service version.");
        }
        state = {
          schemaVersion: 1,
          sessions: Array.isArray(decoded.sessions) ? (decoded.sessions as ResearchSession[]) : []
        };
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
          throw error;
        }
      }
    }
    return new ResearchService(
      options.statePath,
      state,
      options.search,
      options.fetch,
      options.pdfExtractor,
      options.now,
      options.artifactWriter
    );
  }

  async listSessions(): Promise<ResearchSession[]> {
    return this.state.sessions.map((s) => structuredClone(s));
  }

  async getSession(sessionId: string): Promise<ResearchSession> {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Research session “${sessionId}” not found.`);
    return structuredClone(session);
  }

  async createSession(input: CreateResearchSessionInput): Promise<ResearchSession> {
    const title = input.title?.trim();
    const goal = input.goal?.trim();
    if (!title) throw new Error("title is required.");
    if (!goal) throw new Error("goal is required.");

    const subQuestions =
      input.subQuestions?.map((q) => q.trim()).filter(Boolean)
      ?? splitResearchQuestions(goal);
    const steps = createStepsFromQuestions(subQuestions, {
      parallel: input.parallelSteps !== false,
      now: this.now
    });
    const ts = this.now().toISOString();

    const session: ResearchSession = {
      id: randomUUID(),
      runId: input.runId,
      projectId: input.projectId,
      title,
      goal,
      forceEvidenceMode: input.forceEvidenceMode !== false,
      status: "planning",
      subQuestions,
      steps,
      evidence: [],
      claims: [],
      sources: [],
      conflicts: [],
      artifacts: [],
      aggregated: false,
      createdAt: ts,
      updatedAt: ts
    };

    this.state.sessions.push(session);
    await this.persist();
    return structuredClone(session);
  }

  /** Begin gathering: mark session gathering and optionally start all parallel steps. */
  async beginGathering(sessionId: string): Promise<ResearchSession> {
    const session = this.require(sessionId);
    session.status = "gathering";
    session.steps = session.steps.map((step) =>
      step.status === "pending" ? startStep(step, this.now) : step
    );
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async searchWeb(
    sessionId: string,
    query: string,
    options?: { limit?: number; stepId?: string }
  ): Promise<{ session: ResearchSession; hits: WebSearchHit[]; evidenceIds: string[] }> {
    if (!this.searchPort) throw new Error("Web search port is not configured.");
    const session = this.require(sessionId);
    const hits = await this.searchPort.search(query, { limit: options?.limit });
    const evidenceIds: string[] = [];

    for (const hit of hits) {
      const ev = createEvidence({
        title: hit.title,
        source: hit.url,
        author: hit.author,
        publishedAt: hit.publishedAt,
        excerpt: hit.snippet,
        origin: "web",
        location: { anchor: "search-snippet" },
        now: this.now
      });
      session.evidence.push(ev);
      evidenceIds.push(ev.id);
    }

    this.attachToStep(session, options?.stepId, evidenceIds, []);
    session.status = "gathering";
    session.aggregated = false;
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return { session: structuredClone(session), hits, evidenceIds };
  }

  async fetchPage(
    sessionId: string,
    url: string,
    options?: { stepId?: string; excerpt?: string }
  ): Promise<{ session: ResearchSession; evidence: ResearchEvidence }> {
    if (!this.fetchPort) throw new Error("Web fetch port is not configured.");
    const session = this.require(sessionId);

    try {
      const page = await this.fetchPort.fetch(url);
      const evidence = evidenceFromWebPage(page, {
        excerpt: options?.excerpt,
        now: this.now
      });
      session.evidence.push(evidence);
      this.attachToStep(session, options?.stepId, [evidence.id], []);
      session.status = "gathering";
      session.aggregated = false;
      session.updatedAt = this.now().toISOString();
      await this.persist();
      return { session: structuredClone(session), evidence: structuredClone(evidence) };
    } catch (error: unknown) {
      if (error instanceof WebToolError && (error.code === "unreachable" || error.code === "not_found")) {
        const evidence = createEvidence({
          title: `Unreachable: ${url}`,
          source: url,
          excerpt: error.message,
          origin: "web",
          qualityFlags: ["unreachable", "invalid"],
          status: "flagged",
          now: this.now
        });
        session.evidence.push(evidence);
        session.aggregated = false;
        session.updatedAt = this.now().toISOString();
        await this.persist();
        return { session: structuredClone(session), evidence: structuredClone(evidence) };
      }
      throw error;
    }
  }

  async importPdfFile(
    sessionId: string,
    path: string,
    options?: { stepId?: string; excerptPage?: number }
  ): Promise<{ session: ResearchSession; evidence: ResearchEvidence[] }> {
    const session = this.require(sessionId);
    const result = await importPdf(path, {
      extractor: this.pdfExtractor,
      now: this.now
    });
    return this.ingestPdfResult(session, result, options);
  }

  async importPdfBytes(
    sessionId: string,
    pathLabel: string,
    bytes: Buffer,
    options?: { stepId?: string; excerptPage?: number }
  ): Promise<{ session: ResearchSession; evidence: ResearchEvidence[] }> {
    const session = this.require(sessionId);
    const result = await importPdfFromBytes(pathLabel, bytes, {
      extractor: this.pdfExtractor,
      now: this.now
    } satisfies PdfImportOptions);
    return this.ingestPdfResult(session, result, options);
  }

  async addUserMaterial(
    sessionId: string,
    input: { title: string; text: string; source?: string; stepId?: string }
  ): Promise<{ session: ResearchSession; evidence: ResearchEvidence; claim: ResearchClaim }> {
    const session = this.require(sessionId);
    const evidence = createEvidence({
      title: input.title,
      source: input.source ?? `user://${sessionId}/${randomUUID()}`,
      excerpt: input.text,
      body: input.text,
      origin: "user_material",
      now: this.now
    });
    const claim = createClaim({
      text: input.text.slice(0, 500),
      kind: "user_material",
      evidenceIds: [evidence.id],
      evidencePool: [evidence],
      forceEvidenceMode: false,
      now: this.now
    });
    session.evidence.push(evidence);
    session.claims.push(claim);
    this.attachToStep(session, input.stepId, [evidence.id], [claim.id]);
    session.aggregated = false;
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return {
      session: structuredClone(session),
      evidence: structuredClone(evidence),
      claim: structuredClone(claim)
    };
  }

  async addClaim(sessionId: string, input: AddClaimInput): Promise<{ session: ResearchSession; claim: ResearchClaim }> {
    const session = this.require(sessionId);
    try {
      const claim = createClaim({
        text: input.text,
        kind: input.kind,
        evidenceIds: input.evidenceIds,
        evidencePool: session.evidence,
        forceEvidenceMode: session.forceEvidenceMode,
        notes: input.notes,
        now: this.now
      });
      session.claims.push(claim);
      this.attachToStep(session, input.stepId, [], [claim.id]);
      session.aggregated = false;
      session.updatedAt = this.now().toISOString();
      await this.persist();
      return { session: structuredClone(session), claim: structuredClone(claim) };
    } catch (error: unknown) {
      if (error && typeof error === "object" && (error as EvidenceBindingError).name === "EvidenceBindingError") {
        throw error;
      }
      throw error;
    }
  }

  async flagEvidence(
    sessionId: string,
    evidenceId: string,
    flags: EvidenceQualityFlag[],
    status?: ResearchEvidence["status"]
  ): Promise<ResearchSession> {
    const session = this.require(sessionId);
    const idx = session.evidence.findIndex((e) => e.id === evidenceId);
    if (idx < 0) throw new Error(`Evidence “${evidenceId}” not found.`);
    session.evidence[idx] = markEvidence(session.evidence[idx]!, flags, status);
    session.aggregated = false;
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async completeResearchStep(
    sessionId: string,
    stepId: string,
    input: { evidenceIds?: string[]; claimIds?: string[]; error?: string } = {}
  ): Promise<ResearchSession> {
    const session = this.require(sessionId);
    const idx = session.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) throw new Error(`Research step “${stepId}” not found.`);
    session.steps[idx] = completeStep(session.steps[idx]!, input, this.now);
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  /**
   * Dedup sources + organize conflicts. Required before research.md.
   */
  async aggregate(sessionId: string): Promise<AggregateResult> {
    const session = this.require(sessionId);
    session.status = "aggregating";
    const result = aggregateSession(session);
    const idx = this.state.sessions.findIndex((s) => s.id === sessionId);
    this.state.sessions[idx] = result.session;
    await this.persist();
    return {
      ...result,
      session: structuredClone(result.session)
    };
  }

  async produceArtifacts(sessionId: string): Promise<ProduceArtifactsResult> {
    const session = this.require(sessionId);
    const produced = produceResearchArtifacts(session);
    const idx = this.state.sessions.findIndex((s) => s.id === sessionId);
    this.state.sessions[idx] = produced.session;

    if (this.artifactWriter) {
      await writeResearchArtifacts(produced, this.artifactWriter);
    }

    await this.persist();
    return {
      ...produced,
      session: structuredClone(produced.session)
    };
  }

  /** Reviewer evidence gate. */
  async checkEvidence(sessionId: string): Promise<ReviewerEvidenceCheckResult> {
    const session = this.require(sessionId);
    return checkResearchEvidence(session);
  }

  async finalizeIfEvidenceOk(sessionId: string): Promise<{
    session: ResearchSession;
    review: ReviewerEvidenceCheckResult;
    passed: boolean;
  }> {
    const review = await this.checkEvidence(sessionId);
    const passed = researchReviewMayPass(review);
    const session = this.require(sessionId);
    if (passed) {
      session.status = "completed";
      session.updatedAt = this.now().toISOString();
      await this.persist();
    }
    return { session: structuredClone(session), review, passed };
  }

  /** Export Reviewer-compatible finding rows for Independent Reviewer merge. */
  async reviewerFindingRows(sessionId: string) {
    const review = await this.checkEvidence(sessionId);
    return toReviewerFindingRows(review);
  }

  private async ingestPdfResult(
    session: ResearchSession,
    result: Awaited<ReturnType<typeof importPdf>>,
    options?: { stepId?: string; excerptPage?: number }
  ): Promise<{ session: ResearchSession; evidence: ResearchEvidence[] }> {
    const meta = result.metadata;
    const created: ResearchEvidence[] = [];

    if (result.pages.length === 0) {
      const ev = createEvidence({
        title: meta.title || result.path,
        source: result.path,
        author: meta.author,
        publishedAt: meta.creationDate ?? meta.modDate,
        excerpt: meta.subject || meta.title || `PDF imported: ${result.path}`,
        origin: "pdf",
        location: meta.pageCount ? { page: 1 } : undefined,
        metadata: { ...meta, importedAt: result.importedAt },
        now: this.now
      });
      created.push(ev);
    } else {
      const pageFilter = options?.excerptPage;
      const pages = pageFilter
        ? result.pages.filter((p) => p.page === pageFilter)
        : result.pages;
      for (const page of pages) {
        const ev = createEvidence({
          title: meta.title || result.path,
          source: result.path,
          author: meta.author,
          publishedAt: meta.creationDate ?? meta.modDate,
          excerpt: page.text,
          body: page.text,
          origin: "pdf",
          location: { page: page.page },
          metadata: { ...meta, importedAt: result.importedAt },
          now: this.now
        });
        created.push(ev);
      }
    }

    for (const ev of created) session.evidence.push(ev);
    this.attachToStep(
      session,
      options?.stepId,
      created.map((e) => e.id),
      []
    );
    session.status = "gathering";
    session.aggregated = false;
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return { session: structuredClone(session), evidence: structuredClone(created) };
  }

  private attachToStep(
    session: ResearchSession,
    stepId: string | undefined,
    evidenceIds: string[],
    claimIds: string[]
  ): void {
    if (!stepId) return;
    const step = session.steps.find((s) => s.id === stepId);
    if (!step) return;
    step.evidenceIds = [...new Set([...step.evidenceIds, ...evidenceIds])];
    step.claimIds = [...new Set([...step.claimIds, ...claimIds])];
  }

  private require(sessionId: string): ResearchSession {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Research session “${sessionId}” not found.`);
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
        // best-effort cleanup ignored
      } catch {
        /* ignore */
      }
    }
  }
}
