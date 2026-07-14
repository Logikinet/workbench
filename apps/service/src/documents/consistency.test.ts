import { describe, expect, it } from "vitest";
import {
  checkConsistency,
  compareChapterVersions,
  consistencyOk
} from "./consistency.js";
import type { Chapter } from "./documentTypes.js";

function chapter(
  id: string,
  partial: Partial<Chapter> & { body1?: string; body2?: string }
): Chapter {
  const versions = [];
  if (partial.body1 !== undefined) {
    versions.push({
      version: 1,
      body: partial.body1,
      citationKeys: [],
      evidenceIds: [],
      materialIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      contentOrigin: "generated" as const
    });
  }
  if (partial.body2 !== undefined) {
    versions.push({
      version: 2,
      body: partial.body2,
      citationKeys: [],
      evidenceIds: [],
      materialIds: [],
      createdAt: "2026-01-02T00:00:00.000Z",
      contentOrigin: "generated" as const
    });
  }
  return {
    id,
    sectionId: `sec-${id}`,
    title: partial.title ?? id,
    currentVersion: versions.length,
    versions,
    terminology: partial.terminology ?? {},
    dataPoints: partial.dataPoints ?? []
  };
}

describe("consistency + version compare", () => {
  it("diffs chapter versions", () => {
    const ch = chapter("c1", {
      body1: "line a\nline b\nline c",
      body2: "line a\nline b2\nline c\nline d"
    });
    const diff = compareChapterVersions(ch, 1, 2);
    expect(diff.addedLines).toEqual(expect.arrayContaining(["line b2", "line d"]));
    expect(diff.removedLines).toContain("line b");
    expect(diff.summary).toMatch(/\+/);
  });

  it("flags conflicting terminology across chapters", () => {
    const issues = checkConsistency([
      chapter("c1", { terminology: { API: "Application Programming Interface" }, body1: "x" }),
      chapter("c2", { terminology: { API: "Application Program Interface" }, body1: "y" })
    ]);
    expect(issues.some((i) => i.kind === "terminology" && i.severity === "error")).toBe(true);
    expect(consistencyOk(issues)).toBe(false);
  });

  it("flags conflicting data points", () => {
    const issues = checkConsistency([
      chapter("c1", {
        body1: "a",
        dataPoints: [{ key: "users", value: "100" }]
      }),
      chapter("c2", {
        body1: "b",
        dataPoints: [{ key: "users", value: "250" }]
      })
    ]);
    expect(issues.some((i) => i.kind === "data_point")).toBe(true);
  });

  it("passes when terminology and data agree", () => {
    const issues = checkConsistency([
      chapter("c1", {
        body1: "a",
        terminology: { Widget: "Widget" },
        dataPoints: [{ key: "users", value: "100" }]
      }),
      chapter("c2", {
        body1: "b",
        terminology: { Widget: "Widget" },
        dataPoints: [{ key: "users", value: "100" }]
      })
    ]);
    expect(consistencyOk(issues)).toBe(true);
  });
});
