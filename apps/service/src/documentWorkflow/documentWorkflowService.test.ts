import { mkdtemp, readFile, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkflowService } from "./documentWorkflowService.js";
import type { OfficeCliRuntime } from "../officecli/officeCliRuntime.js";
import type { ZoteroConnector } from "../zotero/zoteroConnector.js";

describe("Document Workflow Service (Tasks 50–55)", () => {
  let root: string;
  let workspace: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-docwf-"));
    workspace = join(root, "project");
    await writeFile(join(root, ".keep"), "", "utf8");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fakeZotero(): ZoteroConnector {
    return {
      probe: vi.fn().mockResolvedValue({
        running: true,
        baseUrl: "http://127.0.0.1:23119/api",
        libraryId: "users/0",
        detail: "ok",
        checkedAt: new Date().toISOString()
      }),
      listCollections: vi.fn().mockResolvedValue([{ key: "COL1", name: "Papers" }]),
      searchItems: vi.fn().mockResolvedValue([
        {
          key: "ABCD1234",
          itemType: "journalArticle",
          title: "Harness Design",
          creators: [{ lastName: "Lovelace", firstName: "Ada" }],
          date: "2024",
          year: 2024,
          DOI: "10.1000/test",
          abstractNote: "Tools improve stability.",
          tags: [],
          collections: ["COL1"],
          missingMetadata: [],
          raw: {}
        }
      ]),
      getItem: vi.fn().mockResolvedValue({
        key: "ABCD1234",
        itemType: "journalArticle",
        title: "Harness Design",
        creators: [{ lastName: "Lovelace", firstName: "Ada" }],
        date: "2024",
        year: 2024,
        DOI: "10.1000/test",
        abstractNote: "Tools improve stability.",
        tags: [],
        collections: ["COL1"],
        missingMetadata: [],
        raw: {}
      }),
      getChildren: vi.fn().mockResolvedValue([]),
      getFullText: vi.fn().mockResolvedValue(null),
      toEvidenceSeed: vi.fn().mockResolvedValue({
        itemKey: "ABCD1234",
        title: "Harness Design",
        source: "10.1000/test",
        author: "Lovelace, Ada",
        publishedAt: "2024",
        excerpt: "Tools improve stability.",
        doi: "10.1000/test",
        origin: "zotero"
      })
    } as unknown as ZoteroConnector;
  }

  function fakeOffice(): OfficeCliRuntime {
    return {
      probe: vi.fn().mockResolvedValue({
        installed: true,
        version: "1.0.0",
        supportsCreate: true,
        supportsView: true,
        supportsBatch: true,
        supportsRender: true,
        supportsValidate: true,
        detail: "ok",
        checkedAt: new Date().toISOString()
      }),
      createDocument: vi.fn().mockImplementation(async (input: { path: string }) => {
        await writeFile(input.path, "PK-docx-stub", "utf8");
        return { ok: true, path: input.path, exitCode: 0, stdout: "ok", stderr: "", logs: [], message: "ok", durationMs: 1 };
      }),
      applyOperations: vi.fn().mockResolvedValue({
        ok: true,
        path: "x",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        logs: [],
        message: "ok",
        durationMs: 1
      }),
      renderPreview: vi.fn().mockResolvedValue([
        { path: join(workspace, "preview.txt"), kind: "outline", summary: "outline ok" }
      ]),
      validate: vi.fn().mockResolvedValue({
        path: "x",
        ok: true,
        issues: [],
        readable: true,
        message: "ok"
      }),
      inspectDocument: vi.fn().mockResolvedValue({
        path: "x",
        kind: "docx",
        outline: "H1",
        issues: [],
        rawSummary: "ok"
      }),
      cancel: vi.fn()
    } as unknown as OfficeCliRuntime;
  }

  async function openService() {
    return DocumentWorkflowService.open({
      statePath: join(root, "document-jobs.json"),
      workspaceRoot: workspace,
      zotero: fakeZotero(),
      office: fakeOffice()
    });
  }

  it("creates a job in draft and refuses final DOCX before outline approval", async () => {
    const service = await openService();
    const job = await service.createJob({
      projectId: "p1",
      workspaceRoot: workspace,
      requirement: {
        title: "Agent Harness 报告",
        documentType: "course_report",
        assignmentBrief: "写一份关于 Agent Harness 的课程报告",
        citationMode: "dynamic_zotero",
        bibliographyStyle: "apa",
        zoteroCollectionKey: "COL1",
        mustNotInvent: ["实验数据", "参考文献"]
      }
    });
    expect(job.status).toBe("draft");
    await expect(service.generateDocx(job.jobId)).rejects.toThrow(/outline|批准|approval/i);
  });

  it("gathers real Zotero sources and never invents item keys", async () => {
    const service = await openService();
    const job = await service.createJob({
      workspaceRoot: workspace,
      requirement: {
        title: "t",
        documentType: "academic_paper",
        assignmentBrief: "brief",
        citationMode: "static",
        bibliographyStyle: "ieee",
        zoteroCollectionKey: "COL1",
        mustNotInvent: []
      }
    });
    const gathered = await service.gatherSources(job.jobId);
    expect(gathered.status).toBe("gathering_sources");
    expect(gathered.sources.some((s) => s.itemKey === "ABCD1234")).toBe(true);
    expect(gathered.sources.every((s) => /^[A-Z0-9]+$/i.test(s.itemKey))).toBe(true);
  });

  it("builds outline, requires approval, then writes sections with citation map", async () => {
    const service = await openService();
    let job = await service.createJob({
      workspaceRoot: workspace,
      requirement: {
        title: "Harness 论文",
        documentType: "academic_paper",
        assignmentBrief: "包含摘要、引言、方法、结论",
        citationMode: "dynamic_zotero",
        bibliographyStyle: "apa",
        zoteroCollectionKey: "COL1",
        targetWordCount: 2000,
        mustNotInvent: ["参考文献"]
      }
    });
    job = await service.gatherSources(job.jobId);
    job = await service.generateOutline(job.jobId);
    expect(job.status).toBe("awaiting_outline_approval");
    expect(job.sections.length).toBeGreaterThan(1);

    await expect(service.writeSections(job.jobId)).rejects.toThrow(/批准|approval/i);

    job = await service.approveOutline(job.jobId);
    expect(job.status).toBe("writing");
    job = await service.writeSections(job.jobId);
    expect(job.sections.every((s) => s.status === "written" || s.status === "locked")).toBe(true);
    expect(job.citationMap.entries.length).toBeGreaterThan(0);
    expect(job.citationMap.entries.every((e) => e.invented === false)).toBe(true);
    expect(job.citationMap.entries.every((e) => e.sourceItems.includes("ABCD1234"))).toBe(true);

    const draft = await readFile(
      join(workspace, ".workbench", "document-runs", job.jobId, "draft", "section-01.md"),
      "utf8"
    );
    expect(draft).toMatch(/\{\{ZOTERO:ABCD1234\}\}|ABCD1234/);
  });

  it("generates DOCX via OfficeCLI after writing and runs review gates", async () => {
    const service = await openService();
    let job = await service.createJob({
      workspaceRoot: workspace,
      requirement: {
        title: "报告",
        documentType: "course_report",
        assignmentBrief: "课程报告",
        citationMode: "static",
        bibliographyStyle: "gb7714",
        mustNotInvent: []
      }
    });
    job = await service.gatherSources(job.jobId);
    job = await service.generateOutline(job.jobId);
    job = await service.approveOutline(job.jobId);
    job = await service.writeSections(job.jobId);
    job = await service.generateDocx(job.jobId);
    expect(job.status === "generating_docx" || job.status === "reviewing" || job.currentDocxPath).toBeTruthy();
    expect(job.currentDocxPath).toBeTruthy();
    await access(job.currentDocxPath!);

    job = await service.runReviews(job.jobId);
    expect(job.reviews.length).toBeGreaterThan(0);
    expect(job.reviews.at(-1)?.findings).toBeDefined();
  });

  it("tracks Word manual edits by hash and does not overwrite manual version", async () => {
    const service = await openService();
    let job = await service.createJob({
      workspaceRoot: workspace,
      requirement: {
        title: "t",
        documentType: "custom",
        assignmentBrief: "b",
        citationMode: "dynamic_zotero",
        bibliographyStyle: "apa",
        mustNotInvent: []
      }
    });
    job = await service.gatherSources(job.jobId);
    job = await service.generateOutline(job.jobId);
    job = await service.approveOutline(job.jobId);
    job = await service.writeSections(job.jobId);
    job = await service.generateDocx(job.jobId);
    const path = job.currentDocxPath!;
    const before = await service.snapshotFile(job.jobId, path);
    await writeFile(path, "MANUAL EDIT BY USER", "utf8");
    const changed = await service.detectExternalChange(job.jobId, path);
    expect(changed.changed).toBe(true);
    expect(changed.previousHash).toBe(before.contentHash);
    job = await service.registerManualVersion(job.jobId, "用户在 Word 中保存");
    expect(job.versions.some((v) => v.kind === "manual")).toBe(true);
    expect(job.manualEditPending).toBe(true);
  });

  it("exports citation list and final package paths under workspace artifacts", async () => {
    const service = await openService();
    let job = await service.createJob({
      workspaceRoot: workspace,
      requirement: {
        title: "终稿",
        documentType: "academic_paper",
        assignmentBrief: "paper",
        citationMode: "static",
        bibliographyStyle: "apa",
        mustNotInvent: []
      }
    });
    job = await service.gatherSources(job.jobId);
    job = await service.generateOutline(job.jobId);
    job = await service.approveOutline(job.jobId);
    job = await service.writeSections(job.jobId);
    job = await service.generateDocx(job.jobId);
    job = await service.runReviews(job.jobId);
    job = await service.finalizeCitations(job.jobId);
    const exported = await service.exportFinal(job.jobId);
    expect(exported.citationListPath).toMatch(/artifacts|引用/);
    expect(exported.reviewReportPath).toBeTruthy();
    const list = JSON.parse(await readFile(exported.citationListPath, "utf8")) as { items: Array<{ itemKey: string }> };
    expect(list.items.every((i) => i.itemKey === "ABCD1234")).toBe(true);
  });
});
