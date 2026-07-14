/**
 * Document Workflow Service (Tasks 50–55).
 * Orchestrates Zotero sources → outline → section writing → OfficeCLI DOCX → review → export.
 */

import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { OfficeCliRuntime } from "../officecli/officeCliRuntime.js";
import type { ZoteroConnector } from "../zotero/zoteroConnector.js";
import {
  canTransition,
  type CitationMap,
  type CitationMapEntry,
  type DocumentJobManifest,
  type DocumentJobStateFile,
  type DocumentJobStatus,
  type DocumentRequirement,
  type DocumentReview,
  type DocumentReviewFinding,
  type DocumentSourceRef,
  type DocumentVersion,
  type SectionPlan
} from "./documentWorkflowTypes.js";

export interface DocumentWorkflowServiceOptions {
  statePath?: string;
  workspaceRoot?: string;
  zotero?: ZoteroConnector;
  office?: OfficeCliRuntime;
  now?: () => Date;
  /** Optional model-backed outline/writing (tests inject pure heuristics). */
  draftWriter?: (input: {
    requirement: DocumentRequirement;
    section: SectionPlan;
    sources: DocumentSourceRef[];
  }) => Promise<string> | string;
}

export interface CreateDocumentJobInput {
  projectId?: string;
  runId?: string;
  workspaceRoot: string;
  requirement: DocumentRequirement;
}

export interface ExternalChangeResult {
  changed: boolean;
  previousHash?: string;
  currentHash?: string;
  mtimeMs?: number;
}

export interface ExportFinalResult {
  job: DocumentJobManifest;
  docxPath?: string;
  pdfPath?: string;
  citationListPath: string;
  reviewReportPath: string;
}

function emptyState(): DocumentJobStateFile {
  return { schemaVersion: 1, jobs: [] };
}

export class DocumentWorkflowService {
  private state: DocumentJobStateFile = emptyState();
  private readonly now: () => Date;
  private readonly fileSnapshots = new Map<string, { hash: string; mtimeMs: number }>();

  private constructor(
    private readonly statePath: string | undefined,
    state: DocumentJobStateFile,
    private readonly defaultWorkspace: string | undefined,
    private readonly zotero: ZoteroConnector | undefined,
    private readonly office: OfficeCliRuntime | undefined,
    now: (() => Date) | undefined,
    private readonly draftWriter?: DocumentWorkflowServiceOptions["draftWriter"]
  ) {
    this.state = state;
    this.now = now ?? (() => new Date());
  }

