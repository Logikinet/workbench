/**
 * Import Markdown / Word / PDF templates and user materials (Task 33).
 * Distinguishes original material from generated content via contentOrigin.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  extractPdfMetadataFromBytes,
  PdfImportError
} from "../research/pdfImport.js";
import type { ResearchEvidence } from "../research/researchTypes.js";
import type {
  ContentOrigin,
  DocumentMaterial,
  MaterialFormat,
  MaterialKind
} from "./documentTypes.js";

export class MaterialImportError extends Error {
  constructor(
    message: string,
    readonly code: "unsupported" | "empty" | "read_failed" | "parse_failed"
  ) {
    super(message);
    this.name = "MaterialImportError";
  }
}

export function hashMaterialText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

export function createMaterial(input: {
  title: string;
  kind: MaterialKind;
  format: MaterialFormat;
  text: string;
  contentOrigin?: ContentOrigin;
  sourcePath?: string;
  evidenceId?: string;
  metadata?: Record<string, unknown>;
  id?: string;
  now?: () => Date;
}): DocumentMaterial {
  const text = input.text ?? "";
  if (!text.trim() && input.kind !== "generated") {
    throw new MaterialImportError("Material text is empty.", "empty");
  }
  const now = input.now ?? (() => new Date());
  return {
    id: input.id ?? randomUUID(),
    title: input.title.trim() || "Untitled",
    kind: input.kind,
    format: input.format,
    contentOrigin: input.contentOrigin ?? (input.kind === "generated" ? "generated" : "original"),
    text,
    sourcePath: input.sourcePath,
    evidenceId: input.evidenceId,
    metadata: input.metadata,
    contentHash: hashMaterialText(text),
    createdAt: now().toISOString()
  };
}

/** Import Markdown text (template or user material). */
export function importMarkdownText(input: {
  title?: string;
  text: string;
  kind?: "template" | "user_material";
  sourcePath?: string;
  now?: () => Date;
}): DocumentMaterial {
  const kind = input.kind ?? "user_material";
  const title =
    input.title
    ?? extractMarkdownTitle(input.text)
    ?? (input.sourcePath ? basename(input.sourcePath, extname(input.sourcePath)) : "Markdown");
  return createMaterial({
    title,
    kind,
    format: "markdown",
    text: input.text,
    contentOrigin: "original",
    sourcePath: input.sourcePath,
    now: input.now
  });
}

export async function importMarkdownFile(
  path: string,
  options: { kind?: "template" | "user_material"; title?: string; now?: () => Date } = {}
): Promise<DocumentMaterial> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new MaterialImportError(`Unable to read Markdown: ${msg}`, "read_failed");
  }
  return importMarkdownText({
    title: options.title,
    text,
    kind: options.kind,
    sourcePath: path,
    now: options.now
  });
}

/**
 * Import DOCX bytes. Pure parser: locates word/document.xml inside the ZIP
 * (store or deflate stored as raw scan for <w:t> text runs).
 */
export function importDocxFromBytes(input: {
  bytes: Buffer;
  title?: string;
  kind?: "template" | "user_material";
  sourcePath?: string;
  now?: () => Date;
}): DocumentMaterial {
  if (input.bytes.length === 0) {
    throw new MaterialImportError("DOCX file is empty.", "empty");
  }
  // ZIP local header magic
  if (input.bytes[0] !== 0x50 || input.bytes[1] !== 0x4b) {
    // Allow pre-extracted plain text labeled as docx for tests without ZIP.
    const asText = input.bytes.toString("utf8");
    if (asText.trim().startsWith("PK")) {
      throw new MaterialImportError("DOCX ZIP header invalid.", "parse_failed");
    }
    return createMaterial({
      title: input.title ?? basename(input.sourcePath ?? "document.docx", ".docx"),
      kind: input.kind ?? "user_material",
      format: "docx",
      text: asText,
      contentOrigin: "original",
      sourcePath: input.sourcePath,
      metadata: { note: "plain-text-docx-fallback" },
      now: input.now
    });
  }

  const xml = extractZipEntryText(input.bytes, "word/document.xml");
  if (!xml) {
    throw new MaterialImportError("DOCX missing word/document.xml.", "parse_failed");
  }
  const text = extractDocxTextFromXml(xml);
  if (!text.trim()) {
    throw new MaterialImportError("DOCX document text is empty.", "empty");
  }
  return createMaterial({
    title: input.title ?? basename(input.sourcePath ?? "document.docx", ".docx"),
    kind: input.kind ?? "user_material",
    format: "docx",
    text,
    contentOrigin: "original",
    sourcePath: input.sourcePath,
    metadata: { entry: "word/document.xml" },
    now: input.now
  });
}

export async function importDocxFile(
  path: string,
  options: { kind?: "template" | "user_material"; title?: string; now?: () => Date } = {}
): Promise<DocumentMaterial> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new MaterialImportError(`Unable to read DOCX: ${msg}`, "read_failed");
  }
  return importDocxFromBytes({
    bytes,
    title: options.title,
    kind: options.kind,
    sourcePath: path,
    now: options.now
  });
}

/** Import PDF as original material (metadata + optional page text via extractor). */
export async function importPdfMaterial(
  path: string,
  options: {
    kind?: "template" | "user_material";
    title?: string;
    pageTexts?: Array<{ page: number; text: string }>;
    now?: () => Date;
  } = {}
): Promise<DocumentMaterial> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new MaterialImportError(`Unable to read PDF: ${msg}`, "read_failed");
  }
  return importPdfMaterialFromBytes({
    bytes,
    sourcePath: path,
    kind: options.kind,
    title: options.title,
    pageTexts: options.pageTexts,
    now: options.now
  });
}

