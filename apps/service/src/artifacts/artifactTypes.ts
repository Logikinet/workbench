/**
 * Artifact document browser types (Task 42).
 *
 * Local files remain the single source of truth. Preview never rewrites formats.
 */

export const ARTIFACT_CATALOG_SCHEMA_VERSION = 1 as const;

/** How the browser classifies a path for preview rendering. */
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

export type EntryKind = "file" | "directory";

export type ReviewStatus =
  | "none"
  | "pending"
  | "passed"
  | "failed"
  | "needs_changes"
  | "accepted";

export type ExternalAppKind = "office" | "wps" | "default" | "auto";

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
  /** Project-relative path using forward slashes. */
  relativePath: string;
  kind: EntryKind;
  sizeBytes: number;
  modifiedAt: string;
  extension: string;
  previewKind: PreviewKind;
  /** True when size exceeds default full-load threshold. */
  large?: boolean;
}

export interface BrowseResult {
  projectId: string;
  workspacePath: string;
  /** Project-relative directory being listed ("" = root). */
  path: string;
  entries: BrowserEntry[];
  parentPath: string | null;
  truncated: boolean;
  totalEntries: number;
}

export interface PathStat {
  projectId: string;
  relativePath: string;
  absolutePath: string;
  kind: EntryKind;
  sizeBytes: number;
  modifiedAt: string;
  createdAt?: string;
  extension: string;
  previewKind: PreviewKind;
  exists: boolean;
  contentHash?: string;
}

export interface PreviewRange {
  /** Byte offset for text/binary slices (default 0). */
  offset?: number;
  /** Max bytes to read for text previews (default policy applies). */
  limit?: number;
  /** Max characters of extracted text for office types. */
  maxTextChars?: number;
}

export interface PreviewResult {
  projectId: string;
  relativePath: string;
  previewKind: PreviewKind;
  mimeType: string;
  sizeBytes: number;
  truncated: boolean;
  /** Preview failure must not affect the original file. */
  ok: boolean;
  error?: string;
  errorCode?:
    | "not_found"
    | "is_directory"
    | "too_large"
    | "unsupported"
    | "read_failed"
    | "parse_failed"
    | "outside_workspace";
  /** UTF-8 text for markdown/text/code/office text extract. */
  text?: string;
  /** Base64 payload for small images/pdfs when requested. */
  base64?: string;
  /** Lightweight HTML for office readonly render when available. */
  html?: string;
  /** Language hint for code preview. */
  language?: string;
  /** Image dimensions when known. */
  width?: number;
  height?: number;
  /** Page count for PDF when detected. */
  pageCount?: number;
  /** Sheet/slide names for spreadsheet/presentation. */
  parts?: string[];
  encoding?: string;
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
  /** Unified or stored diff path / run worktree evidence id. */
  runId?: string;
  path: string;
  kind: "worktree" | "file" | "artifact";
  summary?: string;
}

export interface ArtifactVersion {
  id: string;
  version: number;
  /** Snapshot relative path or same path + content hash at registration time. */
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
  /** Project-relative path (local file is truth). */
  relativePath: string;
  kind: string;
  title: string;
  origin: ArtifactOrigin;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  runId?: string;
  todoId?: string;
  sessionId?: string;
  reviewStatus: ReviewStatus;
  reviewSummary?: string;
  evidenceLinks: EvidenceLink[];
  diffLinks: DiffLink[];
  sourceLinks: Array<{ label: string; path?: string; url?: string }>;
  tags: string[];
  currentVersion: number;
  versions: ArtifactVersion[];
  /** Latest known content hash of the live file (may lag until refresh). */
  contentHash?: string;
  sizeBytes?: number;
  previewKind?: PreviewKind;
}

export interface RegisterArtifactInput {
  projectId: string;
  relativePath: string;
  kind?: string;
  title?: string;
  origin?: ArtifactOrigin;
  createdBy?: string;
  runId?: string;
  todoId?: string;
  sessionId?: string;
  reviewStatus?: ReviewStatus;
  reviewSummary?: string;
  evidenceLinks?: EvidenceLink[];
  diffLinks?: DiffLink[];
  sourceLinks?: Array<{ label: string; path?: string; url?: string }>;
  tags?: string[];
  note?: string;
}

export interface UpdateArtifactInput {
  title?: string;
  kind?: string;
  reviewStatus?: ReviewStatus;
  reviewSummary?: string | null;
  evidenceLinks?: EvidenceLink[];
  diffLinks?: DiffLink[];
  sourceLinks?: Array<{ label: string; path?: string; url?: string }>;
  tags?: string[];
  createdBy?: string | null;
}

export interface ArtifactListFilter {
  projectId?: string;
  runId?: string;
  q?: string;
  tag?: string;
  origin?: ArtifactOrigin;
  reviewStatus?: ReviewStatus;
}

export interface ArtifactCatalogState {
  schemaVersion: typeof ARTIFACT_CATALOG_SCHEMA_VERSION;
  artifacts: ArtifactRecord[];
}

export interface ExternalOpenResult {
  ok: boolean;
  relativePath: string;
  absolutePath: string;
  app: ExternalAppKind | "none";
  command?: string;
  message: string;
  /** Fingerprint captured at open for later change detection. */
  baseline?: FileFingerprint;
  stub?: boolean;
}

export interface FileFingerprint {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  modifiedAt: string;
  contentHash: string;
  capturedAt: string;
}

export interface ChangeDetectResult {
  relativePath: string;
  changed: boolean;
  previous?: FileFingerprint;
  current: FileFingerprint;
  reason?: string;
}

export interface RevealResult {
  ok: boolean;
  relativePath: string;
  absolutePath: string;
  message: string;
  stub?: boolean;
}

export interface CopyPathResult {
  relativePath: string;
  absolutePath: string;
  /** Preferred form for clipboard (absolute on desktop). */
  path: string;
}

export interface ExportRequest {
  projectId: string;
  /** Relative paths to include. Empty = catalog selection only. */
  paths: string[];
  /** Destination directory absolute path (must be granted separately or under data dir). */
  destinationDir: string;
  mode?: "copy" | "manifest";
  /** Optional artifact ids to include metadata for. */
  artifactIds?: string[];
}

export interface ExportResult {
  ok: boolean;
  mode: "copy" | "manifest";
  destinationDir: string;
  files: Array<{ relativePath: string; destination: string; bytes: number }>;
  manifestPath?: string;
  message: string;
}

export interface PackageRequest {
  projectId: string;
  paths: string[];
  /** Output .zip absolute path under data/export or workspace .paw/exports. */
  outputPath: string;
  artifactIds?: string[];
  includeManifest?: boolean;
}

export interface PackageResult {
  ok: boolean;
  outputPath: string;
  entryCount: number;
  bytesWritten: number;
  message: string;
  /** When zip is not available, falls back to manifest-only pack. */
  fallbackManifest?: boolean;
}

export interface OfficeAvailability {
  office: boolean;
  wps: boolean;
  detail: string;
  officePath?: string;
  wpsPath?: string;
}

/** Defaults used by preview / browse. */
export const DEFAULT_BROWSE_LIMIT = 500;
export const DEFAULT_TEXT_PREVIEW_BYTES = 256 * 1024;
export const DEFAULT_MAX_TEXT_CHARS = 200_000;
export const DEFAULT_INLINE_BINARY_BYTES = 2 * 1024 * 1024;
export const LARGE_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024;
export const MAX_PACKAGE_ENTRIES = 2000;
export const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
