/**
 * Machine-readable Status / Doctor types (Task 44).
 *
 * Inspired by NextClaw `status --json` / `doctor --json` shapes:
 * Firstmate and tools must use these fields — never parse UI copy.
 */

/** Outcome of a single doctor check. */
export type DoctorCheckStatus = "pass" | "warn" | "fail" | "skip";

/** Aggregate runtime health level. */
export type RuntimeHealthLevel = "healthy" | "degraded" | "stopped" | "unknown";

export type DoctorCheckCategory =
  | "service"
  | "tray"
  | "pwa"
  | "port"
  | "data"
  | "credentials"
  | "disk"
  | "providers"
  | "models"
  | "codex"
  | "runtime"
  | "mcp"
  | "git"
  | "worktree"
  | "office"
  | "logs";

/** Stable check ids used by fix/re-run contracts. */
export const doctorCheckIds = [
  "service-process",
  "service-health",
  "tray-presence",
  "pwa-assets",
  "port-bind",
  "data-directory",
  "state-files",
  "credential-manager",
  "disk-space",
  "providers",
  "models",
  "codex-cli",
  "runtime-adapters",
  "mcp-connections",
  "git-cli",
  "worktree-service",
  "office-wps",
  "log-directory"
] as const;

export type DoctorCheckId = (typeof doctorCheckIds)[number];

export interface DoctorCheck {
  id: DoctorCheckId | string;
  name: string;
  category: DoctorCheckCategory;
  status: DoctorCheckStatus;
  /** Machine-oriented short code (stable for automation). */
  code: string;
  /** Human-readable detail (may be shown in UI; Firstmate should prefer `code` + `meta`). */
  detail: string;
  /** Explicit remediation step; auto-fix never runs without user confirm. */
  remediation?: string;
  /** Whether a safe fix is available when confirm=true. */
  fixable?: boolean;
  meta?: Record<string, unknown>;
}

export interface DoctorCheckSummary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
  total: number;
}

export interface HealthProbeResult {
  state: "ok" | "unreachable" | "invalid-response";
  detail: string;
  httpStatus?: number;
  payload?: unknown;
}

export interface RuntimeProcessInfo {
  pid: number | null;
  running: boolean;
  uptimeMs?: number;
  startedAt?: string;
  /** Stale pid file pointing at a dead process. */
  stalePidFile?: boolean;
  pidFilePath?: string;
}

export interface RuntimeEndpoints {
  bindHost: string;
  port: number;
  apiUrl: string;
  healthUrl: string;
  pwaUrl: string;
}

export interface RuntimeStatusReport {
  generatedAt: string;
  version: string;
  level: RuntimeHealthLevel;
  /** 0 = healthy, 1 = degraded/stopped/warnings. */
  exitCode: 0 | 1;
  process: RuntimeProcessInfo;
  endpoints: RuntimeEndpoints;
  dataDirectory: string;
  logDirectory: string;
  health: HealthProbeResult;
  issues: string[];
  recommendations: string[];
  /** Redacted recent service log lines (size-capped). */
  logTail: string[];
  summary: DoctorCheckSummary;
  /** Optional lightweight check ids that drove the summary (omit heavy meta). */
  checkIds?: string[];
}

export interface DoctorReport {
  generatedAt: string;
  checks: DoctorCheck[];
  status: RuntimeStatusReport;
  exitCode: 0 | 1;
  /** Applied only when fix was requested with explicit confirm. */
  fixActions: string[];
  recommendations: string[];
  summary: DoctorCheckSummary;
}

export type LogKind = "service" | "crash" | "archive";

export interface LogQuery {
  kind?: LogKind;
  /** Max lines to return (default 100, hard cap 500). */
  lines?: number;
  /** Default true — secrets are always stripped when true. */
  redact?: boolean;
  /** Archive file name when kind=archive. */
  archiveName?: string;
}

export interface LogSlice {
  kind: LogKind;
  path: string;
  lines: string[];
  redacted: boolean;
  truncated: boolean;
  lineCount: number;
  maxBytes: number;
}

export interface LogArchiveEntry {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt?: string;
}

export interface DiagnosticPackManifest {
  generatedAt: string;
  version: string;
  packId: string;
  directory: string;
  files: string[];
  secretsExcluded: true;
  redacted: true;
  doctorExitCode: 0 | 1;
  level: RuntimeHealthLevel;
}

