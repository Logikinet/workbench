/**
 * Reviewer hooks for evidence-first research (Task 32).
 *
 * Spot-checks that citations actually support conclusions.
 * When forceEvidenceMode is on and evidence is insufficient → must not pass.
 */

import { canUseAsFinalFact, evidenceSupportsClaim } from "./evidence.js";
import type {
  ResearchClaim,
  ResearchEvidence,
  ResearchSession,
  ReviewerEvidenceCheckResult,
  ReviewerEvidenceFinding
} from "./researchTypes.js";

export interface ReviewerEvidenceCheckOptions {
  /** Max evidence ids to surface for human/model spot-check. */
  sampleSize?: number;
  /**
   * When true (default), claims marked finalFactEligible are required to have
   * supporting excerpts. Creative mode (forceEvidenceMode false) softens this.
   */
  requireSupportForFinalFacts?: boolean;
}

/**
 * Pure Reviewer gate over a research session.
 * Does not mutate the session or call models.
 */
export function checkResearchEvidence(
  session: ResearchSession,
  options: ReviewerEvidenceCheckOptions = {}
): ReviewerEvidenceCheckResult {
  const sampleSize = options.sampleSize ?? 5;
  const requireSupport = options.requireSupportForFinalFacts !== false;
  const evidenceById = new Map(session.evidence.map((e) => [e.id, e]));
  const findings: ReviewerEvidenceFinding[] = [];

  const claimsToCheck = selectClaimsForReview(session);

  for (const claim of claimsToCheck) {
    findings.push(checkOneClaim(claim, evidenceById, session.forceEvidenceMode, requireSupport));
  }

  // Session-level: aggregation required for pass under force mode.
  if (session.forceEvidenceMode && !session.aggregated) {
    findings.push({
      claimId: "*",
      claimText: "(session)",
      met: false,
      reason: "Aggregation (source dedup + conflict organization) has not completed.",
      evidenceIds: [],
      severity: "critical"
    });
  }

  // Must have research artifacts registered when force mode expects a deliverable.
  if (session.forceEvidenceMode && session.aggregated && session.artifacts.length === 0) {
    findings.push({
      claimId: "*",
      claimText: "(artifacts)",
      met: false,
      reason: "research.md / sources / evidence catalog artifacts are not registered.",
      evidenceIds: [],
      severity: "high"
    });
  }

  const failed = findings.filter((f) => !f.met);
  const insufficientEvidence = failed.some(
    (f) =>
      f.severity === "critical"
      || f.reason.includes("no Evidence")
      || f.reason.includes("does not support")
      || f.reason.includes("insufficient")
      || f.reason.includes("flagged")
      || f.reason.includes("Aggregation")
  );

  const ok = failed.length === 0;

  // Sample evidence for spot-check: prefer bound ids from failed then final facts.
  const sampleEvidenceIds = pickSampleEvidenceIds(session, findings, sampleSize);

  const summary = ok
    ? session.forceEvidenceMode
      ? `Evidence review passed: ${findings.length} claim(s) checked; citations support conclusions.`
      : `Evidence review passed (forceEvidenceMode off): ${findings.length} claim(s) checked.`
    : `Evidence review failed: ${failed.length}/${findings.length} check(s) not met. Insufficient evidence must not pass.`;

  return {
    ok,
    forceEvidenceMode: session.forceEvidenceMode,
    findings,
    summary,
    sampleEvidenceIds,
    insufficientEvidence: !ok && (insufficientEvidence || session.forceEvidenceMode)
  };
}

function selectClaimsForReview(session: ResearchSession): ResearchClaim[] {
  if (session.forceEvidenceMode) {
    // All facts/conclusions + any claim that claims final eligibility.
    return session.claims.filter(
      (c) => c.kind === "fact" || c.kind === "conclusion" || c.finalFactEligible
    );
  }
  // Creative mode: only check claims that voluntarily bound evidence.
  return session.claims.filter((c) => c.evidenceIds.length > 0);
}

