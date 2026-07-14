import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMinimalPdf } from "../research/pdfImport.js";
import { createEvidence } from "../research/evidence.js";
import {
  createMaterial,
  extractDocxTextFromXml,
  importDocxFromBytes,
  importMarkdownText,
  importPdfMaterialFromBytes,
  isGeneratedMaterial,
  isOriginalMaterial,
  materialFromEvidence,
  MaterialImportError
} from "./materialImport.js";
import { buildZipStore } from "./exportFormats.js";

describe("materialImport", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("imports markdown as original user material and extracts title", () => {
    const m = importMarkdownText({
      text: "# Thesis Template\n\nIntro paragraph.",
      kind: "template",
      now: () => new Date("2026-04-01T00:00:00.000Z")
    });
    expect(m.title).toBe("Thesis Template");
    expect(m.kind).toBe("template");
    expect(m.format).toBe("markdown");
    expect(m.contentOrigin).toBe("original");
    expect(isOriginalMaterial(m)).toBe(true);
    expect(isGeneratedMaterial(m)).toBe(false);
  });

  it("rejects empty material text", () => {
    expect(() =>
      createMaterial({ title: "x", kind: "user_material", format: "plain", text: "  " })
    ).toThrow(MaterialImportError);
  });

  it("parses DOCX XML text runs", () => {
    const xml =
      `<w:document><w:body>` +
      `<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>Line2 &amp; more</w:t></w:r></w:p>` +
      `</w:body></w:document>`;
    expect(extractDocxTextFromXml(xml)).toBe("Hello world\nLine2 & more");
  });

  it("imports DOCX from pure ZIP store package", () => {
    const documentXml =
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t>User notes on widgets</w:t></w:r></w:p></w:body></w:document>`;
    const zip = buildZipStore([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>", "utf8") },
      { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") }
    ]);
    const m = importDocxFromBytes({
      bytes: zip,
      kind: "user_material",
      title: "Notes"
    });
    expect(m.format).toBe("docx");
    expect(m.contentOrigin).toBe("original");
    expect(m.text).toContain("User notes on widgets");
  });

  it("imports PDF material with metadata and page text", () => {
    const bytes = buildMinimalPdf({ title: "Survey Paper", author: "Ada", pageCount: 2 });
    const m = importPdfMaterialFromBytes({
      bytes,
      pageTexts: [{ page: 1, text: "Abstract of survey." }],
      kind: "template"
    });
    expect(m.format).toBe("pdf");
    expect(m.kind).toBe("template");
    expect(m.contentOrigin).toBe("original");
    expect(m.title).toBe("Survey Paper");
    expect(m.text).toContain("Abstract of survey");
    expect(m.metadata).toMatchObject({ author: "Ada" });
  });

  it("binds ResearchEvidence as original material", () => {
    const ev = createEvidence({
      title: "Widget study",
      source: "https://example.com/w",
      excerpt: "Widgets help.",
      origin: "web",
      author: "Lee",
      now: () => new Date("2026-04-01T00:00:00.000Z")
    });
    const m = materialFromEvidence(ev);
    expect(m.kind).toBe("evidence");
    expect(m.evidenceId).toBe(ev.id);
    expect(m.contentOrigin).toBe("original");
    expect(m.text).toBe("Widgets help.");
  });

  it("marks generated materials distinctly", () => {
    const m = createMaterial({
      title: "Draft",
      kind: "generated",
      format: "markdown",
      text: "AI wrote this",
      contentOrigin: "generated"
    });
    expect(isGeneratedMaterial(m)).toBe(true);
    expect(isOriginalMaterial(m)).toBe(false);
  });

  it("writes and reads markdown file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paw-doc-mat-"));
    dirs.push(dir);
    const path = join(dir, "tpl.md");
    await writeFile(path, "# T\n\nbody", "utf8");
    const { importMarkdownFile } = await import("./materialImport.js");
    const m = await importMarkdownFile(path, { kind: "template" });
    expect(m.sourcePath).toBe(path);
    expect(m.text).toContain("body");
  });
});