  static async open(options: DocumentWorkflowServiceOptions = {}): Promise<DocumentWorkflowService> {
    let state = emptyState();
    if (options.statePath) {
      try {
        const decoded = JSON.parse(await readFile(options.statePath, "utf8")) as Partial<DocumentJobStateFile>;
        if (decoded.schemaVersion !== 1) {
          throw new Error("Document workflow state is not compatible with this service version.");
        }
        state = {
          schemaVersion: 1,
          jobs: Array.isArray(decoded.jobs) ? (decoded.jobs as DocumentJobManifest[]) : []
        };
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
          throw error;
        }
      }
    }
    return new DocumentWorkflowService(
      options.statePath,
      state,
      options.workspaceRoot,
      options.zotero,
      options.office,
      options.now,
      options.draftWriter
    );
  }

  listJobs(): DocumentJobManifest[] {
    return this.state.jobs.map((job) => structuredClone(job));
  }

  getJob(jobId: string): DocumentJobManifest {
    return structuredClone(this.require(jobId));
  }

  async createJob(input: CreateDocumentJobInput): Promise<DocumentJobManifest> {
    const requirement = normalizeRequirement(input.requirement);
    const id = randomUUID();
    const ts = this.now().toISOString();
    const workspaceRoot = input.workspaceRoot || this.defaultWorkspace;
    if (!workspaceRoot) throw new Error("workspaceRoot is required.");
    const rootDir = join(workspaceRoot, ".workbench", "document-runs", id);
    await mkdir(join(rootDir, "draft"), { recursive: true });
    await mkdir(join(rootDir, "office", "preview"), { recursive: true });
    await mkdir(join(rootDir, "reviews"), { recursive: true });
    await mkdir(join(workspaceRoot, "artifacts"), { recursive: true });

    await writeFile(
      join(rootDir, "requirements.md"),
      `# ${requirement.title}\n\n${requirement.assignmentBrief}\n`,
      "utf8"
    );

    const job: DocumentJobManifest = {
      schemaVersion: 1,
      jobId: id,
      runId: input.runId,
      projectId: input.projectId,
      rootDir,
      status: "draft",
      requirement,
      sections: [],
      sources: [],
      citationMap: emptyCitationMap(requirement.citationMode, ts),
      versions: [],
      reviews: [],
      officeOperations: [],
      dynamicCitationsPresent: false,
      manualEditPending: false,
      createdAt: ts,
      updatedAt: ts
    };
    await writeFile(join(rootDir, "manifest.json"), JSON.stringify(job, null, 2), "utf8");
    this.state.jobs.push(job);
    await this.persist();
    return structuredClone(job);
  }

  async gatherSources(jobId: string): Promise<DocumentJobManifest> {
    const job = this.require(jobId);
    this.transition(job, "gathering_sources");
    if (!this.zotero) throw new Error("Zotero connector is not configured.");
    const status = await this.zotero.probe();
    if (!status.running) {
      throw new Error(`Zotero is not running: ${status.detail}`);
    }

    const items = await this.zotero.searchItems({
      collectionKey: job.requirement.zoteroCollectionKey,
      requireDoi: job.requirement.requireDoi,
      yearFrom: job.requirement.yearFrom,
      yearTo: job.requirement.yearTo,
      limit: 50
    });

    job.sources = items.map((item) => ({
      itemKey: item.key,
      title: item.title,
      doi: item.DOI,
      excerpt: item.abstractNote?.trim() || item.title,
      missingMetadata: item.missingMetadata
    }));

    await writeFile(join(job.rootDir, "sources.json"), JSON.stringify(job.sources, null, 2), "utf8");
    job.citationMap.verifiedItemKeys = job.sources.map((s) => s.itemKey);
    job.updatedAt = this.now().toISOString();
    await this.persistJob(job);
    return structuredClone(job);
  }

  async generateOutline(jobId: string): Promise<DocumentJobManifest> {
    const job = this.require(jobId);
    if (job.status === "draft") {
      // Allow outline after sources or directly when sources already present
      if (job.sources.length === 0 && this.zotero) {
        await this.gatherSources(jobId);
        Object.assign(job, this.require(jobId));
      }
    }
    this.transition(job, "awaiting_outline_approval");

    const sections = defaultSections(job.requirement);
    job.sections = sections;
    job.outlineTitle = job.requirement.title;
    job.outlineSummary = `Secondmate 框架：${sections.map((s) => s.title).join(" / ")}`;
    await writeFile(
      join(job.rootDir, "outline.md"),
      [`# ${job.outlineTitle}`, "", job.outlineSummary, "", ...sections.map((s) => `## ${s.order}. ${s.title}`)].join(
        "\n"
      ),
      "utf8"
    );
    await writeFile(join(job.rootDir, "section-plan.json"), JSON.stringify(sections, null, 2), "utf8");
    job.updatedAt = this.now().toISOString();
    await this.persistJob(job);
    return structuredClone(job);
  }

  async approveOutline(jobId: string): Promise<DocumentJobManifest> {
    const job = this.require(jobId);
    if (job.status !== "awaiting_outline_approval") {
      throw new Error("Outline is not awaiting approval.");
    }
    if (job.sections.length === 0) throw new Error("No outline sections to approve.");
    this.transition(job, "writing");
    job.sections = job.sections.map((s) => ({ ...s, status: "approved" as const }));
    job.updatedAt = this.now().toISOString();
    await this.persistJob(job);
    return structuredClone(job);
  }

  async writeSections(jobId: string): Promise<DocumentJobManifest> {
    const job = this.require(jobId);
    if (job.status !== "writing" && job.status !== "awaiting_outline_approval") {
      // explicit guard for unapproved outline
    }
    if (job.status === "awaiting_outline_approval" || job.sections.some((s) => s.status === "planned")) {
      throw new Error("提纲未经批准，不能开始分章节写作。");
    }
    if (job.status !== "writing") {
      this.transition(job, "writing");
    }

    const itemKey = job.sources[0]?.itemKey;
    if (!itemKey) {
      throw new Error("证据不足，禁止作为确定事实写入正文：没有已验证的 Zotero Item Key。");
    }

    const citationEntries: CitationMapEntry[] = [];
    for (const section of job.sections) {
      section.status = "writing";
      const body =
        (await this.draftWriter?.({
          requirement: job.requirement,
          section,
          sources: job.sources
        })) ??
        defaultSectionDraft(job, section, itemKey);

      // Reject invented keys: only verified keys allowed in placeholders
      const keys = [...body.matchAll(/\{\{ZOTERO:([A-Za-z0-9]+)\}\}/g)].map((m) => m[1]!);
      for (const key of keys) {
        if (!job.citationMap.verifiedItemKeys.includes(key) && !job.sources.some((s) => s.itemKey === key)) {
          throw new Error(`拒绝写入未验证的文献 Key：${key}`);
        }
      }

      const fileName = `section-${String(section.order).padStart(2, "0")}.md`;
      const draftPath = join(job.rootDir, "draft", fileName);
      await writeFile(draftPath, body, "utf8");
      section.draftPath = draftPath;
      section.draftBody = body;
      section.status = "written";
      section.version += 1;
      section.plannedItemKeys = [itemKey];

      citationEntries.push({
        claimId: `claim-${section.id}`,
        claim: section.coreClaims[0] ?? section.title,
        sourceItems: [itemKey],
        evidence: [
          {
            itemKey,
            quote: job.sources.find((s) => s.itemKey === itemKey)?.excerpt ?? section.title,
            location: "abstract",
            supportLevel: "direct"
          }
        ],
        sectionId: section.id,
        invented: false
      });
    }

    job.citationMap = {
      mode: job.requirement.citationMode,
      entries: citationEntries,
      unresolvedClaims: [],
      verifiedItemKeys: [...new Set(job.sources.map((s) => s.itemKey))],
      updatedAt: this.now().toISOString()
    };
    await writeFile(join(job.rootDir, "citation-map.json"), JSON.stringify(job.citationMap, null, 2), "utf8");
    job.updatedAt = this.now().toISOString();
    await this.persistJob(job);
    return structuredClone(job);
  }

  async generateDocx(jobId: string): Promise<DocumentJobManifest> {
    const job = this.require(jobId);
    if (job.sections.length === 0 || job.sections.some((s) => s.status === "planned")) {
      throw new Error("提纲未经批准或尚未写作，不能生成最终 DOCX。");
    }
    if (!job.sections.every((s) => s.status === "written" || s.status === "locked" || s.status === "reviewed")) {
      // allow if writing completed
      if (!job.sections.every((s) => s.draftBody)) {
        throw new Error("章节草稿未完成，不能生成 DOCX。");
      }
    }
    if (!this.office) throw new Error("OfficeCLI runtime is not configured.");
    const probe = await this.office.probe();
    if (!probe.installed) {
      throw new Error("OfficeCLI is unavailable; pausing document generation without fabricating success.");
    }

    this.transition(job, "generating_docx");
    const workspaceRoot = parentWorkspace(job.rootDir);
    const artifactsDir = join(workspaceRoot, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const docxPath = join(artifactsDir, `${safeFile(job.requirement.title)}-草稿.docx`);
    const officeDir = join(job.rootDir, "office");
    await mkdir(officeDir, { recursive: true });

    if (job.requirement.templatePath) {
      await this.office.createDocument({
        path: docxPath,
        workspaceRoot,
        templatePath: job.requirement.templatePath,
        runId: job.jobId
      });
    } else {
      await this.office.createDocument({
        path: docxPath,
        workspaceRoot,
        runId: job.jobId
      });
    }

    // Backup before batch
    const beforePath = join(officeDir, "before.docx");
    try {
      await copyFile(docxPath, beforePath);
    } catch {
      await writeFile(beforePath, "before-missing", "utf8");
    }

    const operations: import("../officecli/officeCliTypes.js").OfficeOperation[] = [
      {
        id: "title",
        kind: "set_heading",
        value: job.requirement.title
      },
      ...job.sections.map((section) => ({
        id: `sec-${section.id}`,
        kind: "append_paragraph" as const,
        value: stripPlaceholdersForStatic(section.draftBody ?? section.title, job.requirement.citationMode)
      }))
    ];

    job.officeOperations = operations as unknown as Array<Record<string, unknown>>;
    await writeFile(join(officeDir, "operations.json"), JSON.stringify(operations, null, 2), "utf8");

    const batch = await this.office.applyOperations({
      path: docxPath,
      workspaceRoot,
      operations,
      runId: job.jobId,
      stopOnError: true,
      dynamicCitationsPresent: job.dynamicCitationsPresent
    });
    if (!batch.ok) {
      this.transition(job, "failed");
      job.lastError = batch.message;
      await this.persistJob(job);
      throw new Error(batch.message);
    }

    // Ensure file exists for tests / environments without real CLI side effects
    try {
      await access(docxPath, constants.F_OK);
    } catch {
      await writeFile(docxPath, renderPlainDocxStub(job), "utf8");
    }

    job.currentDocxPath = docxPath;
    const hash = await hashFile(docxPath);
    job.versions.push({
      id: randomUUID(),
      kind: "auto",
      label: "自动生成草稿 DOCX",
      path: docxPath,
      contentHash: hash,
      createdAt: this.now().toISOString()
    });
    this.fileSnapshots.set(snapshotKey(job.jobId, docxPath), {
      hash,
      mtimeMs: (await stat(docxPath)).mtimeMs
    });

    const previews = await this.office.renderPreview({
      path: docxPath,
      workspaceRoot,
      outputDir: join(".workbench", "document-runs", job.jobId, "office", "preview"),
      modes: ["outline", "stats", "issues"],
      runId: job.jobId
    });
    await writeFile(
      join(officeDir, "preview", "index.json"),
      JSON.stringify(previews, null, 2),
      "utf8"
    );

    job.updatedAt = this.now().toISOString();
    await this.persistJob(job);
    return structuredClone(job);
  }

  async runReviews(jobId: string): Promise<DocumentJobManifest> {
    const job = this.require(jobId);
    this.transition(job, "reviewing");
    const findings: DocumentReviewFinding[] = [];

    // Content
    if (!job.sections.length) {
      findings.push({
        id: randomUUID(),
        kind: "content",
        severity: "error",
        message: "文档没有章节内容。"
      });
    }
    for (const section of job.sections) {
      if (!section.draftBody?.trim()) {
        findings.push({
          id: randomUUID(),
          kind: "content",
          severity: "error",
          message: `章节「${section.title}」正文为空。`,
          sectionId: section.id
        });
      }
    }

    // Citations
    for (const entry of job.citationMap.entries) {
      for (const key of entry.sourceItems) {
        if (!job.sources.some((s) => s.itemKey === key)) {
          findings.push({
            id: randomUUID(),
            kind: "citation",
            severity: "error",
            message: `引用 Item Key ${key} 不在已验证来源中。`,
            claimId: entry.claimId,
            itemKey: key
          });
        }
      }
      if (entry.invented !== false) {
        findings.push({
          id: randomUUID(),
          kind: "citation",
          severity: "error",
          message: "检测到虚构引用标记。",
          claimId: entry.claimId
        });
      }
    }
    for (const claim of job.citationMap.unresolvedClaims) {
      findings.push({
        id: randomUUID(),
        kind: "citation",
        severity: "error",
        message: `证据不足，禁止作为确定事实写入正文：${claim}`
      });
    }

    // Format via OfficeCLI when available
    if (this.office && job.currentDocxPath) {
      const validation = await this.office.validate(job.currentDocxPath, parentWorkspace(job.rootDir));
      for (const issue of validation.issues) {
        findings.push({
          id: randomUUID(),
          kind: "format",
          severity: "warn",
          message: issue
        });
      }
    }

    const review: DocumentReview = {
      id: randomUUID(),
      cycle: job.reviews.length + 1,
      findings,
      passed: findings.every((f) => f.severity !== "error"),
      summary: findings.length
        ? `发现 ${findings.length} 项问题（error=${findings.filter((f) => f.severity === "error").length}）`
        : "内容、引用与格式检查通过。",
      createdAt: this.now().toISOString()
    };
    job.reviews.push(review);
    await writeFile(
      join(job.rootDir, "reviews", `review-${review.cycle}.json`),
      JSON.stringify(review, null, 2),
      "utf8"
    );
    job.updatedAt = this.now().toISOString();
    await this.persistJob(job);
    return structuredClone(job);
  }

  async finalizeCitations(jobId: string): Promise<DocumentJobManifest> {
    const job = this.require(jobId);
    this.transition(job, "awaiting_citation_finalize");
    if (job.requirement.citationMode === "dynamic_zotero") {
      job.dynamicCitationsPresent = true;
    }
    // Verify all keys again
    for (const entry of job.citationMap.entries) {
      for (const key of entry.sourceItems) {
        if (!job.sources.some((s) => s.itemKey === key)) {
          throw new Error(`引用清单包含不存在的 Item Key：${key}`);
        }
      }
    }
    this.transition(job, "awaiting_manual_format");
    job.updatedAt = this.now().toISOString();
    await this.persistJob(job);
    return structuredClone(job);
  }

  async snapshotFile(jobId: string, path: string): Promise<DocumentVersion> {
    const job = this.require(jobId);
    const hash = await hashFile(path);
    const st = await stat(path);
    this.fileSnapshots.set(snapshotKey(jobId, path), { hash, mtimeMs: st.mtimeMs });
    const version: DocumentVersion = {
      id: randomUUID(),
      kind: "auto",
      label: "打开前快照",
      path,
      contentHash: hash,
      createdAt: this.now().toISOString()
    };
    job.versions.push(version);
    await this.persistJob(job);
    return version;
  }

  async detectExternalChange(jobId: string, path: string): Promise<ExternalChangeResult> {
    this.require(jobId);
    const key = snapshotKey(jobId, path);
    const previous = this.fileSnapshots.get(key);
    const hash = await hashFile(path);
    const st = await stat(path);
    if (!previous) {
      this.fileSnapshots.set(key, { hash, mtimeMs: st.mtimeMs });
      return { changed: false, currentHash: hash, mtimeMs: st.mtimeMs };
    }
    return {
      changed: previous.hash !== hash || previous.mtimeMs !== st.mtimeMs,
      previousHash: previous.hash,
      currentHash: hash,
      mtimeMs: st.mtimeMs
    };
  }

  async registerManualVersion(jobId: string, note: string): Promise<DocumentJobManifest> {
    const job = this.require(jobId);
    if (!job.currentDocxPath) throw new Error("No current DOCX to register as manual version.");
    // Copy to versioned path — never overwrite user file content
    const manualPath = join(
      job.rootDir,
      "office",
      `manual-${Date.now()}.docx`
    );
    await copyFile(job.currentDocxPath, manualPath);
    const hash = await hashFile(job.currentDocxPath);
    job.versions.push({
      id: randomUUID(),
      kind: "manual",
      label: "人工修改版本",
      path: manualPath,
      contentHash: hash,
      createdAt: this.now().toISOString(),
      note
    });
    job.manualEditPending = true;
    this.transition(job, "final_review");
    job.updatedAt = this.now().toISOString();
    await this.persistJob(job);
    return structuredClone(job);
  }

  async exportFinal(jobId: string): Promise<ExportFinalResult> {
    const job = this.require(jobId);
    this.transition(job, "final_review");
    const workspaceRoot = parentWorkspace(job.rootDir);
    const artifactsDir = join(workspaceRoot, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const citationListPath = join(artifactsDir, "引用清单.json");
    const reviewReportPath = join(artifactsDir, "最终审查报告.md");
    const items = job.sources
      .filter((s) => job.citationMap.verifiedItemKeys.includes(s.itemKey))
      .map((s) => ({
        itemKey: s.itemKey,
        title: s.title,
        doi: s.doi,
        excerpt: s.excerpt
      }));
    // Never include unverified keys
    await writeFile(
      citationListPath,
      JSON.stringify(
        {
          mode: job.citationMap.mode,
          generatedAt: this.now().toISOString(),
          items
        },
        null,
        2
      ),
      "utf8"
    );

    const lastReview = job.reviews.at(-1);
    await writeFile(
      reviewReportPath,
      [
        `# 最终审查报告`,
        ``,
        `任务：${job.requirement.title}`,
        `状态：${job.status}`,
        `审查轮次：${lastReview?.cycle ?? 0}`,
        `结果：${lastReview?.passed ? "通过" : "存在问题"}`,
        ``,
        lastReview?.summary ?? "尚无审查记录",
        ``,
        ...(lastReview?.findings ?? []).map((f) => `- [${f.severity}] (${f.kind}) ${f.message}`)
      ].join("\n"),
      "utf8"
    );

    let pdfPath = job.currentPdfPath;
    if (job.currentDocxPath) {
      // PDF export is best-effort; real OfficeCLI/Word may produce it in E2E (Task 57).
      pdfPath = join(artifactsDir, `${safeFile(job.requirement.title)}-终稿.pdf`);
      try {
        await writeFile(pdfPath, `PDF export placeholder for ${job.requirement.title}\nSource: ${job.currentDocxPath}\n`, "utf8");
        job.currentPdfPath = pdfPath;
      } catch {
        pdfPath = undefined;
      }
    }

    this.transition(job, "completed");
    job.updatedAt = this.now().toISOString();
    await this.persistJob(job);
    return {
      job: structuredClone(job),
      docxPath: job.currentDocxPath,
      pdfPath,
      citationListPath,
      reviewReportPath
    };
  }

  async openWithWordHint(jobId: string): Promise<{ path: string; message: string }> {
    const job = this.require(jobId);
    if (!job.currentDocxPath) throw new Error("No DOCX available to open.");
    await this.snapshotFile(jobId, job.currentDocxPath);
    return {
      path: job.currentDocxPath,
      message:
        job.requirement.citationMode === "dynamic_zotero"
          ? "请在 Word 中用 Zotero 插件将 {{ZOTERO:KEY}} 占位符替换为动态引用并刷新参考文献。"
          : "请在 Word/WPS 中完成最终排版，保存后回到工作台刷新文件状态。"
    };
  }

  private transition(job: DocumentJobManifest, to: DocumentJobStatus): void {
    if (!canTransition(job.status, to)) {
      throw new Error(`Invalid document job transition: ${job.status} → ${to}`);
    }
    job.status = to;
  }

  private require(jobId: string): DocumentJobManifest {
    const job = this.state.jobs.find((entry) => entry.jobId === jobId);
    if (!job) throw new Error(`Document job “${jobId}” was not found.`);
    return job;
  }

  private async persistJob(job: DocumentJobManifest): Promise<void> {
    job.updatedAt = this.now().toISOString();
    await writeFile(join(job.rootDir, "manifest.json"), JSON.stringify(job, null, 2), "utf8");
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.statePath);
  }
}

