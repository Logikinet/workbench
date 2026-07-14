import { describe, expect, it } from "vitest";
import type { CourseworkEvidenceItem, ScoringPoint } from "./courseworkTypes.js";
import {
  addMappingTarget,
  bindEvidenceToScoringMap,
  emptyMappings,
  evaluateScoringCoverage,
  hasStrongCoverage
} from "./scoringMap.js";

const points: ScoringPoint[] = [
  { id: "sp-1", title: "Login", description: "Login works", category: "function" },
  { id: "sp-2", title: "Docs", description: "Report", category: "docs" }
];

describe("scoringMap", () => {
  it("starts uncovered and maps targets", () => {
    let map = emptyMappings(points);
    expect(map.every((m) => !m.covered)).toBe(true);

    map = addMappingTarget(map, "sp-1", {
      kind: "implementation_file",
      ref: "src/auth/login.ts"
    });
    expect(map.find((m) => m.scoringPointId === "sp-1")!.covered).toBe(true);
    expect(hasStrongCoverage(map.find((m) => m.scoringPointId === "sp-1")!)).toBe(true);
  });

  it("rejects placeholder refs when provided", () => {
    let map = emptyMappings(points);
    map = addMappingTarget(
      map,
      "sp-1",
      { kind: "screenshot", ref: "fake-ui.png" },
      { placeholderRefs: new Set(["fake-ui.png"]) }
    );
    expect(map.find((m) => m.scoringPointId === "sp-1")!.targets).toHaveLength(0);
  });

  it("binds evidence to scoring map and skips placeholders", () => {
    const map = emptyMappings(points);
    const evidence: CourseworkEvidenceItem[] = [
      {
        id: "e1",
        kind: "implementation",
        title: "Login module",
        path: "src/login.ts",
        relatedScoringPointIds: ["sp-1"],
        relatedRequirementIds: [],
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "e2",
        kind: "screenshot",
        title: "Fake shell",
        path: "fake.png",
        relatedScoringPointIds: ["sp-1"],
        relatedRequirementIds: [],
        isPlaceholder: true,
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "e3",
        kind: "document",
        title: "Chapter 2",
        path: "report.md#ch2",
        relatedScoringPointIds: ["sp-2"],
        relatedRequirementIds: [],
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ];
    const bound = bindEvidenceToScoringMap(map, evidence);
    const sp1 = bound.find((m) => m.scoringPointId === "sp-1")!;
    expect(sp1.targets.some((t) => t.ref === "src/login.ts")).toBe(true);
    expect(sp1.targets.some((t) => t.ref === "fake.png")).toBe(false);
    expect(hasStrongCoverage(sp1)).toBe(true);

    const sp2 = bound.find((m) => m.scoringPointId === "sp-2")!;
    expect(sp2.covered).toBe(true);
    expect(hasStrongCoverage(sp2)).toBe(false);

    const weak = evaluateScoringCoverage(bound, { requireStrong: false });
    expect(weak.ok).toBe(true);
    const strong = evaluateScoringCoverage(bound, { requireStrong: true });
    expect(strong.ok).toBe(false);
    expect(strong.uncoveredIds).toContain("sp-2");
  });
});
