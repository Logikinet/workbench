/**
 * Coursework composite workflow types (Task 34).
 *
 * Composes research + documents + subtasks + verification + review gates into
 * a full coursework delivery pack. Reuses sibling module types as clients.
 */

import type { ExplicitSubtaskDef, TaskType } from "../subtasks/subtaskTypes.js";
import type { ResearchEvidence } from "../research/researchTypes.js";
import type { VerificationEvidence } from "../verification/types.js";

export type CourseworkSessionStatus =
  | "collecting_inputs"
  | "spec_extracted"
  | "awaiting_plan_approval"
  | "executing"
  | "mapping_evidence"
  | "reviewing"
  | "awaiting_user_accept"
  | "packaging"
  | "completed"
  | "failed"
  | "cancelled";

export type ScoringPointCategory =
  | "function"
  | "code"
  | "test"
  | "docs"
  | "demo"
  | "other";

export type ScoringMappingKind =
  | "implementation_file"
  | "run_evidence"
  | "report_chapter"
  | "screenshot"
  | "test_record";

export type CourseworkEvidenceKind =
  | "screenshot"
  | "test_record"
  | "run_log"
  | "verification"
  | "research"
  | "document"
  | "file"
  | "implementation";

export type ConsistencyFindingKind =
  | "fake_ui"
  | "report_mismatch"
  | "missing_evidence"
  | "scope_violation"
  | "test_gap"
  | "scoring_uncovered";

export type ConsistencySeverity = "error" | "warning" | "info";

export type ReviewSeverity = "none" | "low" | "medium" | "high" | "critical";

export interface FunctionalRequirement {
  id: string;
  text: string;
  /** Excerpt or section label from the assignment brief. */
  source?: string;
}

export interface ScoringPoint {
  id: string;
  title: string;
  description: string;
  maxScore?: number;
  category: ScoringPointCategory;
}

export interface Prohibition {
  id: string;
  text: string;
}

export interface DeliveryFormatSpec {
  /** e.g. source, report-pdf, zip, readme, screenshots */
  formats: string[];
  notes?: string;
}

export interface MissingCriticalInfo {
  id: string;
  question: string;
  reason: string;
  resolved: boolean;
  answer?: string;
}

/** Parsed assignment brief (任务书). */
export interface SpecExtractResult {
  functionalRequirements: FunctionalRequirement[];
  scoringPoints: ScoringPoint[];
  prohibitions: Prohibition[];
  deliveryFormat: DeliveryFormatSpec;
  missingCriticalInfo: MissingCriticalInfo[];
  rawSummary: string;
  extractedAt: string;
}

export interface ScoringMappingTarget {
  kind: ScoringMappingKind;
  /** Path, evidence id, chapter id, or command summary. */
  ref: string;
  note?: string;
}

/** Each scoring point must map to impl files, run evidence, or report chapters. */
export interface ScoringPointMapping {
  scoringPointId: string;
  targets: ScoringMappingTarget[];
  covered: boolean;
}

/**
 * Minimal-modification policy for existing projects.
 * Greenfield projects use empty retainedFeatures / full allowed scope.
 */
export interface ProjectScopePolicy {
  mode: "greenfield" | "minimal_modify";
  retainedFeatures: string[];
  allowedModificationScope: string[];
  forbiddenPaths: string[];
}

export interface ConsistencyFinding {
  id: string;
  severity: ConsistencySeverity;
  kind: ConsistencyFindingKind;
  message: string;
  refs?: string[];
}

