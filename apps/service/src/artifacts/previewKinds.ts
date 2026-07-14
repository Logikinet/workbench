/**
 * Extension → preview kind + mime mapping (Task 42).
 * Preview classification only — never rewrites the underlying file.
 */

import type { PreviewKind } from "./artifactTypes.js";
import { extensionOf } from "./pathSafety.js";

const CODE_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "cs",
  "cpp",
  "cc",
  "c",
  "h",
  "hpp",
  "rb",
  "php",
  "swift",
  "sql",
  "sh",
  "bash",
  "ps1",
  "bat",
  "cmd",
  "vue",
  "svelte",
  "graphql",
  "gql",
  "proto",
  "dockerfile",
  "makefile",
  "cmake",
  "r",
  "lua",
  "pl",
  "scala",
  "dart"
]);

const TEXT_EXT = new Set([
  "txt",
  "log",
  "csv",
  "tsv",
  "env",
  "gitignore",
  "gitattributes",
  "editorconfig",
  "npmrc",
  "prettierrc",
  "eslintrc",
  "lock",
  "out",
  "err"
]);

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

const MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint"
};

export function classifyPreviewKind(nameOrPath: string, isDirectory = false): PreviewKind {
  if (isDirectory) return "directory";
  const ext = extensionOf(nameOrPath);
  const base = nameOrPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";

  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx") return "xlsx";
  if (ext === "pptx") return "pptx";
  if (IMAGE_EXT.has(ext)) return "image";
  if (CODE_EXT.has(ext) || base === "dockerfile" || base === "makefile") return "code";
  if (TEXT_EXT.has(ext) || ext === "") {
    // extensionless files treated as text until binary sniff
    if (ext === "") return "text";
    return "text";
  }
  if (ext === "doc" || ext === "xls" || ext === "ppt") return "binary";
  return "unknown";
}

export function mimeFor(nameOrPath: string, previewKind?: PreviewKind): string {
  const ext = extensionOf(nameOrPath);
  if (MIME[ext]) return MIME[ext];
  switch (previewKind ?? classifyPreviewKind(nameOrPath)) {
    case "markdown":
      return "text/markdown";
    case "code":
      return "text/plain";
    case "text":
      return "text/plain";
    case "image":
      return "application/octet-stream";
    case "pdf":
      return "application/pdf";
    case "docx":
      return MIME.docx!;
    case "xlsx":
      return MIME.xlsx!;
    case "pptx":
      return MIME.pptx!;
    default:
      return "application/octet-stream";
  }
}

export function languageHint(nameOrPath: string): string | undefined {
  const ext = extensionOf(nameOrPath);
  const base = nameOrPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    rb: "ruby",
    php: "php",
    sh: "bash",
    bash: "bash",
    ps1: "powershell",
    yml: "yaml",
    yaml: "yaml",
    sql: "sql",
    css: "css",
    html: "html",
    xml: "xml",
    md: "markdown",
    markdown: "markdown"
  };
  return map[ext];
}

/** Heuristic: if a high fraction of bytes are null/control, treat as binary. */
export function looksBinary(buffer: Buffer, sampleBytes = 8000): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, sampleBytes));
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]!;
    if (b === 0) return true;
    // Allow common whitespace controls
    if (b < 7 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.3;
}
