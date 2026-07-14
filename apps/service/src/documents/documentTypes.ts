/**
 * Document / paper writing workflow types (Task 33).
 *
 * Reuses ResearchEvidence for grounding. Original materials and AI-generated
 * content are always distinguished via contentOrigin / material kind.
 */

import type { ResearchEvidence } from "../research/researchTypes.js";

/** How material entered the document pack. */
export type MaterialKind =
  | "template"
  | "user_material"
  | "project_fact"
  | "evidence"
  | "generated";

export type MaterialFormat = "markdown" | "docx" | "pdf" | "plain" | "json";

/** Original (imported / user) vs AI-generated content. */
export type ContentOrigin = "original" | "generated";

export interface DocumentMaterial {
  id: string;
  title: string;
  kind: MaterialKind;
  format: MaterialFormat;
  contentOrigin: ContentOrigin;
  /** Extracted or provided text body. */
  text: string;
  sourcePath?: string;
  /** Link to ResearchEvidence when imported from research. */
  evidenceId?: string;
  metadata?: Record<string, unknown>;
  contentHash: string;
  createdAt: string;
}

export type OutlineSectionStatus =
  | "planned"
  | "approved"
  | "writing"
  | "written"
  | "revised";

export interface OutlineSection {
  id: string;
  title: string;
  order: number;
  summary: string;
  /** Bound document material ids. */
  materialIds: string[];
  /** Bound ResearchEvidence ids. */
  evidenceIds: string[];
  acceptanceCriteria: string[];
  missingData: string[];
  status: OutlineSectionStatus;
}

export type OutlineStatus = "draft" | "awaiting_approval" | "approved" | "rejected";

export interface DocumentOutline {
  id: string;
  title: string;
  summary: string;
  sections: OutlineSection[];
  /** Session-level gaps the writer must not invent. */
  missingDataList: string[];
  acceptanceCriteria: string[];
  status: OutlineStatus;
  generatedAt: string;
  approvedAt?: string;
  rejectedReason?: string;
}

export interface ChapterVersion {
  version: number;
  body: string;
  /** Citation keys used in this version (e.g. "Smith2024"). */
  citationKeys: string[];
  evidenceIds: string[];
  materialIds: string[];
  createdAt: string;
  changeSummary?: string;
  /** contentOrigin is always generated for chapter bodies. */
  contentOrigin: "generated";
}

export interface DataPoint {
  key: string;
  value: string;
  evidenceId?: string;
  materialId?: string;
}

export interface Chapter {
  id: string;
  sectionId: string;
  title: string;
  currentVersion: number;
  versions: ChapterVersion[];
  /** Term → canonical form used in this chapter. */
  terminology: Record<string, string>;
  dataPoints: DataPoint[];
}

/** Supported bibliography styles (at least one common format). */
export type BibliographyStyle = "apa" | "ieee" | "gb7714";

export interface Citation {
  id: string;
  /** Stable key used in body, e.g. Smith2024 or ref1. */
  key: string;
  evidenceId?: string;
  materialId?: string;
  title: string;
  author?: string;
  source: string;
  publishedAt?: string;
  accessedAt?: string;
  locator?: string;
}

export type ConsistencySeverity = "info" | "warning" | "error";

export interface ConsistencyIssue {
  id: string;
  kind: "terminology" | "data_point" | "citation" | "fabricated" | "version";
  severity: ConsistencySeverity;
  message: string;
  chapterIds?: string[];
  term?: string;
  expected?: string;
  actual?: string;
}

export type DocumentSessionStatus =
  | "collecting_materials"
  | "outlining"
  | "awaiting_outline_approval"
  | "writing"
  | "reviewing"
  | "exported"
  | "needs_rereview"
  | "completed";

export interface ExportedArtifact {
  path: string;
  format: "markdown" | "docx" | "pdf";
  contentHash: string;
  exportedAt: string;
  sizeBytes: number;
  kind: string;
}

export interface ExternalEditWatch {
  path: string;
  lastKnownHash: string;
  lastKnownMtimeMs?: number;
  lastKnownSize?: number;
  changed: boolean;
  detectedAt?: string;
  rereviewTriggered: boolean;
}

export interface DocumentArtifactDescriptor {
  path: string;
  kind: string;
  summary: string;
}

export interface DocumentSession {
  id: string;
  runId?: string;
  projectId?: string;
  researchSessionId?: string;
  title: string;
  goal: string;
  status: DocumentSessionStatus;
  bibliographyStyle: BibliographyStyle;
  materials: DocumentMaterial[];
  outline?: DocumentOutline;
  chapters: Chapter[];
  citations: Citation[];
  exports: ExportedArtifact[];
  externalWatches: ExternalEditWatch[];
  consistencyIssues: ConsistencyIssue[];
  /** Snapshots of ResearchEvidence bound for writing. */
  evidence: ResearchEvidence[];
  projectFacts: string[];
  artifacts: DocumentArtifactDescriptor[];
  createdAt: string;
  updatedAt: string;
}

export interface DocumentStateFile {
  schemaVersion: 1;
  sessions: DocumentSession[];
}

export interface VersionDiff {
  chapterId: string;
  fromVersion: number;
  toVersion: number;
  addedLines: string[];
  removedLines: string[];
  unchangedCount: number;
  summary: string;
}

export interface CitationCheckFinding {
  citationKey: string;
  chapterId?: string;
  met: boolean;
  reason: string;
  severity: ConsistencySeverity;
}

export interface CitationCheckResult {
  ok: boolean;
  findings: CitationCheckFinding[];
  bibliography: string;
  style: BibliographyStyle;
}

export interface OutlineModelOutput {
  title: string;
  summary: string;
  sections: Array<{
    title: string;
    summary: string;
    materialIds?: string[];
    evidenceIds?: string[];
    acceptanceCriteria?: string[];
    missingData?: string[];
  }>;
  missingDataList?: string[];
  acceptanceCriteria?: string[];
}

export interface ChapterModelOutput {
  body: string;
  citationKeys?: string[];
  evidenceIds?: string[];
  materialIds?: string[];
  terminology?: Record<string, string>;
  dataPoints?: DataPoint[];
  /** Explicit list of claims the model could not support — must not invent. */
  unsupportedClaims?: string[];
}

export interface WriteChapterResult {
  session: DocumentSession;
  chapter: Chapter;
  blocked: boolean;
  blockReasons: string[];
}

export interface ExportBundleResult {
  session: DocumentSession;
  markdown: string;
  docx: Buffer;
  pdf: Buffer;
  artifacts: ExportedArtifact[];
}

export { type ResearchEvidence };