export interface CourseworkEvidenceItem {
  id: string;
  kind: CourseworkEvidenceKind;
  title: string;
  path?: string;
  contentHash?: string;
  relatedScoringPointIds: string[];
  relatedRequirementIds: string[];
  /**
   * True when item is a placeholder / shell UI claim without real functionality.
   * Fake UI must never satisfy scoring coverage.
   */
  isPlaceholder?: boolean;
  /** Optional link to ResearchEvidence id. */
  researchEvidenceId?: string;
  /** Optional structured verification bundle (Task 25). */
  verification?: VerificationEvidence;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryPackageManifest {
  projectRunnable: boolean;
  readmePath?: string;
  runInstructionsPath?: string;
  dependencyNotesPath?: string;
  testRecords: string[];
  screenshots: string[];
  reportPaths: string[];
  zipPath?: string;
  zipContentHash?: string;
  entries: string[];
  createdAt: string;
}

export interface NoMistakesFinding {
  criterion: string;
  met: boolean;
  evidence: string;
  severity: ReviewSeverity;
  fixScope?: string;
}

/**
 * /no-mistakes comprehensive review gates for coursework delivery.
 */
export interface NoMistakesReviewResult {
  conclusion: "passed" | "changes_requested";
  summary: string;
  scoringCoverageOk: boolean;
  featureRegressionOk: boolean;
  dataAuthenticityOk: boolean;
  deliveryCompletenessOk: boolean;
  findings: NoMistakesFinding[];
  residualRisks: string[];
  reviewedAt: string;
  reviewSource: "rules" | "model" | "rules+model";
}

export interface CourseworkArtifactDescriptor {
  path: string;
  kind: string;
  summary: string;
}

export interface CourseworkSession {
  id: string;
  runId?: string;
  projectId?: string;
  title: string;
  goal: string;
  status: CourseworkSessionStatus;
  /** Full assignment brief text (任务书). */
  assignmentBrief: string;
  /** Notes / inventory of an existing project when present. */
  existingProjectNotes?: string;
  spec?: SpecExtractResult;
  scopePolicy: ProjectScopePolicy;
  /** Secondmate-planned explicit subtasks (Task 21 shape). */
  planSubtasks: ExplicitSubtaskDef[];
  planApproved: boolean;
  planApprovedAt?: string;
  /** Optional DAG id when wired to SubtaskDagService. */
  dagId?: string;
  scoringMap: ScoringPointMapping[];
  evidence: CourseworkEvidenceItem[];
  consistencyFindings: ConsistencyFinding[];
  /** Optional linked research session (Task 32). */
  researchSessionId?: string;
  /** Optional linked document session (Task 33). */
  documentSessionId?: string;
  /** Bound ResearchEvidence snapshots for local gates. */
  researchEvidence: ResearchEvidence[];
  verificationSummary?: string;
  review?: NoMistakesReviewResult;
  delivery?: DeliveryPackageManifest;
  /** Final archive requires explicit user accept. */
  userAccepted: boolean;
  userAcceptedAt?: string;
  artifacts: CourseworkArtifactDescriptor[];
  createdAt: string;
  updatedAt: string;
}

export interface CourseworkStateFile {
  schemaVersion: 1;
  sessions: CourseworkSession[];
}

/** Optional model JSON for richer spec extraction. */
export interface SpecExtractModelOutput {
  functionalRequirements?: Array<{ text: string; source?: string }>;
  scoringPoints?: Array<{
    title: string;
    description?: string;
    maxScore?: number;
    category?: ScoringPointCategory;
  }>;
  prohibitions?: Array<{ text: string }>;
  deliveryFormats?: string[];
  deliveryNotes?: string;
  missingCriticalInfo?: Array<{ question: string; reason?: string }>;
  summary?: string;
}

export interface PlanModelOutput {
  subtasks?: Array<{
    id?: string;
    title: string;
    description?: string;
    kind?: "research" | "development" | "testing" | "materials" | "documentation";
    dependsOn?: string[];
    acceptanceCriteria?: string[];
    accessMode?: "read_only" | "write";
  }>;
  scopePolicy?: {
    mode?: "greenfield" | "minimal_modify";
    retainedFeatures?: string[];
    allowedModificationScope?: string[];
    forbiddenPaths?: string[];
  };
}

export type CourseworkSubtaskKind =
  | "research"
  | "development"
  | "testing"
  | "materials"
  | "documentation";

export interface BuiltPlan {
  subtasks: ExplicitSubtaskDef[];
  scopePolicy: ProjectScopePolicy;
  taskType: TaskType;
}

export interface ConsistencyCheckResult {
  ok: boolean;
  findings: ConsistencyFinding[];
}

export interface ScoringCoverageResult {
  ok: boolean;
  mappings: ScoringPointMapping[];
  uncoveredIds: string[];
}
