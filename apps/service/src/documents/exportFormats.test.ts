import { describe, expect, it } from "vitest";
import type { DocumentSession } from "./documentTypes.js";
import {
  buildDocumentDocx,
  buildDocumentMarkdown,
  buildDocumentPdf,
  contentHash,
  defaultExportPaths
} from "./exportFormats.js";
import { extractDocxTextFromXml, extractZipEntryText, importDocxFromBytes } from "./materialImport.js";

function sampleSession(): DocumentSession {
  return {
    id: "sess-1",
    title: "Widget Paper",
    goal: "Explain widgets",
    status: "writing",
    bibliographyStyle: "apa",
    materials: [
      {
        id: "m1",
        title: "Tpl",
        kind: "template",
        format: "markdown",
        contentOrigin: "original",
        text: "template",
        contentHash: "abc",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    outline: {
      id: "o1",
      title: "Effects of Widgets",
      summary: "A short paper",
      sections: [
        {
          id: "s1",
          title: "Introduction",
          order: 0,
          summary: "Background",
          materialIds: ["m1"],
          evidenceIds: [],
          acceptanceCriteria: ["Has goal"],
          missingData: [],
          status: "written"
        }
      ],
      missingDataList: [],
      acceptanceCriteria: [],
      status: "approved",
      generatedAt: "2026-01-01T00:00:00.000Z",
      approvedAt: "2026-01-01T00:00:00.000Z"
    },
    chapters: [
      {
        id: "c1",
        sectionId: "s1",
        title: "Introduction",
        currentVersion: 1,
        versions: [
          {
            version: 1,
            body: "Widgets increase productivity [Lee2025].",
            citationKeys: ["Lee2025"],
            evidenceIds: ["e1"],
            materialIds: ["m1"],
            createdAt: "2026-01-01T00:00:00.000Z",
            contentOrigin: "generated"
          }
        ],
        terminology: {},
        dataPoints: []
      }
    ],
    citations: [
      {
        id: "cit1",
        key: "Lee2025",
        evidenceId: "e1",
        title: "Widget study",
        author: "Lee",
        source: "https://example.com",
        publishedAt: "2025-05-01T00:00:00.000Z",
        accessedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    exports: [],
    externalWatches: [],
    consistencyIssues: [],
    evidence: [],
    projectFacts: ["TypeScript monorepo"],
    artifacts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z"
  };
}

describe("exportFormats", () => {
  it("builds markdown with chapters, provenance, and bibliography", () => {
    const md = buildDocumentMarkdown(sampleSession());
    expect(md).toContain("# Effects of Widgets");
    expect(md).toContain("## Introduction");
    expect(md).toContain("Widgets increase productivity");
    expect(md).toContain("generated");
    expect(md).toContain("## References");
    expect(md).toContain("Lee");
  });

  it("builds DOCX that round-trips via import", () => {
    const docx = buildDocumentDocx(sampleSession());
    expect(docx[0]).toBe(0x50);
    expect(docx[1]).toBe(0x4b);
    const xml = extractZipEntryText(docx, "word/document.xml");
    expect(xml).toBeTruthy();
    expect(extractDocxTextFromXml(xml!)).toContain("Widgets increase productivity");

    const material = importDocxFromBytes({ bytes: docx, title: "Roundtrip" });
    expect(material.text).toContain("Widgets increase productivity");
    expect(material.contentOrigin).toBe("original");
  });

  it("builds PDF with %PDF header and content", () => {
    const pdf = buildDocumentPdf(sampleSession());
    const head = pdf.subarray(0, 8).toString("utf8");
    expect(head.startsWith("%PDF-")).toBe(true);
    expect(pdf.toString("utf8")).toContain("Helvetica");
    expect(pdf.toString("utf8")).toContain("%%EOF");
  });

  it("produces stable content hashes and default paths", () => {
    const session = sampleSession();
    const md = buildDocumentMarkdown(session);
    expect(contentHash(md)).toHaveLength(32);
    expect(defaultExportPaths(session).docx).toMatch(/\.docx$/);
  });
});
