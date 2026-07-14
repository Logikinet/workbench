import { describe, expect, it } from "vitest";
import {
  buildStoredZip,
  estimatePdfPageCount,
  previewDocx,
  previewPptx,
  previewXlsx,
  readZipEntries
} from "./zipOoxml.js";

function makeMinimalDocx(): Buffer {
  const documentXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello Artifact</w:t></w:r></w:p></w:body></w:document>`;
  return buildStoredZip([{ name: "word/document.xml", data: Buffer.from(documentXml, "utf8") }]);
}

function makeMinimalXlsx(): Buffer {
  const shared = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Alpha</t></si><si><t>Beta</t></si></sst>`;
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>`;
  return buildStoredZip([
    { name: "xl/sharedStrings.xml", data: Buffer.from(shared, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet, "utf8") }
  ]);
}

function makeMinimalPptx(): Buffer {
  const slide = `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><a:t>Slide Title</a:t></p:sld>`;
  return buildStoredZip([{ name: "ppt/slides/slide1.xml", data: Buffer.from(slide, "utf8") }]);
}

describe("zipOoxml (Task 42)", () => {
  it("round-trips stored zip entries", () => {
    const zip = buildStoredZip([
      { name: "a.txt", data: Buffer.from("hello", "utf8") },
      { name: "dir/b.txt", data: Buffer.from("world", "utf8") }
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name).sort()).toEqual(["a.txt", "dir/b.txt"]);
    expect(entries.find((e) => e.name === "a.txt")?.data.toString("utf8")).toBe("hello");
  });

  it("extracts readonly DOCX / XLSX / PPTX text without rewriting", () => {
    const docx = previewDocx(makeMinimalDocx(), 10_000);
    expect(docx.text).toContain("Hello Artifact");
    expect(docx.html).toContain("Hello Artifact");

    const xlsx = previewXlsx(makeMinimalXlsx(), 10_000);
    expect(xlsx.text).toMatch(/Alpha/);
    expect(xlsx.parts.length).toBeGreaterThan(0);

    const pptx = previewPptx(makeMinimalPptx(), 10_000);
    expect(pptx.text).toContain("Slide Title");
  });

  it("estimates PDF page count heuristically", () => {
    const pdf = Buffer.from("%PDF-1.4\n/Type /Pages /Count 2\n/Type /Page\n/Type /Page\n%%EOF", "latin1");
    expect(estimatePdfPageCount(pdf)).toBe(2);
  });
});
