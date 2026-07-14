/**
 * Evidence-first research workflow (Task 32).
 *
 * Mount later from main/app (out of ownership):
 *
 *   import { ResearchService } from "../research/index.js";
 *   const research = await ResearchService.open({
 *     statePath: join(dataDirectory, "research.json"),
 *     search: webSearchPort,
 *     fetch: webFetchPort,
 *   });
 */

export {
  ResearchService,
  type ResearchServiceOptions,
  type CreateResearchSessionInput,
  type AddClaimInput
} from "./researchService.js";

export {
  FakeWebSearch,
  FakeWebFetch,
  WebToolError,
  normalizeSourceUrl,
  stripHtml,
  extractTitleFromHtml,
  type WebSearchPort,
  type WebFetchPort,
  type WebSearchOptions,
  type WebFetchOptions
} from "./webTools.js";

export {
  extractPdfMetadataFromBytes,
  parsePdfDate,
  importPdf,
  importPdfFromBytes,
  buildMinimalPdf,
  FakePdfPageExtractor,
  EmptyPdfPageExtractor,
  PdfImportError,
  type PdfPageExtractor,
  type PdfImportOptions
} from "./pdfImport.js";

export {
  createEvidence,
  createClaim,
  evidenceFromWebPage,
  markEvidence,
  canUseAsFinalFact,
  evidenceSupportsClaim,
  reevaluateClaimEligibility,
  hashContent,
  clipExcerpt,
  defaultTrustScore,
  BLOCKING_QUALITY_FLAGS,
  EvidenceBindingError,
  originMarkerForClaim
} from "./evidence.js";

export {
  splitResearchQuestions,
  createStepsFromQuestions,
  startStep,
  completeStep,
  frontierParallelSteps,
  deduplicateEvidence,
  remapClaimEvidenceIds,
  buildStructuredSources,
  organizeConflicts,
  aggregateSession,
  assertAggregated
} from "./researchWorkflow.js";

export {
  buildResearchMarkdown,
  buildSourcesList,
  buildSourcesJson,
  buildEvidenceCatalogMarkdown,
  produceResearchArtifacts,
  writeResearchArtifacts,
  RESEARCH_MD_PATH,
  SOURCES_JSON_PATH,
  EVIDENCE_CATALOG_PATH,
  RESEARCH_ARTIFACT_KIND,
  SOURCES_ARTIFACT_KIND,
  EVIDENCE_CATALOG_KIND,
  type ArtifactWriter
} from "./researchArtifacts.js";

export {
  checkResearchEvidence,
  toReviewerFindingRows,
  researchReviewMayPass,
  type ReviewerEvidenceCheckOptions
} from "./reviewerEvidenceHooks.js";

export type {
  EvidenceOrigin,
  EvidenceQualityFlag,
  EvidenceStatus,
  EvidenceLocation,
  ResearchEvidence,
  ClaimKind,
  ResearchClaim,
  ConflictingViewpoint,
  StructuredSource,
  ResearchStepStatus,
  ResearchStep,
  ResearchSessionStatus,
  ResearchArtifactDescriptor,
  ResearchSession,
  ResearchStateFile,
  WebSearchHit,
  WebPageContent,
  PdfImportMetadata,
  PdfImportResult,
  ReviewerEvidenceFinding,
  ReviewerEvidenceCheckResult,
  AggregateResult,
  ProduceArtifactsResult
} from "./researchTypes.js";

export { evidenceOrigins, evidenceQualityFlags } from "./researchTypes.js";
