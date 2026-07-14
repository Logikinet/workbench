export type {
  ApplyUserEditsInput,
  AvailableScript,
  DetectedProjectStack,
  ManualChecklistEvidence,
  ManualChecklistItem,
  PackageManager,
  ProjectStackClue,
  ProjectStackKind,
  ProposeVerificationInput,
  VerificationCommandEntry,
  VerificationCommandSource,
  VerificationEvidence,
  VerificationEvidenceRow,
  VerificationPlan,
  VerificationPlanStatus,
  VerificationResultRow,
  VerificationTaskType
} from "./types.js";

export { detectProjectStack } from "./detectProjectStack.js";
export {
  applyUserVerificationEdits,
  bindVerificationPlanToApprovedVersion,
  defaultVerificationCommandsForTaskType,
  enabledVerificationCommands,
  proposeVerificationPlan
} from "./proposeVerification.js";
export { sameCommand } from "./commandMatch.js";
export {
  assertOnlyApprovedCommands,
  checkApprovedExecution,
  type ApprovedExecutionCheck
} from "./approvedExecution.js";
export {
  buildVerificationEvidence,
  summarizeVerificationEvidence,
  toVerificationEvidenceRows
} from "./verificationEvidence.js";
export {
  VerificationService,
  createVerificationService,
  type ProposeFromWorkspaceInput
} from "./verificationService.js";
export {
  registerVerificationRoutes,
  type VerificationRouteDeps,
  type VerificationRouteProjects,
  type VerificationRouteRuns,
  type VerificationRouteTodos
} from "./verificationRoutes.js";
export { taskTypes } from "./taskTypes.js";