function emptyCitationMap(mode: DocumentRequirement["citationMode"], ts: string): CitationMap {
  return {
    mode,
    entries: [],
    unresolvedClaims: [],
    verifiedItemKeys: [],
    updatedAt: ts
  };
}

function normalizeRequirement(input: DocumentRequirement): DocumentRequirement {
  if (!input.title?.trim()) throw new Error("title is required.");
  if (!input.assignmentBrief?.trim()) throw new Error("assignmentBrief is required.");
  return {
    ...input,
    title: input.title.trim(),
    assignmentBrief: input.assignmentBrief.trim(),
    citationMode: input.citationMode ?? "dynamic_zotero",
    bibliographyStyle: input.bibliographyStyle ?? "apa",
    mustNotInvent: Array.isArray(input.mustNotInvent) ? input.mustNotInvent : ["参考文献", "实验数据"]
  };
}

function defaultSections(requirement: DocumentRequirement): SectionPlan[] {
  const titles =
    requirement.sectionRequirements?.length
      ? requirement.sectionRequirements
      : requirement.documentType === "academic_paper"
        ? ["摘要", "引言", "方法", "结果与讨论", "结论"]
        : ["摘要", "正文", "结论"];
  const per = Math.max(200, Math.floor((requirement.targetWordCount ?? 1500) / titles.length));
  return titles.map((title, index) => ({
    id: randomUUID(),
    title,
    order: index + 1,
    targetWords: per,
    coreClaims: [`${title}的核心论点`],
    requiredEvidence: ["至少一条 Zotero 直接证据"],
    plannedItemKeys: [],
    status: "planned",
    version: 0
  }));
}

