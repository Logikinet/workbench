/**
 * Evidence-first research workflow types (Task 32).
 *
 * Facts/conclusions bind to Evidence. AI inference and user materials use
 * distinct origin markers and are never silently promoted to final facts.
 */

/** How a piece of material entered the research pack. */
export const evidenceOrigins = [
  "web",
  "pdf",
  "user_material",
  "ai_inference",
  "manual"
] as const;
export type EvidenceOrigin = (typeof evidenceOrigins)[number];

/** Quality / trust flags — flagged items must not auto-become final facts. */
export const evidenceQualityFlags = [
  "duplicate",
  "stale",
  "invalid",
  "low_trust",
  "unreachable",
  "paywalled",
  "conflicted"
] as const;
export type EvidenceQualityFlag = (typeof evidenceQualityFlags)[number];

export type EvidenceStatus = "active" | "flagged" | "excluded";

/** Locator for an excerpt inside a source document or page. */
export interface EvidenceLocation {
  /** Page number (1-based) for PDFs. */
  page?: number;
  /** Paragraph index or CSS/DOM path for HTML. */
  paragraph?: number;
  selector?: string;
  /** Character offsets into the source body (inclusive start, exclusive end). */
  charStart?: number;
  charEnd?: number;
  /** Human-readable anchor, e.g. "§2.1" or "Results table". */
  anchor?: string;
}

/**
 * Traceable Evidence unit. Required fields for title/source/access/excerpt
 * enable Reviewer citation checks.
 */
export interface ResearchEvidence {
  id: string;
  title: string;
  author?: string;
  /** Canonical URL, file path, or synthetic id. */
  source: string;
  publishedAt?: string;
  accessedAt: string;
  /** Verbatim excerpt (原文摘录). */
  excerpt: string;
  location?: EvidenceLocation;
  origin: EvidenceOrigin;
  /** Content hash used for dedup (normalized excerpt / body). */
  contentHash: string;
  status: EvidenceStatus;
  qualityFlags: EvidenceQualityFlag[];
  trustScore: number;
  /** Optional full-text body retained for support checks (bounded). */
  body?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type ClaimKind = "fact" | "conclusion" | "ai_inference" | "user_material";

/**
 * A claim that may become a research finding.
 * Facts and conclusions must bind Evidence ids when forceEvidenceMode is on.
 */
export interface ResearchClaim {
  id: string;
  text: string;
  kind: ClaimKind;
  /** Bound Evidence ids — empty only when kind is ai_inference (explicit) or force mode off. */
  evidenceIds: string[];
  /** Origin marker for provenance badges (distinct from evidence origin). */
  originMarker: "source_backed" | "ai_inference" | "user_material";
  /** Whether this claim is eligible as a final fact for research.md. */
  finalFactEligible: boolean;
  notes?: string;
  createdAt: string;
}

export interface ConflictingViewpoint {
  id: string;
  topic: string;
  positions: Array<{
    claimId: string;
    summary: string;
    evidenceIds: string[];
  }>;
  resolution?: "unresolved" | "prefer_higher_trust" | "present_both" | "user_decided";
  notes?: string;
}

export interface StructuredSource {
  id: string;
  title: string;
  author?: string;
  source: string;
  publishedAt?: string;
  accessedAt: string;
  origin: EvidenceOrigin;
  evidenceIds: string[];
  qualityFlags: EvidenceQualityFlag[];
  trustScore: number;
  /** First-seen evidence id (canonical after dedup). */
  canonicalEvidenceId: string;
  duplicateOf?: string;
}

export type ResearchStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface ResearchStep {
  id: string;
  question: string;
  /** Steps with no overlapping write targets may run in parallel. */
  parallelGroup?: string;
  status: ResearchStepStatus;
  evidenceIds: string[];
  claimIds: string[];
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export type ResearchSessionStatus =
  | "planning"
  | "gathering"
  | "aggregating"
  | "ready_for_review"
  | "completed"
  | "failed";

export interface ResearchArtifactDescriptor {
  path: string;
  kind: string;
  summary: string;
}

export interface ResearchSession {
  id: string;
  runId?: string;
  projectId?: string;
  title: string;
  goal: string;
  /** When false, creative tasks may omit evidence binding (ticket comment). */
  forceEvidenceMode: boolean;
  status: ResearchSessionStatus;
  subQuestions: string[];
  steps: ResearchStep[];
  evidence: ResearchEvidence[];
  claims: ResearchClaim[];
  sources: StructuredSource[];
  conflicts: ConflictingViewpoint[];
  artifacts: ResearchArtifactDescriptor[];
  /** True after dedup + conflict organization completed. */
  aggregated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchStateFile {
  schemaVersion: 1;
  sessions: ResearchSession[];
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  author?: string;
}

export interface WebPageContent {
  url: string;
  title: string;
  author?: string;
  publishedAt?: string;
  text: string;
  fetchedAt: string;
  statusCode?: number;
  contentType?: string;
}

export interface PdfImportMetadata {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modDate?: string;
  pageCount?: number;
  keywords?: string[];
}

export interface PdfImportResult {
  path: string;
  metadata: PdfImportMetadata;
  /** Page-level text samples for excerpt + location. */
  pages: Array<{ page: number; text: string }>;
  importedAt: string;
}

/** Reviewer evidence check — hard gate when forceEvidenceMode is on. */
export interface ReviewerEvidenceFinding {
  claimId: string;
  claimText: string;
  met: boolean;
  reason: string;
  evidenceIds: string[];
  severity: "none" | "low" | "medium" | "high" | "critical";
}

export interface ReviewerEvidenceCheckResult {
  ok: boolean;
  forceEvidenceMode: boolean;
  findings: ReviewerEvidenceFinding[];
  summary: string;
  /** Paths/ids the Reviewer should open for spot-check. */
  sampleEvidenceIds: string[];
  insufficientEvidence: boolean;
}

export interface AggregateResult {
  session: ResearchSession;
  duplicatesMerged: number;
  conflictsFound: number;
  flaggedExcludedFromFacts: number;
}

export interface ProduceArtifactsResult {
  session: ResearchSession;
  researchMarkdown: string;
  sourcesJson: string;
  evidenceCatalogMarkdown: string;
  artifacts: ResearchArtifactDescriptor[];
}
