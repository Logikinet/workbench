/**
 * Structural diffs between Secondmate plan versions (Task 19 plan revision).
 */

export interface PlanVersionLike {
  version: number;
  summary: string;
  steps?: string[];
  acceptanceCriteria?: string[];
  risks?: string[];
  prohibitions?: string[];
  dependencies?: string[];
  expectedArtifacts?: string[];
  allowedScope?: string[];
  verificationMethods?: string[];
  complexity?: string;
}

export interface PlanVersionDiff {
  fromVersion: number;
  toVersion: number;
  summaryChanged: boolean;
  complexityChanged: boolean;
  stepsAdded: string[];
  stepsRemoved: string[];
  acceptanceAdded: string[];
  acceptanceRemoved: string[];
  risksAdded: string[];
  risksRemoved: string[];
  prohibitionsAdded: string[];
  prohibitionsRemoved: string[];
  dependenciesAdded: string[];
  dependenciesRemoved: string[];
  expectedArtifactsAdded: string[];
  expectedArtifactsRemoved: string[];
  allowedScopeAdded: string[];
  allowedScopeRemoved: string[];
  verificationMethodsAdded: string[];
  verificationMethodsRemoved: string[];
  /** Total discrete field-level change count (for "substantial" checks). */
  changedFieldCount: number;
}

export function computePlanVersionDiff(previous: PlanVersionLike, next: PlanVersionLike): PlanVersionDiff {
  const steps = listDiff(previous.steps, next.steps);
  const acceptance = listDiff(previous.acceptanceCriteria, next.acceptanceCriteria);
  const risks = listDiff(previous.risks, next.risks);
  const prohibitions = listDiff(previous.prohibitions, next.prohibitions);
  const dependencies = listDiff(previous.dependencies, next.dependencies);
  const expectedArtifacts = listDiff(previous.expectedArtifacts, next.expectedArtifacts);
  const allowedScope = listDiff(previous.allowedScope, next.allowedScope);
  const verificationMethods = listDiff(previous.verificationMethods, next.verificationMethods);
  const summaryChanged = (previous.summary ?? "").trim() !== (next.summary ?? "").trim();
  const complexityChanged = (previous.complexity ?? "") !== (next.complexity ?? "");

  const changedFieldCount =
    (summaryChanged ? 1 : 0)
    + (complexityChanged ? 1 : 0)
    + steps.added.length
    + steps.removed.length
    + acceptance.added.length
    + acceptance.removed.length
    + risks.added.length
    + risks.removed.length
    + prohibitions.added.length
    + prohibitions.removed.length
    + dependencies.added.length
    + dependencies.removed.length
    + expectedArtifacts.added.length
    + expectedArtifacts.removed.length
    + allowedScope.added.length
    + allowedScope.removed.length
    + verificationMethods.added.length
    + verificationMethods.removed.length;

  return {
    fromVersion: previous.version,
    toVersion: next.version,
    summaryChanged,
    complexityChanged,
    stepsAdded: steps.added,
    stepsRemoved: steps.removed,
    acceptanceAdded: acceptance.added,
    acceptanceRemoved: acceptance.removed,
    risksAdded: risks.added,
    risksRemoved: risks.removed,
    prohibitionsAdded: prohibitions.added,
    prohibitionsRemoved: prohibitions.removed,
    dependenciesAdded: dependencies.added,
    dependenciesRemoved: dependencies.removed,
    expectedArtifactsAdded: expectedArtifacts.added,
    expectedArtifactsRemoved: expectedArtifacts.removed,
    allowedScopeAdded: allowedScope.added,
    allowedScopeRemoved: allowedScope.removed,
    verificationMethodsAdded: verificationMethods.added,
    verificationMethodsRemoved: verificationMethods.removed,
    changedFieldCount
  };
}

/** True when the new plan differs enough to count as a real revision (not a note-only bump). */
export function isSubstantialPlanRevision(diff: PlanVersionDiff): boolean {
  if (diff.stepsAdded.length > 0 || diff.stepsRemoved.length > 0) return true;
  if (diff.acceptanceAdded.length > 0 || diff.acceptanceRemoved.length > 0) return true;
  if (diff.expectedArtifactsAdded.length > 0 || diff.expectedArtifactsRemoved.length > 0) return true;
  if (diff.allowedScopeAdded.length > 0 || diff.allowedScopeRemoved.length > 0) return true;
  if (diff.dependenciesAdded.length > 0 || diff.dependenciesRemoved.length > 0) return true;
  if (diff.summaryChanged && diff.changedFieldCount >= 2) return true;
  return diff.changedFieldCount >= 3;
}

function listDiff(previous: string[] | undefined, next: string[] | undefined): { added: string[]; removed: string[] } {
  const prev = normalize(previous);
  const nxt = normalize(next);
  const prevSet = new Set(prev);
  const nextSet = new Set(nxt);
  return {
    added: nxt.filter((item) => !prevSet.has(item)),
    removed: prev.filter((item) => !nextSet.has(item))
  };
}

function normalize(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
