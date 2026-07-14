/**
 * Minimal ZIP reader + OOXML text extraction for readonly DOCX/XLSX/PPTX previews.
 * No third-party dependency. Does not rewrite source files.
 */

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
  compressedSize: number;
  uncompressedSize: number;
}

const STORED = 0;
const DEFLATE = 8;

/**
 * Parse a ZIP buffer and return selected entries (or all when filter omitted).
 * Supports store + deflate only (sufficient for OOXML).
 */
export function readZipEntries(buffer: Buffer, filter?: (name: string) => boolean): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // local file header

    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd + extraLen > buffer.length) break;

    const name = buffer.subarray(nameStart, nameEnd).toString("utf8");
    const dataStart = nameEnd + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) break;

    const compressed = buffer.subarray(dataStart, dataEnd);
    offset = dataEnd;

    if (filter && !filter(name)) continue;
    if (name.endsWith("/")) continue;

    let data: Buffer;
    try {
      if (compression === STORED) {
        data = Buffer.from(compressed);
      } else if (compression === DEFLATE) {
        data = inflateRawSync(compressed);
      } else {
        continue;
      }
    } catch {
      continue;
    }

    if (uncompressedSize > 0 && data.length !== uncompressedSize && compression === STORED) {
      // tolerate mismatch
    }
    entries.push({ name, data, compressedSize, uncompressedSize });
  }

  return entries;
}

function stripXml(xml: string): string {
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    const inner = m[1] ?? "";
    const parts: string[] = [];
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(inner))) {
      parts.push(decodeXmlEntities(t[1] ?? ""));
    }
    strings.push(parts.join(""));
  }
  return strings;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export interface OoxmlPreview {
  text: string;
  html: string;
  parts: string[];
}

export function previewDocx(buffer: Buffer, maxChars: number): OoxmlPreview {
  const entries = readZipEntries(buffer, (name) => name === "word/document.xml");
  const doc = entries.find((e) => e.name === "word/document.xml");
  if (!doc) {
    return { text: "", html: "<p><em>DOCX document.xml not found</em></p>", parts: [] };
  }
  const xml = doc.data.toString("utf8");
  let text = stripXml(xml);
  if (text.length > maxChars) text = text.slice(0, maxChars);
  const html = `<article class="paw-docx-preview"><pre>${escapeHtml(text)}</pre></article>`;
  return { text, html, parts: ["document"] };
}

export function previewXlsx(buffer: Buffer, maxChars: number): OoxmlPreview {
  const entries = readZipEntries(
    buffer,
    (name) =>
      name === "xl/sharedStrings.xml" ||
      name.startsWith("xl/worksheets/sheet") ||
      name === "xl/workbook.xml"
  );
  const shared = entries.find((e) => e.name === "xl/sharedStrings.xml");
  const strings = shared ? extractSharedStrings(shared.data.toString("utf8")) : [];
  const sheets = entries
    .filter((e) => e.name.startsWith("xl/worksheets/sheet") && e.name.endsWith(".xml"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parts: string[] = [];
  const lines: string[] = [];
  let total = 0;

  for (const [idx, sheet] of sheets.entries()) {
    const name = `Sheet${idx + 1}`;
    parts.push(name);
    lines.push(`## ${name}`);
    const xml = sheet.data.toString("utf8");
    const rowRe = /<c\b([^>]*)>(?:<v>([\s\S]*?)<\/v>)?/g;
    let cell: RegExpExecArray | null;
    const cells: string[] = [];
    while ((cell = rowRe.exec(xml))) {
      const attrs = cell[1] ?? "";
      const v = cell[2] ?? "";
      const isShared = /\bt="s"/.test(attrs);
      let value = decodeXmlEntities(v);
      if (isShared) {
        const i = Number(value);
        value = Number.isFinite(i) ? (strings[i] ?? value) : value;
      }
      if (value) cells.push(value);
      if (cells.length >= 200) break;
    }
    const rowText = cells.join("\t");
    lines.push(rowText);
    total += rowText.length;
    if (total >= maxChars) break;
  }

  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars);
  const html = `<article class="paw-xlsx-preview"><pre>${escapeHtml(text)}</pre></article>`;
  return { text, html, parts };
}

export function previewPptx(buffer: Buffer, maxChars: number): OoxmlPreview {
  const entries = readZipEntries(buffer, (name) => name.startsWith("ppt/slides/slide") && name.endsWith(".xml"));
  const slides = entries.sort((a, b) => a.name.localeCompare(b.name));
  const parts: string[] = [];
  const lines: string[] = [];
  let total = 0;

  for (const [idx, slide] of slides.entries()) {
    const name = `Slide ${idx + 1}`;
    parts.push(name);
    lines.push(`## ${name}`);
    const xml = slide.data.toString("utf8");
    // a:t text runs
    const texts: string[] = [];
    const tRe = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
    let m: RegExpExecArray | null;
    while ((m = tRe.exec(xml))) {
      texts.push(decodeXmlEntities(m[1] ?? ""));
    }
    const body = texts.join(" ");
    lines.push(body);
    total += body.length;
    if (total >= maxChars) break;
  }

  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars);
  const html = `<article class="paw-pptx-preview"><pre>${escapeHtml(text)}</pre></article>`;
  return { text, html, parts };
}

/** Estimate PDF page count from /Type /Page occurrences (heuristic, not a full parser). */
export function estimatePdfPageCount(buffer: Buffer): number | undefined {
  const text = buffer.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page\b/g);
  if (!matches) return undefined;
  // /Pages dictionaries also match sometimes — prefer Count
  const countMatch = text.match(/\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/);
  if (countMatch?.[1]) {
    const n = Number(countMatch[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return matches.length > 0 ? matches.length : undefined;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a simple ZIP (store only) for packaging exports without deps.
 */
export function buildStoredZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
    const data = file.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(STORED, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    localParts.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(STORED, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const centralOffset = offset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, end]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
