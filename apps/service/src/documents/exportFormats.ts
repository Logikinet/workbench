/**
 * Pure Markdown / DOCX / PDF exporters (Task 33).
 * Local files are the formal source of truth — no online Office editor.
 * DOCX is a minimal ZIP (store method) OOXML package; PDF is a simple text PDF.
 */

import { createHash } from "node:crypto";
import type {
  BibliographyStyle,
  Chapter,
  Citation,
  DocumentOutline,
  DocumentSession
} from "./documentTypes.js";
import { formatBibliography } from "./citations.js";
import { getChapterBody } from "./writing.js";

export const DOCUMENT_MD_KIND = "document-markdown";
export const DOCUMENT_DOCX_KIND = "document-docx";
export const DOCUMENT_PDF_KIND = "document-pdf";

export function contentHash(bytes: Buffer | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return createHash("sha256").update(buf).digest("hex").slice(0, 32);
}

export function buildDocumentMarkdown(
  session: DocumentSession,
  options: { includeBibliography?: boolean } = {}
): string {
  const lines: string[] = [
    `# ${session.outline?.title ?? session.title}`,
    "",
    `> Document session \`${session.id}\`${session.runId ? ` · run \`${session.runId}\`` : ""}`,
    `> Status: **${session.status}** · Bibliography: **${session.bibliographyStyle}**`,
    "",
    "## Goal",
    "",
    session.goal,
    ""
  ];

  if (session.outline) {
    lines.push("## Outline", "", session.outline.summary, "");
    for (const s of session.outline.sections) {
      lines.push(`### ${s.order + 1}. ${s.title}`);
      lines.push(s.summary);
      if (s.acceptanceCriteria.length) {
        lines.push("", "**Acceptance:**");
        for (const c of s.acceptanceCriteria) lines.push(`- ${c}`);
      }
      if (s.missingData.length) {
        lines.push("", "**Missing data:**");
        for (const m of s.missingData) lines.push(`- ${m}`);
      }
      lines.push("");
    }
  }

  lines.push("## Chapters", "");
  const ordered = orderChapters(session);
  if (ordered.length === 0) {
    lines.push("_No chapters written yet._", "");
  } else {
    for (const ch of ordered) {
      lines.push(`## ${ch.title}`, "");
      lines.push(getChapterBody(ch), "");
    }
  }

  // Content origin note
  lines.push("---", "");
  lines.push("## Provenance", "");
  lines.push("- Chapter bodies: **generated** (AI)");
  lines.push(
    `- Materials: ${session.materials.filter((m) => m.contentOrigin === "original").length} original, ${session.materials.filter((m) => m.contentOrigin === "generated").length} generated`
  );
  lines.push(`- Evidence bound: ${session.evidence.length}`);
  lines.push(`- Project facts: ${session.projectFacts.length}`);
  lines.push("");

  if (options.includeBibliography !== false && session.citations.length > 0) {
    lines.push(formatBibliography(session.citations, session.bibliographyStyle));
  }

  lines.push(`_Exported ${session.updatedAt}_`, "");
  return lines.join("\n");
}

/**
 * Minimal OOXML DOCX (ZIP store). Round-trips with importDocxFromBytes.
 */
export function buildDocumentDocx(session: DocumentSession): Buffer {
  const md = buildDocumentMarkdown(session, { includeBibliography: true });
  const paragraphs = md.split(/\r?\n/);
  const bodyXml = paragraphs
    .map((line) => {
      const escaped = escapeXml(line.length ? line : " ");
      return `<w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`;
    })
    .join("");

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyXml}<w:sectPr/></w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  return buildZipStore([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") }
  ]);
}

/**
 * Minimal multi-line text PDF (Helvetica, simple layout).
 */
export function buildDocumentPdf(session: DocumentSession): Buffer {
  const md = buildDocumentMarkdown(session, { includeBibliography: true });
  const lines = wrapLines(md.replace(/\t/g, "  ").split(/\r?\n/), 90).slice(0, 200);
  const fontSize = 10;
  const leading = 12;
  const startY = 780;
  const contentLines: string[] = ["BT", `/F1 ${fontSize} Tf`, `50 ${startY} Td`, `${leading} TL`];
  for (let i = 0; i < lines.length; i++) {
    const safe = pdfEscape(lines[i] ?? "");
    if (i === 0) contentLines.push(`(${safe}) Tj`);
    else contentLines.push(`T* (${safe}) Tj`);
  }
  contentLines.push("ET");
  const stream = contentLines.join("\n");
  const streamBytes = Buffer.from(stream, "utf8");

  const objects: string[] = [];
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  objects.push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`
  );
  objects.push(
    `4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${stream}\nendstream\nendobj\n`
  );
  objects.push(`5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += `0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

export function defaultExportPaths(session: DocumentSession): {
  markdown: string;
  docx: string;
  pdf: string;
} {
  const slug = slugify(session.outline?.title ?? session.title) || "document";
  return {
    markdown: `${slug}.md`,
    docx: `${slug}.docx`,
    pdf: `${slug}.pdf`
  };
}

function orderChapters(session: DocumentSession): Chapter[] {
  if (!session.outline) return [...session.chapters];
  const bySection = new Map(session.chapters.map((c) => [c.sectionId, c]));
  const ordered: Chapter[] = [];
  for (const s of session.outline.sections) {
    const ch = bySection.get(s.id);
    if (ch) ordered.push(ch);
  }
  for (const ch of session.chapters) {
    if (!ordered.includes(ch)) ordered.push(ch);
  }
  return ordered;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pdfEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLines(lines: string[], max: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= max) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > max) {
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** CRC-32 (ISO 3309) for ZIP local headers. */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Build a ZIP archive using store (method 0) only — pure JS, no deps.
 */
export function buildZipStore(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra
    nameBuf.copy(local, 30);

    localParts.push(local, entry.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralParts.push(central);

    offset += local.length + entry.data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const centralOffset = offset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, end]);
}

// re-export types used by tests
export type { DocumentOutline, Chapter, Citation, BibliographyStyle };
