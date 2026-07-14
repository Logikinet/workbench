import { describe, expect, it } from "vitest";
import { createClaim, createEvidence } from "./evidence.js";
import {
  buildEvidenceCatalogMarkdown,
  buildResearchMarkdown,
  buildSourcesJson,
  EVIDENCE_CATALOG_PATH,
  produceResearchArtifacts,
  RESEARCH_MD_PATH,
  SOURCES_JSON_PATH
} from "./researchArtifacts.js";
import type { ResearchSession } from "./researchTypes.js";
import { aggregateSession, createStepsFromQuestions } from "./researchWorkflow.js";

function aggregatedSession(): ResearchSession {
  const e = createEvidence({
    title: "Official report",
    author: "Org",
    source: "https://ex.com/report",
    publishedAt: "2025-06-01T00:00:00.000Z",
    excerpt: "Widgets increase productivity by twenty percent in controlled trials.",
    body: "Widgets increase productivity by twenty percent in controlled trials across industries.",
    origin: "web",
    location: { charStart: 0, charEnd: 70 }
  });
  const fact = createClaim({
    text: "Widgets increase productivity by twenty percent",
    kind: "fact",
    evidenceIds: [e.id],
    evidencePool: [e],
    forceEvidenceMode: true
  });
  const inference = createClaim({
    text: "Widgets may reshape office work.",
    kind: "ai_inference",
    forceEvidenceMode: true
  });
  const raw: ResearchSession = {
    id: "s1",
    title: "Widget research",
    goal: "Study widget productivity effects",
    forceEvidenceMode: true,
    status: "gathering",
    subQuestions: ["Effects?", "Sources?"],
    steps: createStepsFromQuestions(["Effects?", "Sources?"]),
    evidence: [e],
    claims: [fact, inference],
    sources: [],
    conflicts: [],
    artifacts: [],
    aggregated: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z"
  };
  return aggregateSession(raw).session;
}

describe("research artifacts (task 32)", () => {
  it("builds research.md with facts, AI markers, and sources", () => {
    const session = aggregatedSession();
    const md = buildResearchMarkdown(session);
    expect(md).toMatch(/^# Widget research/m);
    expect(md).toMatch(/Final facts/);
    expect(md).toMatch(/Widgets increase productivity/);
    expect(md).toMatch(/AI 推断|AI inferences/i);
    expect(md).toMatch(/Widgets may reshape/);
    expect(md).toMatch(/Official report/);
    expect(md).toContain(EVIDENCE_CATALOG_PATH);
  });

  it("builds structured sources JSON and evidence catalog", () => {
    const session = aggregatedSession();
    const sources = JSON.parse(buildSourcesJson(session));
    expect(sources.sources.length).toBeGreaterThanOrEqual(1);
    expect(sources.sources[0].source).toMatch(/ex\.com\/report/);

    const catalog = buildEvidenceCatalogMarkdown(session);
    expect(catalog).toMatch(/Evidence catalog/);
    expect(catalog).toMatch(/Official report/);
    expect(catalog).toMatch(/twenty percent/);
    expect(catalog).toMatch(/Accessed/);
  });

  it("produceResearchArtifacts registers research.md, sources, evidence catalog", () => {
    const session = aggregatedSession();
    const produced = produceResearchArtifacts(session);
    expect(produced.artifacts.map((a) => a.path).sort()).toEqual(
      [EVIDENCE_CATALOG_PATH, RESEARCH_MD_PATH, SOURCES_JSON_PATH].sort()
    );
    expect(produced.session.artifacts).toHaveLength(3);
    expect(produced.researchMarkdown).toContain("Widget research");
  });

  it("refuses artifacts before aggregation", () => {
    const session = aggregatedSession();
    session.aggregated = false;
    expect(() => buildResearchMarkdown(session)).toThrow(/aggregation/i);
  });
});
