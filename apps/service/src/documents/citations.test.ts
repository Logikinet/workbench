import { describe, expect, it } from "vitest";
import { createEvidence } from "../research/evidence.js";
import {
  buildCitationsFromEvidence,
  checkCitations,
  extractCitationKeysFromBody,
  formatBibliography,
  formatCitation
} from "./citations.js";
import type { Chapter } from "./documentTypes.js";
import { importMarkdownText } from "./materialImport.js";

describe("citations", () => {
  const now = () => new Date("2026-04-04T00:00:00.000Z");

  const evidence = [
    createEvidence({
      title: "Widget productivity study",
      source: "https://research.example/widgets",
      excerpt: "Widgets increase productivity.",
      origin: "web",
      author: "Lee",
      publishedAt: "2025-05-01T00:00:00.000Z",
      now
    })
  ];

  it("builds citations from evidence with stable keys", () => {
    const citations = buildCitationsFromEvidence(evidence, [], now);
    expect(citations).toHaveLength(1);
    expect(citations[0]!.key).toBe("Lee2025");
    expect(citations[0]!.evidenceId).toBe(evidence[0]!.id);
  });

  it("formats APA / IEEE / GB7714 bibliography entries", () => {
    const cit = buildCitationsFromEvidence(evidence, [], now)[0]!;
    expect(formatCitation(cit, "apa", 1)).toMatch(/Lee \(2025\)/);
    expect(formatCitation(cit, "ieee", 1)).toMatch(/^\[1\]/);
    expect(formatCitation(cit, "gb7714", 1)).toMatch(/\[1\]/);
    const bib = formatBibliography([cit], "apa");
    expect(bib).toContain("## References");
    expect(bib).toContain("Widget productivity study");
  });

  it("extracts citation keys from body text", () => {
    const keys = extractCitationKeysFromBody(
      "See [Lee2025] and (Smith, 2024) plus [mat:abcd1234]."
    );
    expect(keys).toContain("Lee2025");
    expect(keys).toContain("Smith2024");
    expect(keys).toContain("mat:abcd1234");
  });

  it("checks that cited keys trace to Evidence", () => {
    const materials = [
      importMarkdownText({ text: "User note.", kind: "user_material", now })
    ];
    const citations = buildCitationsFromEvidence(evidence, materials, now);
    const chapter: Chapter = {
      id: "ch1",
      sectionId: "s1",
      title: "Intro",
      currentVersion: 1,
      versions: [
        {
          version: 1,
          body: "Finding supported by [Lee2025].",
          citationKeys: ["Lee2025"],
          evidenceIds: [evidence[0]!.id],
          materialIds: [],
          createdAt: now().toISOString(),
          contentOrigin: "generated"
        }
      ],
      terminology: {},
      dataPoints: []
    };

    const ok = checkCitations([chapter], citations, "apa");
    expect(ok.ok).toBe(true);
    expect(ok.findings.some((f) => f.citationKey === "Lee2025" && f.met)).toBe(true);
    expect(ok.bibliography).toContain("Lee");

    const badChapter: Chapter = {
      ...chapter,
      id: "ch2",
      versions: [
        {
          ...chapter.versions[0]!,
          body: "Invented ref [Ghost2099].",
          citationKeys: ["Ghost2099"]
        }
      ]
    };
    const bad = checkCitations([badChapter], citations, "ieee");
    expect(bad.ok).toBe(false);
    expect(bad.findings.some((f) => f.citationKey === "Ghost2099" && !f.met)).toBe(true);
  });
});
