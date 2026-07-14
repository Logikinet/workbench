/**
 * Coursework composite workflow (Task 34).
 *
 * Composes research + documents + subtasks + verification + review gates into
 * coursework delivery. Mount later from main/app (out of ownership):
 *
 *   import { CourseworkService } from "../coursework/index.js";
 *   const coursework = await CourseworkService.open({
 *     statePath: join(dataDirectory, "coursework.json"),
 *     model: modelProvider,
 *     packageDir: join(workspace, "artifacts", "coursework"),
 *     subtasks: subtaskDagService,
 *     research: researchService,
 *     documents: documentService,
 *   });
 */

export {
  CourseworkService,
  type CourseworkServiceOptions,
  type CreateCourseworkSessionInput,
  type AddEvidenceInput
} from "./courseworkService.js";

export {
  extractSpec,
  extractSpecHeuristic,
  buildSpecContextPack,
  parseSpecModelOutput,
  mergeSpecExtract,
  resolveMissingInfo,
  allCriticalInfoResolved,
  SpecExtractError
} from "./specExtract.js";

export {
  emptyMappings,
  mapFromSpec,
  addMappingTarget,
  bindEvidenceToScoringMap,
  recomputeCovered,
  hasStrongCoverage,
  evaluateScoringCoverage,
  coverageSummary,
  bestMappingStrength
} from "./scoringMap.js";

export {
  buildHeuristicPlan,
  planCoursework,
  buildPlanContextPack,
  parsePlanModelOutput,
  mergePlan,
  buildScopePolicy,
  toCreateDagFields,
  PlanCourseworkError
} from "./planCoursework.js";

export {
  FAKE_UI_PATTERNS,
  checkConsistency,
  checkSessionConsistency,
  detectFakeUiText,
  consistencyOk,
  type ReportClaim,
  type ConsistencyCheckInput
} from "./consistencyGates.js";

export {
  buildReadmeMarkdown,
  buildRunInstructions,
  buildDependenciesMarkdown,
  buildManifestJson,
  buildScoringMapMarkdown,
  buildDeliveryPackage,
  writeDeliveryPackage,
  deliveryCompleteness,
  packageContentHash,
  describeScope,
  DELIVERY_ZIP_KIND,
  DELIVERY_README_KIND,
  DELIVERY_MANIFEST_KIND,
  type DeliveryPackageInput,
  type DeliveryPackageResult
} from "./deliveryPackage.js";

export {
  reviewCourseworkRules,
  reviewCoursework,
  buildReviewContextPack,
  parseReviewModelOutput,
  mergeReview,
  reviewMayAwaitUserAccept,
  mayArchiveComplete,
  NoMistakesReviewError
} from "./noMistakesReview.js";

export type {
  CourseworkSessionStatus,
  ScoringPointCategory,
  ScoringMappingKind,
  CourseworkEvidenceKind,
  ConsistencyFindingKind,
  ConsistencySeverity,
  ReviewSeverity,
  FunctionalRequirement,
  ScoringPoint,
  Prohibition,
  DeliveryFormatSpec,
  MissingCriticalInfo,
  SpecExtractResult,
  ScoringMappingTarget,
  ScoringPointMapping,
  ProjectScopePolicy,
  ConsistencyFinding,
  CourseworkEvidenceItem,
  DeliveryPackageManifest,
  NoMistakesFinding,
  NoMistakesReviewResult,
  CourseworkArtifactDescriptor,
  CourseworkSession,
  CourseworkStateFile,
  SpecExtractModelOutput,
  PlanModelOutput,
  CourseworkSubtaskKind,
  BuiltPlan,
  ConsistencyCheckResult,
  ScoringCoverageResult
} from "./courseworkTypes.js";
