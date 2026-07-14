import { detectProjectStack } from "./detectProjectStack.js";
import {
  applyUserVerificationEdits,
  bindVerificationPlanToApprovedVersion,
  enabledVerificationCommands,
  proposeVerificationPlan
} from "./proposeVerification.js";
import { assertOnlyApprovedCommands, checkApprovedExecution } from "./approvedExecution.js";
import { buildVerificationEvidence, toVerificationEvidenceRows } from "./verificationEvidence.js";
import type {
  ApplyUserEditsInput,
  DetectedProjectStack,
  ProposeVerificationInput,
  VerificationEvidence,
  VerificationPlan,
  VerificationResultRow,
  VerificationTaskType
} from "./types.js";

export interface ProposeFromWorkspaceInput {
  workspacePath: string;
  taskType?: VerificationTaskType;
  userCommands?: string[][];
  disabledCommands?: string[][];
  supplementalCommands?: string[][];
  userConstraints?: string;
}

/**
 * Facade for project-aware verification (Ticket 25).
 * Pure orchestration over detect / propose / bind / evidence helpers.
 */
export class VerificationService {
  async detect(workspacePath: string): Promise<DetectedProjectStack> {
    return detectProjectStack(workspacePath);
  }

  async proposeFromWorkspace(input: ProposeFromWorkspaceInput): Promise<VerificationPlan> {
    const stack = await detectProjectStack(input.workspacePath);
    return proposeVerificationPlan({
      stack,
      taskType: input.taskType,
      userCommands: input.userCommands,
      disabledCommands: input.disabledCommands,
      supplementalCommands: input.supplementalCommands,
      userConstraints: input.userConstraints
    });
  }

  propose(input: ProposeVerificationInput): VerificationPlan {
    return proposeVerificationPlan(input);
  }

  applyUserEdits(input: ApplyUserEditsInput): VerificationPlan {
    return applyUserVerificationEdits(input);
  }

  bindToApprovedPlan(plan: VerificationPlan, approvedPlanVersion: number): VerificationPlan {
    return bindVerificationPlanToApprovedVersion(plan, approvedPlanVersion);
  }

  enabledCommands(plan: VerificationPlan): string[][] {
    return enabledVerificationCommands(plan);
  }

  checkExecution(requested: string[][], approved: string[][] | VerificationPlan) {
    return checkApprovedExecution(requested, approved);
  }

  assertExecution(requested: string[][], approved: string[][] | VerificationPlan): string[][] {
    return assertOnlyApprovedCommands(requested, approved);
  }

  buildEvidence(input: {
    results: VerificationResultRow[];
    stackPrimary: VerificationPlan["stack"]["primary"];
    planVersion?: number;
    plan?: VerificationPlan;
    recordedAt?: string;
  }): VerificationEvidence {
    return buildVerificationEvidence({
      results: input.results,
      stackPrimary: input.stackPrimary,
      planVersion: input.planVersion ?? input.plan?.approvedPlanVersion,
      manualChecklist: input.plan?.manualChecklist,
      recordedAt: input.recordedAt
    });
  }

  toEvidenceRows(results: VerificationResultRow[]) {
    return toVerificationEvidenceRows(results);
  }
}

export function createVerificationService(): VerificationService {
  return new VerificationService();
}