function checkOneClaim(
  claim: ResearchClaim,
  evidenceById: Map<string, ResearchEvidence>,
  forceEvidenceMode: boolean,
  requireSupport: boolean
): ReviewerEvidenceFinding {
  // Distinct markers — AI inference is never required to pass as fact.
  if (claim.kind === "ai_inference") {
    return {
      claimId: claim.id,
      claimText: claim.text,
      met: true,
      reason: "AI inference is labeled and not treated as a final fact.",
      evidenceIds: [...claim.evidenceIds],
      severity: "none"
    };
  }

  if (claim.kind === "user_material") {
    return {
      claimId: claim.id,
      claimText: claim.text,
      met: true,
      reason: "User material is labeled separately from source Evidence.",
      evidenceIds: [...claim.evidenceIds],
      severity: "none"
    };
  }

  if (claim.evidenceIds.length === 0) {
    if (!forceEvidenceMode) {
      return {
        claimId: claim.id,
        claimText: claim.text,
        met: true,
        reason: "forceEvidenceMode is off; unbound claim allowed for creative tasks.",
        evidenceIds: [],
        severity: "low"
      };
    }
    return {
      claimId: claim.id,
      claimText: claim.text,
      met: false,
      reason: `${claim.kind} has no Evidence binding; key facts/conclusions must bind Evidence.`,
      evidenceIds: [],
      severity: "critical"
    };
  }

  const bound: ResearchEvidence[] = [];
  const missing: string[] = [];
  for (const id of claim.evidenceIds) {
    const e = evidenceById.get(id);
    if (!e) missing.push(id);
    else bound.push(e);
  }

  if (missing.length > 0) {
    return {
      claimId: claim.id,
      claimText: claim.text,
      met: false,
      reason: `Bound Evidence id(s) missing from session: ${missing.join(", ")}.`,
      evidenceIds: [...claim.evidenceIds],
      severity: "critical"
    };
  }

  const unusable = bound.filter((e) => !canUseAsFinalFact(e));
  if (unusable.length === bound.length && forceEvidenceMode) {
    return {
      claimId: claim.id,
      claimText: claim.text,
      met: false,
      reason: `All bound Evidence is flagged/unusable (duplicate, invalid, low_trust, stale, or AI origin): ${unusable.map((e) => e.id.slice(0, 8)).join(", ")}.`,
      evidenceIds: [...claim.evidenceIds],
      severity: "critical"
    };
  }

  if (requireSupport) {
    const supporters = bound.filter((e) => canUseAsFinalFact(e) && evidenceSupportsClaim(e, claim.text));
    if (supporters.length === 0) {
      return {
        claimId: claim.id,
        claimText: claim.text,
        met: false,
        reason: "Citation does not support the claim: no usable Evidence excerpt substantiates the conclusion.",
        evidenceIds: [...claim.evidenceIds],
        severity: "high"
      };
    }
  }

  return {
    claimId: claim.id,
    claimText: claim.text,
    met: true,
    reason: "Evidence binding present and excerpt support check passed.",
    evidenceIds: [...claim.evidenceIds],
    severity: "none"
  };
}

function pickSampleEvidenceIds(
  session: ResearchSession,
  findings: ReviewerEvidenceFinding[],
  sampleSize: number
): string[] {
  const ordered: string[] = [];
  for (const f of findings.filter((x) => !x.met)) {
    for (const id of f.evidenceIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }
  }
  for (const c of session.claims.filter((x) => x.finalFactEligible)) {
    for (const id of c.evidenceIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }
  }
  for (const e of session.evidence) {
    if (!ordered.includes(e.id)) ordered.push(e.id);
  }
  return ordered.slice(0, sampleSize);
}

/**
 * Integrate with Independent Reviewer pre-check style output.
 * Returns a compact structure that ReviewService (or callers) can merge into findings.
 */
export function toReviewerFindingRows(result: ReviewerEvidenceCheckResult): Array<{
  criterion: string;
  met: boolean;
  evidence: string;
  severity: ReviewerEvidenceFinding["severity"];
  fixScope?: string;
}> {
  return result.findings.map((f) => ({
    criterion: f.claimId === "*"
      ? f.reason
      : `Research claim evidence: ${f.claimText.slice(0, 120)}`,
    met: f.met,
    evidence: f.reason,
    severity: f.severity,
    fixScope: f.met
      ? undefined
      : "Bind usable Evidence with supporting excerpts, re-aggregate, and regenerate research.md before re-review."
  }));
}

/**
 * Hard gate helper: research Reviewer must not pass when insufficient.
 */
export function researchReviewMayPass(result: ReviewerEvidenceCheckResult): boolean {
  if (!result.ok) return false;
  if (result.forceEvidenceMode && result.insufficientEvidence) return false;
  return true;
}