export interface DiagnosticPackResult {
  manifest: DiagnosticPackManifest;
  report: DoctorReport;
}

/**
 * Safe fix request. `confirm` MUST be the boolean true —
 * auto-fix is forbidden without explicit user confirmation.
 */
export interface DoctorFixRequest {
  confirm: true;
  /** Optional subset of check ids; default = all fixable failed/warn checks. */
  checkIds?: string[];
}

export interface DoctorRunOptions {
  /** Include verbose log tail on status. */
  verbose?: boolean;
  /** When true with confirm, attempt safe fixes before re-check. */
  fix?: boolean;
  confirm?: boolean;
  checkIds?: string[];
}

/** Firstmate / operator contract for status+doctor (read before invoking). */
export interface DoctorOperationContract {
  schemaVersion: 1;
  name: "paw.doctor";
  description: string;
  commands: Array<{
    name: string;
    method: "GET" | "POST";
    path: string;
    description: string;
    requiresConfirm?: boolean;
    inputSchema?: Record<string, unknown>;
  }>;
  checkIds: readonly string[];
  checkStatuses: readonly DoctorCheckStatus[];
  healthLevels: readonly RuntimeHealthLevel[];
  notes: string[];
}

export const DOCTOR_OPERATION_CONTRACT: DoctorOperationContract = {
  schemaVersion: 1,
  name: "paw.doctor",
  description:
    "Machine-readable runtime Status and Doctor diagnostics for Personal AI Workbench. Use JSON fields only; never infer health from UI text.",
  commands: [
    {
      name: "status",
      method: "GET",
      path: "/api/doctor/status",
      description: "Collect runtime status report (process, endpoints, health, summary)."
    },
    {
      name: "doctor",
      method: "GET",
      path: "/api/doctor",
      description: "Run full doctor checks and return pass/warn/fail with remediation."
    },
    {
      name: "run",
      method: "POST",
      path: "/api/doctor/run",
      description: "Re-run doctor (closed-loop verification after config/fix).",
      inputSchema: {
        type: "object",
        properties: {
          verbose: { type: "boolean" },
          checkIds: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      }
    },
    {
      name: "fix",
      method: "POST",
      path: "/api/doctor/fix",
      description: "Apply safe fixes only. Requires confirm=true (explicit user confirmation).",
      requiresConfirm: true,
      inputSchema: {
        type: "object",
        required: ["confirm"],
        properties: {
          confirm: { const: true },
          checkIds: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      }
    },
    {
      name: "logs",
      method: "GET",
      path: "/api/doctor/logs",
      description: "Read current service logs (redacted by default, size-capped)."
    },
    {
      name: "crash-logs",
      method: "GET",
      path: "/api/doctor/logs/crash",
      description: "Read crash logs (redacted by default)."
    },
    {
      name: "log-archives",
      method: "GET",
      path: "/api/doctor/logs/archives",
      description: "List rotated log archives."
    },
    {
      name: "export",
      method: "POST",
      path: "/api/doctor/export",
      description: "Export a diagnostic pack without secrets."
    },
    {
      name: "contract",
      method: "GET",
      path: "/api/doctor/contract",
      description: "Read this operation contract and allowed schemas before self-management."
    }
  ],
  checkIds: doctorCheckIds,
  checkStatuses: ["pass", "warn", "fail", "skip"],
  healthLevels: ["healthy", "degraded", "stopped", "unknown"],
  notes: [
    "After any fix or config change, call POST /api/doctor/run and verify exitCode===0 and level==='healthy'.",
    "Auto-fix requires body.confirm === true; missing confirm is rejected.",
    "Logs and diagnostic packs always redact secrets (api keys, tokens, PEMs, Authorization headers).",
    "Do not invent check ids or health levels outside this contract."
  ]
};

export const DEFAULT_LOG_LINES = 100;
export const MAX_LOG_LINES = 500;
export const DEFAULT_MAX_LOG_BYTES = 256 * 1024;
export const DEFAULT_MIN_FREE_DISK_BYTES = 512 * 1024 * 1024;
export const DEFAULT_SERVICE_PORT = 41731;
export const DEFAULT_BIND_HOST = "127.0.0.1";
