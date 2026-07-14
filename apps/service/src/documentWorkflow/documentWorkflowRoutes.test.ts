import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { DocumentWorkflowService } from "./documentWorkflowService.js";
import { createDocumentWorkflowRouter } from "./documentWorkflowRoutes.js";
import type { OfficeCliRuntime } from "../officecli/officeCliRuntime.js";
import type { ZoteroConnector } from "../zotero/zoteroConnector.js";

describe("document workflow routes", () => {
  let root: string;
  let workspace: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-docwf-routes-"));
    workspace = join(root, "ws");
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exposes job lifecycle and probe endpoints", async () => {
    const zotero = {
      probe: vi.fn().mockResolvedValue({
        running: true,
        baseUrl: "http://127.0.0.1:23119/api",
        libraryId: "users/0",
        detail: "ok",
        checkedAt: new Date().toISOString()
      }),
      listCollections: vi.fn().mockResolvedValue([{ key: "C1", name: "Lib" }]),
      searchItems: vi.fn().mockResolvedValue([
        {
          key: "ABCD1234",
          itemType: "journalArticle",
          title: "T",
          creators: [],
          tags: [],
          collections: [],
          missingMetadata: [],
          abstractNote: "e",
          raw: {}
        }
      ]),
      getItem: vi.fn(),
      getChildren: vi.fn(),
      getFullText: vi.fn(),
      toEvidenceSeed: vi.fn()
    } as unknown as ZoteroConnector;

    const office = {
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
      })
    } as unknown as OfficeCliRuntime;

    const documentWorkflow = await DocumentWorkflowService.open({
      statePath: join(root, "jobs.json"),
      workspaceRoot: workspace,
      zotero,
      office
    });

    const app = express();
    app.use(express.json());
    app.use(createDocumentWorkflowRouter({ documentWorkflow, zotero, office }));

    const zStatus = await request(app).get("/api/document-workflow/zotero/status");
    expect(zStatus.status).toBe(200);
    expect(zStatus.body.running).toBe(true);

    const oStatus = await request(app).get("/api/document-workflow/officecli/status");
    expect(oStatus.status).toBe(200);
    expect(oStatus.body.installed).toBe(true);

    const created = await request(app)
      .post("/api/document-workflow/jobs")
      .send({
        workspaceRoot: workspace,
        requirement: {
          title: "测试报告",
          documentType: "course_report",
          assignmentBrief: "写报告",
          citationMode: "dynamic_zotero",
          bibliographyStyle: "apa",
          mustNotInvent: []
        }
      });
    expect(created.status).toBe(201);
    expect(created.body.jobId).toBeTruthy();

    const gathered = await request(app).post(
      `/api/document-workflow/jobs/${created.body.jobId}/gather-sources`
    );
    expect(gathered.status).toBe(200);
    expect(gathered.body.sources.length).toBeGreaterThan(0);
  });
});
