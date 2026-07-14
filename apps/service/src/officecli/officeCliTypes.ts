/**
 * OfficeCLI Runtime types (Task 48).
 * Formal harness surface — agents never shell-string OfficeCLI commands.
 */

export type OfficeCliDocumentKind = "docx" | "xlsx" | "pptx";

export interface OfficeCliCapabilities {
  installed: boolean;
  version?: string;
  executablePath?: string;
  supportsCreate: boolean;
  supportsView: boolean;
  supportsBatch: boolean;
  supportsRender: boolean;
  supportsValidate: boolean;
  detail: string;
  checkedAt: string;
}

export interface OfficeCliLogEntry {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  argv?: string[];
  exitCode?: number | null;
  createdAt: string;
  /** Full stdout/stderr stored on disk path when large. */
  logPath?: string;
  /** Redacted summary for model / Tool Card. */
  summary: string;
}

export interface OfficeResult {
  ok: boolean;
  path: string;
  backupPath?: string;
  restoredFromBackup?: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  logs: OfficeCliLogEntry[];
  message: string;
  durationMs: number;
}

export interface CreateDocumentInput {
  /** Absolute path inside project workspace. */
  path: string;
  kind?: OfficeCliDocumentKind;
  /** Optional template to copy before create/modify (read-only source). */
  templatePath?: string;
  runId?: string;
  workspaceRoot: string;
}

export interface DocumentInspection {
  path: string;
  kind: OfficeCliDocumentKind;
  outline?: string;
  text?: string;
  stats?: Record<string, unknown>;
  issues?: string[];
  structure?: unknown;
  rawSummary: string;
}

export type OfficeOperationKind =
  | "set_paragraph"
  | "append_paragraph"
  | "set_heading"
  | "insert_table"
  | "insert_image"
  | "set_header"
  | "set_footer"
  | "insert_toc"
  | "replace_text"
  | "raw";

export interface OfficeOperation {
  id: string;
  kind: OfficeOperationKind;
  /** DOM-style or CLI-native path when applicable. */
  target?: string;
  value?: string;
  args?: Record<string, unknown>;
  /** When true, operation is refused if Zotero fields may be present. */
  unsafeAfterDynamicCitation?: boolean;
}

export interface OfficeBatchInput {
  path: string;
  workspaceRoot: string;
  operations: OfficeOperation[];
  runId?: string;
  /** Fail-closed: stop and restore backup (default true). */
  stopOnError?: boolean;
  /** Refuse operations marked unsafeAfterDynamicCitation. */
  dynamicCitationsPresent?: boolean;
}

export interface RenderInput {
  path: string;
  workspaceRoot: string;
  /** Relative directory under workspace for preview artifacts. */
  outputDir: string;
  modes?: Array<"screenshot" | "outline" | "stats" | "issues">;
  runId?: string;
}

export interface PreviewArtifact {
  path: string;
  kind: "screenshot" | "outline" | "stats" | "issues" | "other";
  summary: string;
}

export interface DocumentValidation {
  path: string;
  ok: boolean;
  issues: string[];
  readable: boolean;
  message: string;
}

export interface OfficeCliRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Injectable process runner (argv only — never shell strings). */
export type OfficeCliRunner = (
  argv: string[],
  options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }
) => Promise<OfficeCliRunResult>;

export type OfficeCliPathResolver = () => Promise<{
  installed: boolean;
  path?: string;
  version?: string;
  detail: string;
}>;
