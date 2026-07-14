/**
 * HTTP routes for Document Workflow (Tasks 50–56).
 */

import { Router, type Request, type Response } from "express";
import type { DocumentWorkflowService } from "./documentWorkflowService.js";
import type { ZoteroConnector } from "../zotero/zoteroConnector.js";
import type { OfficeCliRuntime } from "../officecli/officeCliRuntime.js";

export interface DocumentWorkflowRouteDeps {
  documentWorkflow: DocumentWorkflowService;
  zotero?: ZoteroConnector;
  office?: OfficeCliRuntime;
}

export function createDocumentWorkflowRouter(deps: DocumentWorkflowRouteDeps): Router {
  const router = Router();

  router.get("/api/document-workflow/jobs", (_request, response) => {
    response.json(deps.documentWorkflow.listJobs());
  });

  router.post("/api/document-workflow/jobs", async (request, response) => {
    try {
      const job = await deps.documentWorkflow.createJob({
        projectId: optionalString(request.body?.projectId),
        runId: optionalString(request.body?.runId),
        workspaceRoot: String(request.body?.workspaceRoot ?? ""),
        requirement: request.body?.requirement
      });
      response.status(201).json(job);
    } catch (error) {
      response.status(400).json({ error: message(error, "Unable to create document job.") });
    }
  });

  router.get("/api/document-workflow/jobs/:jobId", (request, response) => {
    try {
      response.json(deps.documentWorkflow.getJob(routeParam(request.params.jobId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Job not found.") });
    }
  });

  router.post("/api/document-workflow/jobs/:jobId/gather-sources", async (request, response) => {
    try {
      response.json(await deps.documentWorkflow.gatherSources(routeParam(request.params.jobId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to gather sources.") });
    }
  });

  router.post("/api/document-workflow/jobs/:jobId/outline", async (request, response) => {
    try {
      response.json(await deps.documentWorkflow.generateOutline(routeParam(request.params.jobId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to generate outline.") });
    }
  });

  router.post("/api/document-workflow/jobs/:jobId/approve-outline", async (request, response) => {
    try {
      response.json(await deps.documentWorkflow.approveOutline(routeParam(request.params.jobId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to approve outline.") });
    }
  });

  router.post("/api/document-workflow/jobs/:jobId/write-sections", async (request, response) => {
    try {
      response.json(await deps.documentWorkflow.writeSections(routeParam(request.params.jobId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to write sections.") });
    }
  });

  router.post("/api/document-workflow/jobs/:jobId/generate-docx", async (request, response) => {
    try {
      response.json(await deps.documentWorkflow.generateDocx(routeParam(request.params.jobId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to generate DOCX.") });
    }
  });

  router.post("/api/document-workflow/jobs/:jobId/reviews", async (request, response) => {
    try {
      response.json(await deps.documentWorkflow.runReviews(routeParam(request.params.jobId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to run reviews.") });
    }
  });

  router.post("/api/document-workflow/jobs/:jobId/finalize-citations", async (request, response) => {
    try {
      response.json(await deps.documentWorkflow.finalizeCitations(routeParam(request.params.jobId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to finalize citations.") });
    }
  });

  router.post("/api/document-workflow/jobs/:jobId/export", async (request, response) => {
    try {
      response.json(await deps.documentWorkflow.exportFinal(routeParam(request.params.jobId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to export final package.") });
    }
  });

  router.post("/api/document-workflow/jobs/:jobId/open-word", async (request, response) => {
    try {
      response.json(await deps.documentWorkflow.openWithWordHint(routeParam(request.params.jobId)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to prepare Word open.") });
    }
  });

  router.get("/api/document-workflow/jobs/:jobId/file-change", async (request, response) => {
    try {
      const job = deps.documentWorkflow.getJob(routeParam(request.params.jobId));
      if (!job.currentDocxPath) {
        return response.status(400).json({ error: "No current DOCX." });
      }
      response.json(await deps.documentWorkflow.detectExternalChange(job.jobId, job.currentDocxPath));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to detect file change.") });
    }
  });

  router.post("/api/document-workflow/jobs/:jobId/manual-version", async (request, response) => {
    try {
      response.json(
        await deps.documentWorkflow.registerManualVersion(
          routeParam(request.params.jobId),
          String(request.body?.note ?? "用户人工保存")
        )
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to register manual version.") });
    }
  });

  router.get("/api/document-workflow/zotero/status", async (_request, response) => {
    if (!deps.zotero) return response.status(503).json({ error: "Zotero connector is not configured." });
    try {
      response.json(await deps.zotero.probe());
    } catch (error) {
      response.status(500).json({ error: message(error, "Unable to probe Zotero.") });
    }
  });

  router.get("/api/document-workflow/zotero/collections", async (_request, response) => {
    if (!deps.zotero) return response.status(503).json({ error: "Zotero connector is not configured." });
    try {
      response.json(await deps.zotero.listCollections());
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to list collections.") });
    }
  });

  router.get("/api/document-workflow/officecli/status", async (_request, response) => {
    if (!deps.office) return response.status(503).json({ error: "OfficeCLI runtime is not configured." });
    try {
      response.json(await deps.office.probe());
    } catch (error) {
      response.status(500).json({ error: message(error, "Unable to probe OfficeCLI.") });
    }
  });

  return router;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statusFor(error: unknown): number {
  const msg = message(error, "");
  if (/not found/i.test(msg)) return 404;
  if (/not running|not installed|unavailable|not configured/i.test(msg)) return 503;
  return 400;
}
