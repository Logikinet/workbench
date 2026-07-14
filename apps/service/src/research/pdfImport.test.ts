import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMinimalPdf,
  extractPdfMetadataFromBytes,
  FakePdfPageExtractor,
  importPdf,
  importPdfFromBytes,
  parsePdfDate,
  PdfImportError
} from "./pdfImport.js";

describe("pdfImport metadata (task 32)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("parses PDF date strings", () => {
    expect(parsePdfDate("D:20240115123000Z")).toBe("2024-01-15T12:30:00.000Z");
    expect(parsePdfDate(undefined)).toBeUndefined();
  });

  it("extracts title, author, page count from minimal PDF bytes", () => {
    const bytes = buildMinimalPdf({
      title: "Survey of Widgets",
      author: "Grace Hopper",
      creationDate: "D:20240301000000Z",
      pageCount: 3
    });
    const meta = extractPdfMetadataFromBytes(bytes);
    expect(meta.title).toBe("Survey of Widgets");
    expect(meta.author).toBe("Grace Hopper");
    expect(meta.creationDate).toBe("2024-03-01T00:00:00.000Z");
    expect(meta.pageCount).toBe(3);
  });

  it("rejects non-PDF bytes", () => {
    expect(() => extractPdfMetadataFromBytes(Buffer.from("not a pdf"))).toThrow(PdfImportError);
  });

  it("imports from file path with page extractor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paw-pdf-"));
    dirs.push(dir);
    const path = join(dir, "paper.pdf");
    const bytes = buildMinimalPdf({ title: "Paper", author: "A", pageCount: 2 });
    await writeFile(path, bytes);

    const extractor = new FakePdfPageExtractor().seed(path, [
      { page: 1, text: "Introduction: widgets are useful devices." },
      { page: 2, text: "Conclusion: further work remains." }
    ]);

    const result = await importPdf(path, {
      extractor,
      now: () => new Date("2026-02-01T00:00:00.000Z")
    });
    expect(result.metadata.title).toBe("Paper");
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.text).toMatch(/widgets/);
    expect(result.importedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("imports from bytes label without filesystem write of pages", async () => {
    const bytes = buildMinimalPdf({ title: "InMem", author: "B", pageCount: 1 });
    const extractor = new FakePdfPageExtractor().seed("mem://x.pdf", [
      { page: 1, text: "Body text for excerpt." }
    ]);
    const result = await importPdfFromBytes("mem://x.pdf", bytes, { extractor });
    expect(result.metadata.title).toBe("InMem");
    expect(result.pages[0]?.page).toBe(1);
  });
});
