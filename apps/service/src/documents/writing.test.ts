import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../model/fakeProvider.js";
import { createEvidence } from "../research/evidence.js";
import { importMarkdownText, materialFromEvidence } from "./materialImport.js";
import { approveOutline, generateOutline } from "./outline.js";
import {
  detectFabricationSignals,
  writeChapter,
  WritingError
} from "./writing.js";

describe("writing (grounded chapters + FakeModel)", () => {
  const now = () => new Date("2026-04-03T12:00:00.000Z");

  async function approvedOutline() {
    const evidence = [
      createEvidence({
        title: "Widget productivity study",
        source: "https://research.example/widgets",
        excerpt: "Widgets increase productivity in office trials. Effect observed in controlled groups.",
        origin: "web",
        author: "Lee",
        publishedAt: "2025-05-01T00:00:00.000Z",
        now
      })
    ];
    const materials = [
      importMarkdownText({ text: "# Tpl\n\nMethods section guide.", kind: "template", now }),
      materialFromEvidence(evidence[0]!, { now })
    ];
    const projectFacts = ["Codebase is TypeScript monorepo."];
    const model = new FakeModelProvider({
      successContent: JSON.stringify({
        title: "Widget Paper",
        summary: "Study",
        sections: [
          {
            title: "Introduction",
            summary: "Background",
            materialIds: [materials[0]!.id],
            evidenceIds: [evidence[0]!.id],
            acceptanceCriteria: ["Cite Lee2025"],
            missingData: []
          }
        ]
      })
    });
    let outline = await generateOutline({
      title: "Widgets",
      goal: "Paper",
      materials,
      evidence,
      projectFacts,
      model,
      now
    });
    outline = approveOutline(outline, now);
    return { outline, materials, evidence, projectFacts };
  }

  it("writes a grounded chapter with citation keys", async () => {
    const { outline, materials, evidence, projectFacts } = await approvedOutline();
    const chapterModel = new FakeModelProvider({
      successContent: JSON.stringify({
        body: "Widgets increase productivity in office trials [Lee2025]. Our TypeScript monorepo adopts this insight.",
        citationKeys: ["Lee2025"],
        evidenceIds: [evidence[0]!.id],
        materialIds: [materials[0]!.id],
        terminology: { Widget: "Widget" },
        dataPoints: [{ key: "finding", value: "increase productivity", evidenceId: evidence[0]!.id }]
      })
    });

    const result = await writeChapter({
      outline,
      sectionId: outline.sections[0]!.id,
      materials,
      evidence,
      projectFacts,
      model: chapterModel,
      now
    });

    expect(result.blocked).toBe(false);
    expect(result.chapter.currentVersion).toBe(1);
    expect(result.chapter.versions[0]!.contentOrigin).toBe("generated");
    expect(result.chapter.versions[0]!.body).toContain("Lee2025");
    expect(result.chapter.terminology.Widget).toBe("Widget");
  });

  it("blocks writing before outline approval", async () => {
    const { outline, materials, evidence, projectFacts } = await approvedOutline();
    const unapproved = { ...outline, status: "awaiting_approval" as const };
    const model = new FakeModelProvider({
      successContent: JSON.stringify({ body: "x" })
    });
    await expect(
      writeChapter({
        outline: unapproved,
        sectionId: outline.sections[0]!.id,
        materials,
        evidence,
        projectFacts,
        model,
        now
      })
    ).rejects.toThrow(WritingError);
  });

  it("blocks fabricated citation keys and invented statistics", async () => {
    const { outline, materials, evidence, projectFacts } = await approvedOutline();
    const model = new FakeModelProvider({
      successContent: JSON.stringify({
        body: "We won the Nobel Prize. Productivity rose 87.5% (n=9000 participants) [FakeAuthor2099].",
        citationKeys: ["FakeAuthor2099"]
      })
    });
    const result = await writeChapter({
      outline,
      sectionId: outline.sections[0]!.id,
      materials,
      evidence,
      projectFacts,
      model,
      now,
      enforceGrounding: true
    });
    expect(result.blocked).toBe(true);
    expect(result.blockReasons.some((r) => /citation|Fabricat|Statistic|award|Nobel/i.test(r))).toBe(
      true
    );
    expect(result.chapter.currentVersion).toBe(0);
  });

  it("revises chapter creating a new version", async () => {
    const { outline, materials, evidence, projectFacts } = await approvedOutline();
    const model = new FakeModelProvider({
      successContents: [
        JSON.stringify({
          body: "First draft citing [Lee2025].",
          citationKeys: ["Lee2025"],
          evidenceIds: [evidence[0]!.id]
        }),
        JSON.stringify({
          body: "Revised draft citing [Lee2025] with clearer intro.",
          citationKeys: ["Lee2025"],
          evidenceIds: [evidence[0]!.id]
        })
      ]
    });

    const first = await writeChapter({
      outline,
      sectionId: outline.sections[0]!.id,
      materials,
      evidence,
      projectFacts,
      model,
      now
    });
    const second = await writeChapter({
      outline,
      sectionId: outline.sections[0]!.id,
      materials,
      evidence,
      projectFacts,
      existing: first.chapter,
      revisionNote: "Clarify intro",
      model,
      now
    });
    expect(second.chapter.currentVersion).toBe(2);
    expect(second.chapter.versions).toHaveLength(2);
    expect(second.chapter.versions[1]!.body).toContain("Revised");
  });

  it("detectFabricationSignals flags unsupported stats", () => {
    const reasons = detectFabricationSignals("Accuracy was 99.9% in production.", {
      projectFacts: ["App is local-first."],
      materials: [],
      evidence: []
    });
    expect(reasons.some((r) => /99\.9%/.test(r))).toBe(true);
  });
});
