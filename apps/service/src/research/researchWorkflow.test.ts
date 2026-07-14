import { describe, expect, it } from "vitest";
import { createClaim, createEvidence, markEvidence } from "./evidence.js";
import type { ResearchSession } from "./researchTypes.js";
import {
  aggregateSession,
  assertAggregated,
  createStepsFromQuestions,
  deduplicateEvidence,
  frontierParallelSteps,
  organizeConflicts,
  splitResearchQuestions
} from "./researchWorkflow.js";

function baseSession(overrides: Partial<ResearchSession> = {}): ResearchSession {
  const now = "2026-03-01T00:00:00.000Z";
  return {
    id: "sess-1",
    title: "Widgets",
    goal: "Research widgets",
    forceEvidenceMode: true,
    status: "gathering",
    subQuestions: ["What are widgets?"],
    steps: createStepsFromQuestions(["What are widgets?", "What are controversies?"]),
    evidence: [],
    claims: [],
    sources: [],
    conflicts: [],
    artifacts: [],
    aggregated: false,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("research workflow (task 32)", () => {
  it("splits goals into sub-questions", () => {
    const qs = splitResearchQuestions("Impact of widgets on productivity?");
    expect(qs.length).toBeGreaterThanOrEqual(2);
    expect(qs.some((q) => /definition|scope|facts|viewpoints|sources/i.test(q))).toBe(true);
  });

  it("creates parallel gather steps", () => {
    const steps = createStepsFromQuestions(["Q1?", "Q2?", "Q3?"]);
    expect(steps).toHaveLength(3);
    expect(new Set(steps.map((s) => s.parallelGroup)).size).toBe(1);
    const frontier = frontierParallelSteps(steps);
    expect(frontier.length).toBe(3);
  });

  it("deduplicates by URL and content hash; marks duplicates", () => {
    const a = createEvidence({
      title: "A",
      source: "https://ex.com/doc/",
      excerpt: "Same excerpt about widgets productivity.",
      origin: "web"
    });
    const b = createEvidence({
      title: "A copy",
      source: "https://ex.com/doc",
      excerpt: "Same excerpt about widgets productivity.",
      origin: "web"
    });
    const { evidence, duplicatesMerged } = deduplicateEvidence([a, b]);
    expect(duplicatesMerged).toBe(1);
    expect(evidence.filter((e) => e.qualityFlags.includes("duplicate"))).toHaveLength(1);
    expect(evidence.find((e) => e.qualityFlags.includes("duplicate"))?.status).toBe("flagged");
  });

  it("organizes conflicting viewpoints", () => {
    const claims = [
      createClaim({
        text: "Widgets increase productivity in trials",
        kind: "fact",
        evidenceIds: ["e1"],
        forceEvidenceMode: true
      }),
      createClaim({
        text: "Widgets do not increase productivity in trials",
        kind: "fact",
        evidenceIds: ["e2"],
        forceEvidenceMode: true
      })
    ];
    const conflicts = organizeConflicts(claims);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts[0]?.positions).toHaveLength(2);
    expect(conflicts[0]?.resolution).toBe("present_both");
  });

  it("requires aggregation before summary artifacts", () => {
    const session = baseSession();
    expect(() => assertAggregated(session)).toThrow(/aggregation/i);
  });

  it("aggregates: dedup + conflicts + clears finalFact for conflicted claims", () => {
    const e1 = createEvidence({
      title: "Pro",
      source: "https://ex.com/pro",
      excerpt: "Widgets increase productivity in multiple trials.",
      origin: "web"
    });
    const e2 = createEvidence({
      title: "Con",
      source: "https://ex.com/con",
      excerpt: "Widgets do not increase productivity in trials.",
      origin: "web"
    });
    const eDup = createEvidence({
      title: "Pro mirror",
      source: "https://ex.com/pro/",
      excerpt: "Widgets increase productivity in multiple trials.",
      origin: "web"
    });
    const low = markEvidence(
      createEvidence({
        title: "Blog",
        source: "https://ex.com/blog",
        excerpt: "random",
        origin: "web"
      }),
      ["low_trust"]
    );

    const claims = [
      createClaim({
        text: "Widgets increase productivity in trials",
        kind: "fact",
        evidenceIds: [e1.id],
        evidencePool: [e1],
        forceEvidenceMode: true
      }),
      createClaim({
        text: "Widgets do not increase productivity in trials",
        kind: "fact",
        evidenceIds: [e2.id],
        evidencePool: [e2],
        forceEvidenceMode: true
      })
    ];

    const session = baseSession({
      evidence: [e1, e2, eDup, low],
      claims
    });

    const result = aggregateSession(session);
    expect(result.duplicatesMerged).toBeGreaterThanOrEqual(1);
    expect(result.conflictsFound).toBeGreaterThanOrEqual(1);
    expect(result.session.aggregated).toBe(true);
    expect(result.session.status).toBe("ready_for_review");
    expect(result.session.sources.length).toBeGreaterThanOrEqual(2);
    // Conflicted claims must not auto become sole final facts
    const conflicted = result.session.claims.filter((c) =>
      result.session.conflicts.some((cf) => cf.positions.some((p) => p.claimId === c.id))
    );
    expect(conflicted.every((c) => c.finalFactEligible === false)).toBe(true);
  });
});