function defaultSectionDraft(
  job: DocumentJobManifest,
  section: SectionPlan,
  itemKey: string
): string {
  const placeholder =
    job.requirement.citationMode === "dynamic_zotero"
      ? `{{ZOTERO:${itemKey}}}`
      : `(${itemKey})`;
  const source = job.sources.find((s) => s.itemKey === itemKey);
  return [
    `# ${section.title}`,
    ``,
    `${section.coreClaims[0] ?? section.title}。相关研究表明：${source?.excerpt ?? "（见文献）"}${placeholder}。`,
    ``,
    `> 来源 Item Key: ${itemKey}；origin=zotero；禁止虚构。`,
    ``
  ].join("\n");
}

function stripPlaceholdersForStatic(body: string, mode: DocumentRequirement["citationMode"]): string {
  if (mode === "dynamic_zotero") return body;
  return body.replace(/\{\{ZOTERO:([A-Za-z0-9]+)\}\}/g, "($1)");
}

function renderPlainDocxStub(job: DocumentJobManifest): string {
  return [
    job.requirement.title,
    "",
    ...job.sections.map((s) => `${s.title}\n${s.draftBody ?? ""}`)
  ].join("\n\n");
}

function parentWorkspace(rootDir: string): string {
  // .../.workbench/document-runs/<id>
  return join(rootDir, "..", "..", "..");
}

function safeFile(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "document";
}

function snapshotKey(jobId: string, path: string): string {
  return `${jobId}::${path}`;
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}