export function importPdfMaterialFromBytes(input: {
  bytes: Buffer;
  sourcePath?: string;
  kind?: "template" | "user_material";
  title?: string;
  pageTexts?: Array<{ page: number; text: string }>;
  now?: () => Date;
}): DocumentMaterial {
  let metadata;
  try {
    metadata = extractPdfMetadataFromBytes(input.bytes);
  } catch (error: unknown) {
    if (error instanceof PdfImportError) {
      throw new MaterialImportError(error.message, "parse_failed");
    }
    throw error;
  }
  const pageText =
    input.pageTexts?.map((p) => `--- page ${p.page} ---\n${p.text}`).join("\n\n")
    ?? "";
  const text =
    pageText.trim()
    || [
      metadata.title ? `Title: ${metadata.title}` : "",
      metadata.author ? `Author: ${metadata.author}` : "",
      metadata.subject ? `Subject: ${metadata.subject}` : "",
      metadata.pageCount !== undefined ? `Pages: ${metadata.pageCount}` : ""
    ]
      .filter(Boolean)
      .join("\n")
    || "(PDF imported — no extractable text; metadata only)";

  return createMaterial({
    title: input.title ?? metadata.title ?? basename(input.sourcePath ?? "document.pdf", ".pdf"),
    kind: input.kind ?? "user_material",
    format: "pdf",
    text,
    contentOrigin: "original",
    sourcePath: input.sourcePath,
    metadata: { ...metadata },
    now: input.now
  });
}

/** Bind a ResearchEvidence item as original document material. */
export function materialFromEvidence(
  evidence: ResearchEvidence,
  options: { now?: () => Date } = {}
): DocumentMaterial {
  return createMaterial({
    title: evidence.title,
    kind: "evidence",
    format: "plain",
    text: evidence.excerpt || evidence.body || "",
    contentOrigin: "original",
    sourcePath: evidence.source,
    evidenceId: evidence.id,
    metadata: {
      origin: evidence.origin,
      author: evidence.author,
      publishedAt: evidence.publishedAt,
      trustScore: evidence.trustScore,
      qualityFlags: evidence.qualityFlags
    },
    now: options.now
  });
}

export function materialFromProjectFact(
  fact: string,
  options: { title?: string; now?: () => Date } = {}
): DocumentMaterial {
  return createMaterial({
    title: options.title ?? "Project fact",
    kind: "project_fact",
    format: "plain",
    text: fact,
    contentOrigin: "original",
    now: options.now
  });
}

export function isOriginalMaterial(m: DocumentMaterial): boolean {
  return m.contentOrigin === "original" && m.kind !== "generated";
}

export function isGeneratedMaterial(m: DocumentMaterial): boolean {
  return m.contentOrigin === "generated" || m.kind === "generated";
}

function extractMarkdownTitle(text: string): string | undefined {
  const m = text.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim() || undefined;
}

/**
 * Extract text runs from WordprocessingML.
 * Handles <w:t>...</w:t> and inserts newlines on paragraph ends.
 */
export function extractDocxTextFromXml(xml: string): string {
  const paragraphs = xml.split(/<\/w:p>/i);
  const lines: string[] = [];
  for (const para of paragraphs) {
    const runs: string[] = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(para)) !== null) {
      runs.push(decodeXmlEntities(match[1] ?? ""));
    }
    if (runs.length > 0) lines.push(runs.join(""));
  }
  return lines.join("\n").trim();
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Minimal ZIP local-file scan for a stored (method 0) entry by name.
 * Deflated entries are not fully inflated here — we only support store method
 * for pure import of our own exports / test fixtures.
 */
export function extractZipEntryText(bytes: Buffer, entryName: string): string | undefined {
  const nameBuf = Buffer.from(entryName, "utf8");
  let offset = 0;
  while (offset + 30 < bytes.length) {
    if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4b) break;
    // local file header
    if (bytes[offset + 2] !== 0x03 || bytes[offset + 3] !== 0x04) {
      // central directory or other — stop scan
      break;
    }
    const method = bytes.readUInt16LE(offset + 8);
    const compSize = bytes.readUInt32LE(offset + 18);
    const nameLen = bytes.readUInt16LE(offset + 26);
    const extraLen = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = bytes.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (name === entryName) {
      if (method !== 0) {
        // Try raw UTF-8 if someone stored uncompressed-looking XML anyway
        const raw = bytes.subarray(dataStart, dataEnd);
        const asStr = raw.toString("utf8");
        if (asStr.includes("<w:t") || asStr.includes("<?xml")) return asStr;
        return undefined;
      }
      return bytes.subarray(dataStart, dataEnd).toString("utf8");
    }
    offset = dataEnd;
    if (compSize === 0 && nameLen === 0) break;
  }
  // Fallback: search for document.xml path string and nearby <w:document
  const marker = Buffer.from(entryName, "utf8");
  const idx = bytes.indexOf(marker);
  if (idx >= 0) {
    const xmlStart = bytes.indexOf(Buffer.from("<?xml"), idx);
    const altStart = bytes.indexOf(Buffer.from("<w:document"), idx);
    const start = xmlStart >= 0 ? xmlStart : altStart;
    if (start >= 0) {
      const endTag = Buffer.from("</w:document>");
      const end = bytes.indexOf(endTag, start);
      if (end > start) {
        return bytes.subarray(start, end + endTag.length).toString("utf8");
      }
    }
  }
  return undefined;
}
