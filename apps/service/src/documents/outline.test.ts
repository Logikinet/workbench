import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../model/fakeProvider.js";
import { createEvidence } from "../research/evidence.js";
import { importMarkdownText, materialFromEvidence } from "./materialImport.js";
import {
  approveOutline,
  generateOutline,
  OutlineError,
  parseOutlineModelOutput,
  rejectOutline
} from "./outline.js";

describe("outline (Secondmate + FakeModel)", () => {
  const now = () => new Date("2026-04-02T10:00:00.000Z");

  function fixtures() {
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
    const materials = [
      importMarkdownText({
        text: "# Paper template\n\n## Intro\n## Methods",
        kind: "template",
        now
      }),
      materialFromEvidence(evidence[0]!, { now })
    ];
    return { evidence, materials, projectFacts: ["Project uses TypeScript."] };
  }

  it("parses structured outline JSON", () => {
    const parsed = parseOutlineModelOutput(
      JSON.stringify({
        title: "Widget Paper",
        summary: "Study widgets",
        sections: [
          {
            title: "Introduction",
            summary: "Background",
            materialIds: ["m1"],
            evidenceIds: ["e1"],
            acceptanceCriteria: ["States goal"],
            missingData: ["Sample size"]
          }
        ],
        missingDataList: ["IRB approval"],
        acceptanceCriteria: ["User approved"]
      })
    );
    expect(parsed.title).toBe("Widget Paper");
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.missingDataList).toContain("IRB approval");
  });

  it("rejects invalid model output", () => {
    expect(() => parseOutlineModelOutput("not-json")).toThrow(OutlineError);
    expect(() => parseOutlineModelOutput(JSON.stringify({ title: "x", sections: [] }))).toThrow(
      OutlineError
    );
  });

  it("generates outline via FakeModelProvider and awaits approval", async () => {
    const { evidence, materials, projectFacts } = fixtures();
    const outlineJson = {
      title: "Effects of Widgets",
      summary: "Paper on widgets",
      sections: [
        {
          title: "Introduction",
          summary: "Motivation",
          materialIds: [materials[0]!.id],
          evidenceIds: [evidence[0]!.id],
          acceptanceCriteria: ["Cites at least one Evidence item"],
          missingData: []
        },
        {
          title: "Results",
          summary: "Findings",
          evidenceIds: [evidence[0]!.id],
          acceptanceCriteria: ["No invented statistics"],
          missingData: ["Exact effect size not in sources"]
        }
      ],
      missingDataList: ["Exact effect size not in sources"],
      acceptanceCriteria: ["All claims traceable"]
    };
    const model = new FakeModelProvider({ successContent: JSON.stringify(outlineJson) });

    const outline = await generateOutline({
      title: "Widgets",
      goal: "Write a paper on widget productivity",
      materials,
      evidence,
      projectFacts,
      model,
      now
    });

    expect(outline.status).toBe("awaiting_approval");
    expect(outline.sections).toHaveLength(2);
    expect(outline.sections[0]!.materialIds).toContain(materials[0]!.id);
    expect(outline.sections[0]!.evidenceIds).toContain(evidence[0]!.id);
    expect(outline.missingDataList.some((m) => /effect size/i.test(m))).toBe(true);
    expect(model.calls.length).toBe(1);
    expect(model.calls[0]!.messages[0]!.role).toBe("system");
  });

  it("drops unknown material/evidence ids from bindings", async () => {
    const { evidence, materials, projectFacts } = fixtures();
    const model = new FakeModelProvider({
      successContent: JSON.stringify({
        title: "T",
        summary: "S",
        sections: [
          {
            title: "A",
            summary: "s",
            materialIds: ["bogus"],
            evidenceIds: ["also-bogus"]
          }
        ]
      })
    });
    const outline = await generateOutline({
      title: "T",
      goal: "G",
      materials,
      evidence,
      projectFacts,
      model,
      now
    });
    expect(outline.sections[0]!.materialIds).toEqual([]);
    expect(outline.sections[0]!.evidenceIds).toEqual([]);
    expect(outline.sections[0]!.missingData.length).toBeGreaterThan(0);
  });

  it("approve then reject workflow", async () => {
    const { evidence, materials, projectFacts } = fixtures();
    const model = new FakeModelProvider({
      successContent: JSON.stringify({
        title: "T",
        summary: "S",
        sections: [{ title: "Intro", summary: "s", evidenceIds: [evidence[0]!.id] }]
      })
    });
    let outline = await generateOutline({
      title: "T",
      goal: "G",
      materials,
      evidence,
      projectFacts,
      model,
      now
    });
    outline = approveOutline(outline, now);
    expect(outline.status).toBe("approved");
    expect(outline.approvedAt).toBe("2026-04-02T10:00:00.000Z");
    expect(outline.sections.every((s) => s.status === "approved")).toBe(true);

    expect(() => approveOutline(outline, now)).toThrow(OutlineError);

    const rejected = rejectOutline(outline, "Need more sections");
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectedReason).toContain("more sections");
  });
});
