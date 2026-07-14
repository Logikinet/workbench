/**
 * PDF import + metadata extraction for research Evidence (Task 32).
 *
 * Pure helpers — no native PDF engine dependency. Parses Info dictionary
 * strings from the file bytes when present; page text is provided by an
 * injectable extractor (fake in tests, real engine later).
 */

import { readFile } from "node:fs/promises";
import type { PdfImportMetadata, PdfImportResult } from "./researchTypes.js";

export interface PdfPageExtractor {
  /**
   * Return page texts for a PDF path or buffer.
   * Implementations may be fakes or wrap a real library.
   */
  extractPages(input: { path: string; bytes: Buffer }): Promise<Array<{ page: number; text: string }>>;
}

export interface PdfImportOptions {
  extractor?: PdfPageExtractor;
  /** Injectable clock. */
  now?: () => Date;
}

export class PdfImportError extends Error {
  constructor(
    message: string,
    readonly code: "not_pdf" | "read_failed" | "empty"
  ) {
    super(message);
    this.name = "PdfImportError";
  }
}

/** Decode PDF literal string `(...)` with basic escape handling. */
function decodePdfLiteral(raw: string): string {
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\(\d{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** Decode PDF hex string `<...>`. */
function decodePdfHex(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2) || "00", 16));
  }
  // UTF-16BE BOM
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    }
    return s;
  }
  return Buffer.from(bytes).toString("latin1");
}

function extractPdfStringValue(body: string, key: string): string | undefined {
  // /Title (Hello)  or /Title <FEFF...>
  const lit = body.match(new RegExp(`/${key}\\s*\\(([\\s\\S]*?)\\)`));
  if (lit?.[1] !== undefined) return decodePdfLiteral(lit[1]);
  const hex = body.match(new RegExp(`/${key}\\s*<([0-9A-Fa-f\\s]+)>`));
  if (hex?.[1]) return decodePdfHex(hex[1]);
  return undefined;
}

/** Parse PDF date like D:20240101120000Z → ISO-ish string. */
export function parsePdfDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return raw.trim() || undefined;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00"] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
}

/**
 * Extract document Info metadata and approximate page count from PDF bytes.
 * Does not require a full PDF parser — best-effort for research provenance.
 */
export function extractPdfMetadataFromBytes(bytes: Buffer): PdfImportMetadata {
  const head = bytes.subarray(0, Math.min(bytes.length, 16)).toString("latin1");
  if (!head.startsWith("%PDF-")) {
    throw new PdfImportError("File does not start with %PDF- header.", "not_pdf");
  }

  // Scan a bounded window for Info-like keys (whole file if small).
  const windowSize = Math.min(bytes.length, 2_000_000);
  const body = bytes.subarray(0, windowSize).toString("latin1");

  const title = extractPdfStringValue(body, "Title");
  const author = extractPdfStringValue(body, "Author");
  const subject = extractPdfStringValue(body, "Subject");
  const creator = extractPdfStringValue(body, "Creator");
  const producer = extractPdfStringValue(body, "Producer");
  const creationDate = parsePdfDate(extractPdfStringValue(body, "CreationDate"));
  const modDate = parsePdfDate(extractPdfStringValue(body, "ModDate"));

  let keywords: string[] | undefined;
  const kw = extractPdfStringValue(body, "Keywords");
  if (kw) {
    keywords = kw.split(/[,;]/).map((k) => k.trim()).filter(Boolean);
  }

  // Count /Type /Page objects (approximate; enough for metadata).
  const pageMatches = body.match(/\/Type\s*\/Page(?![sA-Za-z])/g);
  const pageCount = pageMatches ? pageMatches.length : undefined;

  return {
    title: title?.trim() || undefined,
    author: author?.trim() || undefined,
    subject: subject?.trim() || undefined,
    creator: creator?.trim() || undefined,
    producer: producer?.trim() || undefined,
    creationDate,
    modDate,
    pageCount,
    keywords
  };
}

/** Default extractor returns empty pages (metadata-only import). */
export class EmptyPdfPageExtractor implements PdfPageExtractor {
  async extractPages(): Promise<Array<{ page: number; text: string }>> {
    return [];
  }
}

/**
 * Test fake: map path → pages; optionally generate minimal PDF-like bytes
 * when used with `buildMinimalPdf`.
 */
export class FakePdfPageExtractor implements PdfPageExtractor {
  private readonly byPath = new Map<string, Array<{ page: number; text: string }>>();

  seed(path: string, pages: Array<{ page: number; text: string }>): this {
    this.byPath.set(path, pages);
    return this;
  }

  async extractPages(input: { path: string; bytes: Buffer }): Promise<Array<{ page: number; text: string }>> {
    return this.byPath.get(input.path) ?? [];
  }
}

/** Build a tiny synthetic PDF buffer with an Info dictionary for unit tests. */
export function buildMinimalPdf(meta: {
  title?: string;
  author?: string;
  creationDate?: string;
  pageCount?: number;
}): Buffer {
  const title = meta.title ?? "Untitled";
  const author = meta.author ?? "Unknown";
  const creation = meta.creationDate ?? "D:20240115120000Z";
  const pages = meta.pageCount ?? 1;
  // Minimal objects: catalog, pages tree, N page objects, info.
  const pageObjs = Array.from({ length: pages }, (_, i) => {
    const objNum = 3 + i;
    return `${objNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`;
  }).join("");
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  const infoNum = 3 + pages;
  const body =
    `%PDF-1.4\n` +
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n` +
    pageObjs +
    `${infoNum} 0 obj\n<< /Title (${title}) /Author (${author}) /CreationDate (${creation}) >>\nendobj\n` +
    `trailer\n<< /Root 1 0 R /Info ${infoNum} 0 R >>\n` +
    `%%EOF\n`;
  return Buffer.from(body, "latin1");
}

export async function importPdf(
  path: string,
  options: PdfImportOptions = {}
): Promise<PdfImportResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new PdfImportError(`Unable to read PDF: ${msg}`, "read_failed");
  }
  if (bytes.length === 0) {
    throw new PdfImportError("PDF file is empty.", "empty");
  }

  const metadata = extractPdfMetadataFromBytes(bytes);
  const extractor = options.extractor ?? new EmptyPdfPageExtractor();
  const pages = await extractor.extractPages({ path, bytes });
  const now = options.now ?? (() => new Date());

  return {
    path,
    metadata,
    pages,
    importedAt: now().toISOString()
  };
}

/** Import from in-memory bytes (tests / uploads). */
export async function importPdfFromBytes(
  pathLabel: string,
  bytes: Buffer,
  options: PdfImportOptions = {}
): Promise<PdfImportResult> {
  if (bytes.length === 0) {
    throw new PdfImportError("PDF buffer is empty.", "empty");
  }
  const metadata = extractPdfMetadataFromBytes(bytes);
  const extractor = options.extractor ?? new EmptyPdfPageExtractor();
  const pages = await extractor.extractPages({ path: pathLabel, bytes });
  const now = options.now ?? (() => new Date());
  return {
    path: pathLabel,
    metadata,
    pages,
    importedAt: now().toISOString()
  };
}
