import { describe, expect, it } from "vitest";
import { createClaim, createEvidence, markEvidence } from "./evidence.js";
import {
  checkResearchEvidence,
  researchReviewMayPass,
  toReviewerFindingRows
} from "./reviewerEvidenceHooks.js";
import type { ResearchSession } from "./researchTypes.js";
import { aggregateSession, createStepsFromQuestions } from "./researchWorkflow.js";
import { produceResearchArtifacts } from "./researchArtifacts.js";

function makeSession(opts: {
  force?: boolean;
  withSupport?: boolean;
  bindEvidence?: boolean;
  flagEvidence?: boolean;
  withArtifacts?: boolean;
}): ResearchSession {
  const e = createEvidence({
    title: "Study",
    source: "https://ex.com/study",
    excerpt: opts.withSupport === false
      ? "Completely unrelated astronomy notes about stars."
      : "Controlled trials show widgets increase productivity substantially.",
    body: opts.withSupport === false
      ? "stars nebulae galaxies"
      : "Controlled trials show widgets increase productivity substantially in offices.",
    origin: "web"
  });
  const evidence = opts.flagEvidence ? [markEvidence(e, ["low_trust", "invalid"])] : [e];

  const claims = [];
  if (opts.bindEvidence !== false) {
    claims.push(
      createClaim({
        text: "widgets increase productivity",
        kind: "conclusion",
        evidenceIds: [e.id],
        evidencePool: evidence,
        forceEvidenceMode: opts.force !== false
      })
    );
  } else if (opts.force === false) {
    claims.push(
      createClaim({
        text: "A creative idea about widgets",
        kind: "conclusion",
        forceEvidenceMode: false
      })
    );
  } else {
    // force on + no bind: createClaim throws — inject raw claim for reviewer path
    claims.push({
      id: "raw-1",
      text: "widgets increase productivity",
      kind: "conclusion" as const,
      evidenceIds: [] as string[],
      originMarker: "source_backed" as const,
      finalFactEligible: false,
      createdAt: "2026-03-01T00:00:00.000Z"
    });
  }

  let session: ResearchSession = {
    id: "rev-1",
    title: "Review sample",
    goal: "goal",
    forceEvidenceMode: opts.force !== false,
    status: "gathering",
    subQuestions: ["q"],
    steps: createStepsFromQuestions(["q"]),
    evidence,
    claims,
    sources: [],
    conflicts: [],
    artifacts: [],
    aggregated: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z"
  };

  session = aggregateSession(session).session;
  if (opts.withArtifacts) {
    session = produceResearchArtifacts(session).session;
  }
  return session;
}

describe("reviewer evidence hooks (task 32)", () => {
  it("passes when citations support conclusions and artifacts exist", () => {
    const session = makeSession({ withSupport: true, withArtifacts: true });
    const result = checkResearchEvidence(session);
    expect(result.ok).toBe(true);
    expect(result.insufficientEvidence).toBe(false);
    expect(researchReviewMayPass(result)).toBe(true);
    expect(result.sampleEvidenceIds.length).toBeGreaterThan(0);
  });

  it("fails when evidence does not support the claim", () => {
    const session = makeSession({ withSupport: false, withArtifacts: true });
    const result = checkResearchEvidence(session);
    expect(result.ok).toBe(false);
    expect(researchReviewMayPass(result)).toBe(false);
    expect(result.findings.some((f) => /does not support/i.test(f.reason))).toBe(true);
  });

  it("fails when forceEvidenceMode and claim has no Evidence", () => {
    const session = makeSession({ bindEvidence: false, withArtifacts: true });
    const result = checkResearchEvidence(session);
    expect(result.ok).toBe(false);
    expect(result.insufficientEvidence).toBe(true);
    expect(result.findings.some((f) => /no Evidence binding/i.test(f.reason))).toBe(true);
  });

  it("fails when only flagged/low-trust evidence is bound", () => {
    const session = makeSession({ flagEvidence: true, withArtifacts: true });
    const result = checkResearchEvidence(session);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => /flagged|unusable/i.test(f.reason))).toBe(true);
  });

  it("allows creative tasks with forceEvidenceMode off", () => {
    const session = makeSession({ force: false, bindEvidence: false, withArtifacts: false });
    // still aggregated; artifacts optional when force off
    const result = checkResearchEvidence(session);
    expect(result.ok).toBe(true);
    expect(researchReviewMayPass(result)).toBe(true);
  });

  it("exports Reviewer finding rows for independent reviewer merge", () => {
    const session = makeSession({ withSupport: false, withArtifacts: true });
    const rows = toReviewerFindingRows(checkResearchEvidence(session));
    expect(rows.some((r) => !r.met)).toBe(true);
    expect(rows.find((r) => !r.met)?.fixScope).toMatch(/Bind usable Evidence/);
  });
});
