/**
 * Client for Document Workflow API (Tasks 48–56).
 */

export type DocumentType =
  | "course_report"
  | "academic_paper"
  | "business_plan"
  | "research_report"
  | "lab_report"
  | "custom";

export type CitationMode = "dynamic_zotero" | "static";

export interface DocumentRequirementPayload {
  title: string;
  documentType: DocumentType;
  assignmentBrief: string;
  citationMode: CitationMode;
  bibliographyStyle: "apa" | "ieee" | "gb7714";
  zoteroCollectionKey?: string;
  targetWordCount?: number;
  mustNotInvent?: string[];
  templatePath?: string;
}

export interface DocumentJobRecord {
  jobId: string;
  status: string;
  requirement: DocumentRequirementPayload & { mustNotInvent: string[] };
  sections: Array<{ id: string; title: string; status: string; order: number }>;
  sources: Array<{ itemKey: string; title: string; doi?: string; excerpt: string }>;
  citationMap: {
    mode: CitationMode;
    entries: Array<{ claimId: string; claim: string; sourceItems: string[] }>;
    verifiedItemKeys: string[];
  };
  reviews: Array<{ cycle: number; passed: boolean; summary: string }>;
  currentDocxPath?: string;
  dynamicCitationsPresent: boolean;
  manualEditPending: boolean;
  updatedAt: string;
}

export interface ZoteroStatusRecord {
  running: boolean;
  detail: string;
  baseUrl: string;
}

export interface OfficeCliStatusRecord {
  installed: boolean;
  version?: string;
  detail: string;
}

export interface ZoteroCollectionRecord {
  key: string;
  name: string;
  parentCollection?: string;
}

async function requestJson<T>(serviceUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${serviceUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(body && typeof body === "object" && "error" in body && body.error
      ? String(body.error)
      : `服务返回 ${response.status}`);
  }
  return body as T;
}

export function createDocumentWorkflowClient(serviceUrl: string) {
  return {
    listJobs: () => requestJson<DocumentJobRecord[]>(serviceUrl, "/api/document-workflow/jobs"),
    createJob: (payload: { workspaceRoot: string; projectId?: string; requirement: DocumentRequirementPayload }) =>
      requestJson<DocumentJobRecord>(serviceUrl, "/api/document-workflow/jobs", {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    getJob: (jobId: string) =>
      requestJson<DocumentJobRecord>(serviceUrl, `/api/document-workflow/jobs/${encodeURIComponent(jobId)}`),
    gatherSources: (jobId: string) =>
      requestJson<DocumentJobRecord>(serviceUrl, `/api/document-workflow/jobs/${encodeURIComponent(jobId)}/gather-sources`, {
        method: "POST",
        body: "{}"
      }),
    generateOutline: (jobId: string) =>
      requestJson<DocumentJobRecord>(serviceUrl, `/api/document-workflow/jobs/${encodeURIComponent(jobId)}/outline`, {
        method: "POST",
        body: "{}"
      }),
    approveOutline: (jobId: string) =>
      requestJson<DocumentJobRecord>(serviceUrl, `/api/document-workflow/jobs/${encodeURIComponent(jobId)}/approve-outline`, {
        method: "POST",
        body: "{}"
      }),
    writeSections: (jobId: string) =>
      requestJson<DocumentJobRecord>(serviceUrl, `/api/document-workflow/jobs/${encodeURIComponent(jobId)}/write-sections`, {
        method: "POST",
        body: "{}"
      }),
    generateDocx: (jobId: string) =>
      requestJson<DocumentJobRecord>(serviceUrl, `/api/document-workflow/jobs/${encodeURIComponent(jobId)}/generate-docx`, {
        method: "POST",
        body: "{}"
      }),
    runReviews: (jobId: string) =>
      requestJson<DocumentJobRecord>(serviceUrl, `/api/document-workflow/jobs/${encodeURIComponent(jobId)}/reviews`, {
        method: "POST",
        body: "{}"
      }),
    finalizeCitations: (jobId: string) =>
      requestJson<DocumentJobRecord>(
        serviceUrl,
        `/api/document-workflow/jobs/${encodeURIComponent(jobId)}/finalize-citations`,
        { method: "POST", body: "{}" }
      ),
    exportFinal: (jobId: string) =>
      requestJson<{
        job: DocumentJobRecord;
        citationListPath: string;
        reviewReportPath: string;
        docxPath?: string;
        pdfPath?: string;
      }>(serviceUrl, `/api/document-workflow/jobs/${encodeURIComponent(jobId)}/export`, {
        method: "POST",
        body: "{}"
      }),
    openWord: (jobId: string) =>
      requestJson<{ path: string; message: string }>(
        serviceUrl,
        `/api/document-workflow/jobs/${encodeURIComponent(jobId)}/open-word`,
        { method: "POST", body: "{}" }
      ),
    fileChange: (jobId: string) =>
      requestJson<{ changed: boolean; previousHash?: string; currentHash?: string }>(
        serviceUrl,
        `/api/document-workflow/jobs/${encodeURIComponent(jobId)}/file-change`
      ),
    registerManualVersion: (jobId: string, note: string) =>
      requestJson<DocumentJobRecord>(
        serviceUrl,
        `/api/document-workflow/jobs/${encodeURIComponent(jobId)}/manual-version`,
        { method: "POST", body: JSON.stringify({ note }) }
      ),
    zoteroStatus: () => requestJson<ZoteroStatusRecord>(serviceUrl, "/api/document-workflow/zotero/status"),
    zoteroCollections: () =>
      requestJson<ZoteroCollectionRecord[]>(serviceUrl, "/api/document-workflow/zotero/collections"),
    officeStatus: () => requestJson<OfficeCliStatusRecord>(serviceUrl, "/api/document-workflow/officecli/status")
  };
}
