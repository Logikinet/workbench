/**
 * Document Workflow domain model (Task 50).
 * Report/thesis pipeline: outline → sources → writing → DOCX → review → export.
 */

export const documentJobStatuses = [
  "draft",
  "gathering_sources",
  "awaiting_outline_approval",
  "writing",
  "generating_docx",
  "reviewing",
  "awaiting_citation_finalize",
  "awaiting_manual_format",
  "final_review",
  "completed",
  "paused",
  "failed"
] as const;

export type DocumentJobStatus = (typeof documentJobStatuses)[number];

export const documentTypes = [
  "course_report",
  "academic_paper",
  "business_plan",
  "research_report",
  "lab_report",
  "custom"
] as const;

export type DocumentType = (typeof documentTypes)[number];

export type CitationMode = "dynamic_zotero" | "static";

export type BibliographyStyle = "apa" | "ieee" | "gb7714";

export interface DocumentRequirement {
  title: string;
  documentType: DocumentType;
  assignmentBrief: string;
  schoolOrContest?: string;
  targetWordCount?: number;
  sectionRequirements?: string[];
  deadline?: string;
  outputDir?: string;
  templatePath?: string;
  zoteroCollectionKey?: string;
  zoteroLibraryPath?: string;
  citationMode: CitationMode;
  bibliographyStyle: BibliographyStyle;
  yearFrom?: number;
  yearTo?: number;
  requireDoi?: boolean;
  mustNotInvent: string[];
  formatNotes?: string;
}

export interface SectionPlan {
  id: string;
  title: string;
  order: number;
  targetWords: number;
  coreClaims: string[];
  requiredEvidence: string[];
  plannedItemKeys: string[];
  figureNotes?: string[];
  status: "planned" | "approved" | "writing" | "written" | "reviewed" | "locked";
  draftPath?: string;
  draftBody?: string;
  version: number;
}

export interface CitationEvidenceLink {
  itemKey: string;
  quote: string;
  location?: string;
  supportLevel: "direct" | "indirect" | "background";
}

export interface CitationMapEntry {
  claimId: string;
  claim: string;
  sourceItems: string[];
  evidence: CitationEvidenceLink[];
  sectionId?: string;
  invented: false;
}

export interface CitationMap {
  mode: CitationMode;
  entries: CitationMapEntry[];
  unresolvedClaims: string[];
  verifiedItemKeys: string[];
  updatedAt: string;
}

export interface DocumentVersion {
  id: string;
  kind: "auto" | "manual" | "export";
  label: string;
  path: string;
  contentHash: string;
  createdAt: string;
  note?: string;
}

export type DocumentReviewKind = "content" | "citation" | "format";

export interface DocumentReviewFinding {
  id: string;
  kind: DocumentReviewKind;
  severity: "info" | "warn" | "error";
  message: string;
  sectionId?: string;
  claimId?: string;
  itemKey?: string;
}

export interface DocumentReview {
  id: string;
  cycle: number;
  findings: DocumentReviewFinding[];
  passed: boolean;
  summary: string;
  createdAt: string;
}

export interface DocumentSourceRef {
  itemKey: string;
  title: string;
  doi?: string;
  excerpt: string;
  missingMetadata: string[];
}

export interface DocumentJobManifest {
  schemaVersion: 1;
  jobId: string;
  runId?: string;
  projectId?: string;
  rootDir: string;
  status: DocumentJobStatus;
  requirement: DocumentRequirement;
  outlineTitle?: string;
  outlineSummary?: string;
  sections: SectionPlan[];
  sources: DocumentSourceRef[];
  citationMap: CitationMap;
  versions: DocumentVersion[];
  reviews: DocumentReview[];
  officeOperations: Array<Record<string, unknown>>;
  currentDocxPath?: string;
  currentPdfPath?: string;
  dynamicCitationsPresent: boolean;
  manualEditPending: boolean;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentJobStateFile {
  schemaVersion: 1;
  jobs: DocumentJobManifest[];
}

export const DOCUMENT_STATUS_TRANSITIONS: Record<DocumentJobStatus, DocumentJobStatus[]> = {
  draft: ["gathering_sources", "paused", "failed"],
  gathering_sources: ["awaiting_outline_approval", "paused", "failed"],
  awaiting_outline_approval: ["writing", "gathering_sources", "paused", "failed"],
  writing: ["generating_docx", "awaiting_outline_approval", "paused", "failed"],
  generating_docx: ["reviewing", "writing", "awaiting_manual_format", "final_review", "paused", "failed"],
  reviewing: ["awaiting_citation_finalize", "generating_docx", "writing", "awaiting_manual_format", "final_review", "paused", "failed"],
  awaiting_citation_finalize: ["awaiting_manual_format", "reviewing", "final_review", "paused", "failed"],
  awaiting_manual_format: ["final_review", "awaiting_citation_finalize", "reviewing", "paused", "failed"],
  final_review: ["completed", "reviewing", "awaiting_manual_format", "paused", "failed"],
  completed: [],
  paused: [
    "draft",
    "gathering_sources",
    "awaiting_outline_approval",
    "writing",
    "generating_docx",
    "reviewing",
    "awaiting_citation_finalize",
    "awaiting_manual_format",
    "final_review",
    "failed"
  ],
  failed: ["draft", "paused"]
};

export function canTransition(from: DocumentJobStatus, to: DocumentJobStatus): boolean {
  if (from === to) return true;
  return DOCUMENT_STATUS_TRANSITIONS[from]?.includes(to) === true;
}
