/**
 * Client for Artifact document browser API (Task 42).
 */

import { createJsonRequest } from "./apiClient.js";

export type PreviewKind =
  | "markdown"
  | "text"
  | "code"
  | "image"
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "binary"
  | "directory"
  | "unknown";

export type ReviewStatus =
  | "none"
  | "pending"
  | "passed"
  | "failed"
  | "needs_changes"
  | "accepted";

export type ArtifactOrigin =
  | "run"
  | "research"
  | "document"
  | "codex"
  | "user"
  | "import"
  | "other";

export interface BrowserEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  sizeBytes: number;
  modifiedAt: string;
  extension: string;
  previewKind: PreviewKind;
  large?: boolean;
}

export interface BrowseResult {
  projectId: string;
  workspacePath: string;
  path: string;
  entries: BrowserEntry[];
  parentPath: string | null;
  truncated: boolean;
  totalEntries: number;
}

export interface PreviewResult {
  projectId: string;
  relativePath: string;
  previewKind: PreviewKind;
  mimeType: string;
  sizeBytes: number;
  truncated: boolean;
  ok: boolean;
  error?: string;
  errorCode?: string;
  text?: string;
  base64?: string;
  html?: string;
  language?: string;
  pageCount?: number;
  parts?: string[];
  range?: { offset: number; length: number; total: number };
}

export interface EvidenceLink {
  id: string;
  summary: string;
  path?: string;
  origin?: string;
  sourceUrl?: string;
}

export interface DiffLink {
  runId?: string;
  path: string;
  kind: "worktree" | "file" | "artifact";
  summary?: string;
}

export interface ArtifactVersion {
  id: string;
  version: number;
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  createdAt: string;
  createdBy?: string;
  note?: string;
  runId?: string;
}

export interface ArtifactRecord {
  id: string;
  projectId: string;
  relativePath: string;
  kind: string;
  title: string;
  origin: ArtifactOrigin;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  runId?: string;
  todoId?: string;
  reviewStatus: ReviewStatus;
  reviewSummary?: string;
  evidenceLinks: EvidenceLink[];
  diffLinks: DiffLink[];
  sourceLinks: Array<{ label: string; path?: string; url?: string }>;
  tags: string[];
  currentVersion: number;
  versions: ArtifactVersion[];
  contentHash?: string;
  sizeBytes?: number;
  previewKind?: PreviewKind;
}

export interface OfficeAvailability {
  office: boolean;
  wps: boolean;
  detail: string;
}

export interface ExternalOpenResult {
  ok: boolean;
  relativePath: string;
  absolutePath: string;
  app: string;
  message: string;
  baseline?: {
    relativePath: string;
    contentHash: string;
    sizeBytes: number;
    modifiedAt: string;
  };
  stub?: boolean;
}

export interface ChangeDetectResult {
  relativePath: string;
  changed: boolean;
  reason?: string;
  current: { contentHash: string; sizeBytes: number; modifiedAt: string };
}

export function createArtifactClient(serviceUrl: string) {
  const json = createJsonRequest(serviceUrl);

  return {
    officeStatus() {
      return json<OfficeAvailability>("/api/artifacts/office-status");
    },

    list(filter: {
      projectId?: string;
      runId?: string;
      q?: string;
      tag?: string;
      origin?: string;
      reviewStatus?: string;
    } = {}) {
      const params = new URLSearchParams();
      if (filter.projectId) params.set("projectId", filter.projectId);
      if (filter.runId) params.set("runId", filter.runId);
      if (filter.q) params.set("q", filter.q);
      if (filter.tag) params.set("tag", filter.tag);
      if (filter.origin) params.set("origin", filter.origin);
      if (filter.reviewStatus) params.set("reviewStatus", filter.reviewStatus);
      const qs = params.toString();
      return json<{ artifacts: ArtifactRecord[] }>(`/api/artifacts${qs ? `?${qs}` : ""}`);
    },

    get(artifactId: string) {
      return json<ArtifactRecord>(`/api/artifacts/${encodeURIComponent(artifactId)}`);
    },

    register(body: {
      projectId: string;
      relativePath: string;
      kind?: string;
      title?: string;
      origin?: ArtifactOrigin;
      createdBy?: string;
      runId?: string;
      tags?: string[];
      evidenceLinks?: EvidenceLink[];
      diffLinks?: DiffLink[];
    }) {
      return json<ArtifactRecord>("/api/artifacts", {
        method: "POST",
        body: JSON.stringify(body)
      });
    },

    update(
      artifactId: string,
      body: {
        title?: string;
        reviewStatus?: ReviewStatus;
        reviewSummary?: string | null;
        tags?: string[];
      }
    ) {
      return json<ArtifactRecord>(`/api/artifacts/${encodeURIComponent(artifactId)}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      });
    },

    versions(artifactId: string) {
      return json<{ versions: ArtifactVersion[] }>(
        `/api/artifacts/${encodeURIComponent(artifactId)}/versions`
      );
    },

    addVersion(artifactId: string, body: { note?: string; createdBy?: string } = {}) {
      return json<ArtifactRecord>(`/api/artifacts/${encodeURIComponent(artifactId)}/versions`, {
        method: "POST",
        body: JSON.stringify(body)
      });
    },

    browse(projectId: string, path = "") {
      const params = new URLSearchParams();
      if (path) params.set("path", path);
      const qs = params.toString();
      return json<BrowseResult>(
        `/api/artifacts/projects/${encodeURIComponent(projectId)}/browse${qs ? `?${qs}` : ""}`
      );
    },

    preview(projectId: string, path: string, range?: { offset?: number; limit?: number }) {
      const params = new URLSearchParams({ path });
      if (range?.offset !== undefined) params.set("offset", String(range.offset));
      if (range?.limit !== undefined) params.set("limit", String(range.limit));
      return json<PreviewResult>(
        `/api/artifacts/projects/${encodeURIComponent(projectId)}/preview?${params}`
      );
    },

    openExternal(projectId: string, path: string, preferred: "office" | "wps" | "default" | "auto" = "auto") {
      return json<ExternalOpenResult>(
        `/api/artifacts/projects/${encodeURIComponent(projectId)}/open-external`,
        { method: "POST", body: JSON.stringify({ path, preferred }) }
      );
    },

    detectChanges(projectId: string, path: string) {
      return json<ChangeDetectResult>(
        `/api/artifacts/projects/${encodeURIComponent(projectId)}/detect-changes`,
        { method: "POST", body: JSON.stringify({ path }) }
      );
    },

    reveal(projectId: string, path: string) {
      return json<{ ok: boolean; absolutePath: string; relativePath: string; message: string }>(
        `/api/artifacts/projects/${encodeURIComponent(projectId)}/reveal`,
        { method: "POST", body: JSON.stringify({ path }) }
      );
    },

    copyPath(projectId: string, path: string) {
      return json<{ path: string; absolutePath: string; relativePath: string }>(
        `/api/artifacts/projects/${encodeURIComponent(projectId)}/copy-path`,
        { method: "POST", body: JSON.stringify({ path }) }
      );
    },

    importRun(runId: string, projectId: string) {
      return json<{ artifacts: ArtifactRecord[] }>(
        `/api/artifacts/runs/${encodeURIComponent(runId)}/import`,
        { method: "POST", body: JSON.stringify({ projectId }) }
      );
    }
  };
}
