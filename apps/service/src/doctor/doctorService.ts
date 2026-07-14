/**
 * Doctor / runtime health service (Task 44).
 *
 * Inspired by NextClaw waitForHealth + status/doctor --json:
 * machine-readable checks, redacted logs, diagnostic pack without secrets.
 * Auto-fix never runs without explicit user confirmation.
 */

import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../model/redact.js";
import type { DiskStatsProvider } from "../queue/resourceGuardService.js";
import { NodeDiskStatsProvider } from "../queue/resourceGuardService.js";

/**
 * Log-oriented redaction on top of shared `redactSecrets`.
 * Catches bare `password=…` / `token=…` forms that the shared key-prefix regex
 * misses (it requires a non-empty prefix before password|token|secret|key).
 */
export function redactLogText(value: string): string {
  let result = redactSecrets(value);
  const extra: Array<{ pattern: RegExp; replacement: string }> = [
    {
      pattern:
        /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|credential|private[_-]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      replacement: "$1: [REDACTED]"
    },
    { pattern: /\bBearer\s+[A-Za-z0-9._\-+=/]+/gi, replacement: "Bearer [REDACTED]" }
  ];
  for (const { pattern, replacement } of extra) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
import {
  DEFAULT_BIND_HOST,
  DEFAULT_LOG_LINES,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_MIN_FREE_DISK_BYTES,
  DEFAULT_SERVICE_PORT,
  DOCTOR_OPERATION_CONTRACT,
  type DiagnosticPackManifest,
  type DiagnosticPackResult,
  type DoctorCheck,
  type DoctorCheckSummary,
  type DoctorFixRequest,
  type DoctorOperationContract,
  type DoctorReport,
  type DoctorRunOptions,
  type HealthProbeResult,
  type LogArchiveEntry,
  type LogKind,
  type LogQuery,
  type LogSlice,
  type RuntimeHealthLevel,
  type RuntimeStatusReport,
  MAX_LOG_LINES
} from "./doctorTypes.js";

// ── Injectable ports ─────────────────────────────────────────────────────────

export interface DoctorFs {
  access(path: string, mode?: number): Promise<void>;
  mkdir(path: string, options?: { recursive: boolean }): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; mtime: Date; isDirectory(): boolean; isFile(): boolean }>;
}

export interface DoctorConnectionView {
  id: string;
  name: string;
  enabled: boolean;
  credentialPresent: boolean;
  modelId: string;
  lastTest?: { kind: string; message?: string };
}

export interface DoctorCodexStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  reason?: string;
}

export interface DoctorMcpView {
  id: string;
  name: string;
  enabled: boolean;
  credentialPresent?: boolean;
  tools?: unknown[];
  lastTest?: { kind: string; message?: string };
}

export interface DoctorGitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface DoctorRuntimeAdapterView {
  harness: string;
  capabilities?: () => { streaming?: boolean; tools?: boolean; [key: string]: unknown };
  probe?: () => Promise<{ ok: boolean; detail?: string; [key: string]: unknown }>;
}

export interface DoctorTrayPresence {
  present: boolean;
  pid?: number | null;
  detail: string;
}

export interface DoctorOfficeAvailability {
  office: boolean;
  wps: boolean;
  detail: string;
}

export interface DoctorPortProbe {
  listening: boolean;
  detail: string;
}

export interface DoctorServiceOptions {
  version: string;
  dataDirectory: string;
  bindHost?: string;
  port?: number;
  /** When the doctor runs inside the live service process. */
  servicePid?: number | null;
  serviceStartedAt?: string;
  now?: () => Date;
  fs?: DoctorFs;
  logDirectory?: string;
  /** Relative state file names under dataDirectory. */
  stateFiles?: string[];
  disk?: DiskStatsProvider;
  minFreeDiskBytes?: number;
  maxLogBytes?: number;
  connections?: { listPublic(): Promise<DoctorConnectionView[]> | DoctorConnectionView[] };
  codex?: { status(): Promise<DoctorCodexStatus> };
  mcp?: { listPublic(): Promise<DoctorMcpView[]> | DoctorMcpView[] };
  git?: { run(args: string[], cwd?: string): Promise<DoctorGitResult> };
  worktrees?: {
    list?(): Promise<unknown[]> | unknown[];
    countActive?(): Promise<number> | number;
    statePath?: string;
  };
  runtimes?: {
    list(): DoctorRuntimeAdapterView[];
  };
  tray?: DoctorTrayPresence | (() => Promise<DoctorTrayPresence> | DoctorTrayPresence);
  /** Built PWA dist root (optional). */
  webRoot?: string;
  credentialVaultProbe?: () => Promise<{ available: boolean; detail: string }>;
  office?: () => Promise<DoctorOfficeAvailability> | DoctorOfficeAvailability;
  portProbe?: (host: string, port: number) => Promise<DoctorPortProbe>;
  healthProbe?: (url: string, timeoutMs?: number) => Promise<HealthProbeResult>;
  /** Safe fix handlers keyed by check id (tests / advanced wiring). */
  fixHandlers?: Record<string, () => Promise<string | void> | string | void>;
}

const DEFAULT_STATE_FILES = [
  "state.json",
  "todos.json",
  "runs.json",
  "connections.json",
  "roles.json"
];

const NODE_FS: DoctorFs = {
  access: (path, mode) => access(path, mode),
  mkdir: (path, options) => mkdir(path, options),
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data, encoding) => writeFile(path, data, encoding),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  readdir: (path) => readdir(path),
  stat: async (path) => {
    const s = await stat(path);
    return {
      size: s.size,
      mtime: s.mtime,
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile()
    };
  }
};

// ── waitForHealth (NextClaw-inspired) ────────────────────────────────────────

export async function waitForHealth(
  url: string,
  timeoutMs: number,
  options: {
    intervalMs?: number;
    probe?: (url: string, timeoutMs?: number) => Promise<HealthProbeResult>;
  } = {}
): Promise<HealthProbeResult> {
  const intervalMs = options.intervalMs ?? 350;
  const probe = options.probe ?? defaultHealthProbe;
  const startedAt = Date.now();
  let last: HealthProbeResult = { state: "unreachable", detail: "not started" };
  while (Date.now() - startedAt < timeoutMs) {
    last = await probe(url, Math.min(1_500, timeoutMs));
    if (last.state === "ok") return last;
    await sleep(intervalMs);
  }
  return {
    state: last.state === "ok" ? "ok" : last.state,
    detail: `health timeout after ${timeoutMs}ms: ${last.detail}`
  };
}

export async function defaultHealthProbe(url: string, timeoutMs = 1_500): Promise<HealthProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      return { state: "invalid-response", detail: `HTTP ${response.status}`, httpStatus: response.status };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { state: "invalid-response", detail: "non-JSON health body", httpStatus: response.status };
    }
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const status = record.status;
    if (status === "online" || status === "ok" || record.ok === true) {
      return { state: "ok", detail: "health endpoint returned ok", httpStatus: response.status, payload };
    }
    return {
      state: "invalid-response",
      detail: "unexpected health payload",
      httpStatus: response.status,
      payload
    };
  } catch (error) {
    return { state: "unreachable", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function defaultPortProbe(host: string, port: number): Promise<DoctorPortProbe> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error) => {
      // EADDRINUSE means something is already bound — for a running service that is expected.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        resolve({ listening: true, detail: `port ${host}:${port} is in use` });
        return;
      }
      resolve({ listening: false, detail: `port probe failed on ${host}:${port} (${String(error)})` });
    });
    server.listen(port, host, () => {
      server.close(() => {
        resolve({ listening: false, detail: `port ${host}:${port} is free` });
      });
    });
  });
}

export function summarizeChecks(checks: DoctorCheck[]): DoctorCheckSummary {
  const summary: DoctorCheckSummary = { pass: 0, warn: 0, fail: 0, skip: 0, total: checks.length };
  for (const check of checks) {
    summary[check.status] += 1;
  }
  return summary;
}

export function resolveDoctorExitCode(checks: DoctorCheck[]): 0 | 1 {
  if (checks.some((c) => c.status === "fail" || c.status === "warn")) return 1;
  return 0;
}

export function resolveHealthLevel(params: {
  serviceRunning: boolean;
  healthOk: boolean;
  checks: DoctorCheck[];
}): RuntimeHealthLevel {
  if (!params.serviceRunning) return "stopped";
  if (!params.healthOk) return "degraded";
  if (params.checks.some((c) => c.status === "fail")) return "degraded";
  if (params.checks.some((c) => c.status === "warn")) return "degraded";
  return "healthy";
}

// ── Service ──────────────────────────────────────────────────────────────────

export class DoctorService {
  private readonly fs: DoctorFs;
  private readonly bindHost: string;
  private readonly port: number;
  private readonly logDirectory: string;
  private readonly stateFiles: string[];
  private readonly disk: DiskStatsProvider;
  private readonly minFreeDiskBytes: number;
  private readonly maxLogBytes: number;
  private readonly now: () => Date;
  private readonly serviceStartedAtMs: number;

  constructor(private readonly options: DoctorServiceOptions) {
    if (!options.dataDirectory?.trim()) {
      throw new Error("dataDirectory is required for DoctorService.");
    }
    this.fs = options.fs ?? NODE_FS;
    this.bindHost = options.bindHost ?? DEFAULT_BIND_HOST;
    this.port = options.port ?? DEFAULT_SERVICE_PORT;
    this.logDirectory = options.logDirectory ?? join(options.dataDirectory, "logs");
    this.stateFiles = options.stateFiles ?? DEFAULT_STATE_FILES;
    this.disk = options.disk ?? new NodeDiskStatsProvider();
    this.minFreeDiskBytes = options.minFreeDiskBytes ?? DEFAULT_MIN_FREE_DISK_BYTES;
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.now = options.now ?? (() => new Date());
    this.serviceStartedAtMs = options.serviceStartedAt
      ? Date.parse(options.serviceStartedAt)
      : Date.now();
  }

  /** Built-in Firstmate/operator contract — read before invoking doctor tools. */
  contract(): DoctorOperationContract {
    return DOCTOR_OPERATION_CONTRACT;
  }

  async status(options: { verbose?: boolean } = {}): Promise<RuntimeStatusReport> {
    const report = await this.runDoctor({ verbose: options.verbose });
    return report.status;
  }

  async doctor(options: DoctorRunOptions = {}): Promise<DoctorReport> {
    return this.runDoctor(options);
  }

  /**
   * Closed-loop re-check after config or fix.
   * Optionally applies safe fixes first when fix+confirm are both true.
   */
  async run(options: DoctorRunOptions = {}): Promise<DoctorReport> {
    if (options.fix) {
      if (options.confirm !== true) {
        throw Object.assign(new Error("Auto-fix requires explicit confirm=true."), { statusCode: 400 });
      }
      return this.fixAndRecheck({ confirm: true, checkIds: options.checkIds });
    }
    return this.runDoctor(options);
  }

  /**
   * Apply safe fixes only after explicit confirmation, then re-run checks.
   */
  async fixAndRecheck(request: DoctorFixRequest): Promise<DoctorReport> {
    if (request.confirm !== true) {
      throw Object.assign(new Error("Auto-fix requires explicit confirm=true."), { statusCode: 400 });
    }
    const before = await this.runDoctor({});
    const targets = before.checks.filter((check) => {
      if (!check.fixable) return false;
      if (check.status !== "fail" && check.status !== "warn") return false;
      if (request.checkIds?.length) return request.checkIds.includes(check.id);
      return true;
    });
    const fixActions: string[] = [];
    for (const check of targets) {
      const action = await this.applySafeFix(check.id);
      if (action) fixActions.push(action);
    }
    const after = await this.runDoctor({});
    return {
      ...after,
      fixActions,
      recommendations: mergeUnique(after.recommendations, before.recommendations)
    };
  }

  async getLogs(query: LogQuery = {}): Promise<LogSlice> {
    const kind: LogKind = query.kind ?? "service";
    const redact = query.redact !== false;
    const linesWanted = clampLines(query.lines);
    const path = this.resolveLogPath(kind, query.archiveName);
    return this.readLogSlice(path, kind, linesWanted, redact);
  }

  async listLogArchives(): Promise<LogArchiveEntry[]> {
    try {
      await this.fs.access(this.logDirectory);
    } catch {
      return [];
    }
    const names = await this.fs.readdir(this.logDirectory);
    const archives: LogArchiveEntry[] = [];
    for (const name of names) {
      if (!/\.log(\.|$)/i.test(name) && !name.endsWith(".log.gz")) continue;
      if (name === "service.log" || name === "crash.log") continue;
      const path = join(this.logDirectory, name);
      try {
        const s = await this.fs.stat(path);
        if (!s.isFile()) continue;
        archives.push({
          name,
          path,
          sizeBytes: s.size,
          modifiedAt: s.mtime.toISOString()
        });
      } catch {
        // skip unreadable
      }
    }
    archives.sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""));
    return archives;
  }

  /**
   * Export a diagnostic pack directory with status, doctor, and redacted logs.
   * Secrets are never included.
   */
  async exportDiagnosticPack(): Promise<DiagnosticPackResult> {
    const generatedAt = this.now().toISOString();
    const packId = `pack-${generatedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const directory = join(this.options.dataDirectory, "diagnostics", packId);
    await this.fs.mkdir(directory, { recursive: true });
    await this.fs.mkdir(join(directory, "logs"), { recursive: true });

    const report = await this.runDoctor({ verbose: true });
    const serviceLogs = await this.getLogs({ kind: "service", lines: MAX_LOG_LINES, redact: true });
    const crashLogs = await this.getLogs({ kind: "crash", lines: MAX_LOG_LINES, redact: true });

    const files: string[] = [];
    const writeJson = async (rel: string, value: unknown) => {
      const full = join(directory, rel);
      await this.fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      files.push(rel);
    };
    const writeText = async (rel: string, text: string) => {
      const full = join(directory, rel);
      await this.fs.writeFile(full, redactLogText(text), "utf8");
      files.push(rel);
    };

    await writeJson("status.json", report.status);
    await writeJson("doctor.json", {
      generatedAt: report.generatedAt,
      exitCode: report.exitCode,
      summary: report.summary,
      recommendations: report.recommendations,
      checks: report.checks,
      fixActions: report.fixActions
    });
    await writeText("logs/service.log", serviceLogs.lines.join("\n") + (serviceLogs.lines.length ? "\n" : ""));
    await writeText("logs/crash.log", crashLogs.lines.join("\n") + (crashLogs.lines.length ? "\n" : ""));

    const manifest: DiagnosticPackManifest = {
      generatedAt,
      version: this.options.version,
      packId,
      directory,
      files: [...files, "manifest.json"],
      secretsExcluded: true,
      redacted: true,
      doctorExitCode: report.exitCode,
      level: report.status.level
    };
    await writeJson("manifest.json", manifest);
    return { manifest, report };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async runDoctor(options: DoctorRunOptions): Promise<DoctorReport> {
    const generatedAt = this.now().toISOString();
    const checks = await this.collectChecks();
    const filtered = options.checkIds?.length
      ? checks.filter((c) => options.checkIds!.includes(c.id))
      : checks;

    const summary = summarizeChecks(filtered);
    const exitCode = resolveDoctorExitCode(filtered);
    const health = await this.probeSelfHealth();
    const pid = this.options.servicePid ?? process.pid;
    const running = health.state === "ok" || pid != null;
    const level = resolveHealthLevel({
      serviceRunning: health.state === "ok",
      healthOk: health.state === "ok",
      checks: filtered
    });

    const issues = filtered
      .filter((c) => c.status === "fail" || c.status === "warn")
      .map((c) => `${c.id}: ${c.detail}`);
    const recommendations = mergeUnique(
      filtered.map((c) => c.remediation).filter((r): r is string => Boolean(r))
    );

    const logTail =
      options.verbose === true
        ? (await this.getLogs({ kind: "service", lines: 25, redact: true })).lines
        : [];

    const status: RuntimeStatusReport = {
      generatedAt,
      version: this.options.version,
      level,
      exitCode,
      process: {
        pid: pid ?? null,
        running: health.state === "ok",
        uptimeMs: Math.max(0, this.now().getTime() - this.serviceStartedAtMs),
        startedAt: this.options.serviceStartedAt,
        pidFilePath: join(this.options.dataDirectory, "service.pid")
      },
      endpoints: {
        bindHost: this.bindHost,
        port: this.port,
        apiUrl: `http://${this.bindHost}:${this.port}`,
        healthUrl: `http://${this.bindHost}:${this.port}/api/health`,
        pwaUrl: `http://${this.bindHost}:${this.port}/`
      },
      dataDirectory: this.options.dataDirectory,
      logDirectory: this.logDirectory,
      health,
      issues,
      recommendations,
      logTail,
      summary,
      checkIds: filtered.map((c) => c.id)
    };

    // Process running flag consistency with level
    if (level === "stopped") {
      status.process.running = false;
    }

    return {
      generatedAt,
      checks: filtered,
      status,
      exitCode,
      fixActions: [],
      recommendations,
      summary
    };
  }

  private async collectChecks(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    checks.push(await this.checkServiceProcess());
    checks.push(await this.checkServiceHealth());
    checks.push(await this.checkTray());
    checks.push(await this.checkPwa());
    checks.push(await this.checkPort());
    checks.push(await this.checkDataDirectory());
    checks.push(await this.checkStateFiles());
    checks.push(await this.checkCredentialManager());
    checks.push(await this.checkDisk());
    checks.push(await this.checkProviders());
    checks.push(await this.checkModels());
    checks.push(await this.checkCodex());
    checks.push(await this.checkRuntimes());
    checks.push(await this.checkMcp());
    checks.push(await this.checkGit());
    checks.push(await this.checkWorktree());
    checks.push(await this.checkOffice());
    checks.push(await this.checkLogDirectory());
    return checks;
  }

  private async checkServiceProcess(): Promise<DoctorCheck> {
    const pid = this.options.servicePid ?? process.pid;
    const pidFile = join(this.options.dataDirectory, "service.pid");
    let stalePidFile = false;
    let pidFileContent: string | undefined;
    try {
      pidFileContent = (await this.fs.readFile(pidFile, "utf8")).trim();
      const filePid = Number.parseInt(pidFileContent, 10);
      if (Number.isFinite(filePid) && filePid > 0 && filePid !== pid) {
        // Another pid recorded; cannot prove liveness here without OS probe — warn only if health fails later.
        stalePidFile = false;
      }
    } catch {
      // missing pid file is ok when doctor runs in-process
    }

    if (pid && pid > 0) {
      return {
        id: "service-process",
        name: "Service process",
        category: "service",
        status: "pass",
        code: "service_process_ok",
        detail: `service process pid=${pid}`,
        meta: { pid, pidFile, pidFileContent, stalePidFile },
        fixable: Boolean(pidFileContent)
      };
    }
    return {
      id: "service-process",
      name: "Service process",
      category: "service",
      status: "fail",
      code: "service_process_missing",
      detail: "service process is not known",
      remediation: "Start the service from the tray or installer, then re-run doctor.",
      meta: { pidFile },
      fixable: false
    };
  }

  private async checkServiceHealth(): Promise<DoctorCheck> {
    const health = await this.probeSelfHealth();
    if (health.state === "ok") {
      return {
        id: "service-health",
        name: "Service health",
        category: "service",
        status: "pass",
        code: "service_health_ok",
        detail: health.detail,
        meta: { state: health.state }
      };
    }
    return {
      id: "service-health",
      name: "Service health",
      category: "service",
      status: "fail",
      code: "service_health_failed",
      detail: `${health.state}: ${health.detail}`,
      remediation: "Inspect service logs and restart the agent service from the tray.",
      meta: { state: health.state }
    };
  }

  private async checkTray(): Promise<DoctorCheck> {
    if (!this.options.tray) {
      return {
        id: "tray-presence",
        name: "Tray host",
        category: "tray",
        status: "skip",
        code: "tray_not_probed",
        detail: "tray probe not configured"
      };
    }
    const presence =
      typeof this.options.tray === "function" ? await this.options.tray() : this.options.tray;
    if (presence.present) {
      return {
        id: "tray-presence",
        name: "Tray host",
        category: "tray",
        status: "pass",
        code: "tray_present",
        detail: presence.detail,
        meta: { pid: presence.pid ?? null }
      };
    }
    return {
      id: "tray-presence",
      name: "Tray host",
      category: "tray",
      status: "warn",
      code: "tray_missing",
      detail: presence.detail,
      remediation: "Launch the Windows tray host so service lifecycle and autostart stay managed.",
      meta: { pid: presence.pid ?? null }
    };
  }

  private async checkPwa(): Promise<DoctorCheck> {
    if (!this.options.webRoot) {
      return {
        id: "pwa-assets",
        name: "PWA assets",
        category: "pwa",
        status: "skip",
        code: "pwa_not_configured",
        detail: "webRoot not configured"
      };
    }
    const indexPath = join(this.options.webRoot, "index.html");
    try {
      await this.fs.access(indexPath, fsConstants.R_OK);
      return {
        id: "pwa-assets",
        name: "PWA assets",
        category: "pwa",
        status: "pass",
        code: "pwa_assets_ok",
        detail: `index.html present at ${this.options.webRoot}`,
        meta: { webRoot: this.options.webRoot, indexPath }
      };
    } catch {
      return {
        id: "pwa-assets",
        name: "PWA assets",
        category: "pwa",
        status: "fail",
        code: "pwa_assets_missing",
        detail: `missing PWA index at ${indexPath}`,
        remediation: "Rebuild/install the web dist and ensure PAW_WEB_ROOT points at apps/web/dist.",
        meta: { webRoot: this.options.webRoot, indexPath }
      };
    }
  }

  private async checkPort(): Promise<DoctorCheck> {
    const probe =
      this.options.portProbe ??
      ((host: string, port: number) => defaultPortProbe(host, port));
    const result = await probe(this.bindHost, this.port);
    // When health is ok, port is correctly occupied by us → pass.
    const health = await this.probeSelfHealth();
    if (health.state === "ok") {
      return {
        id: "port-bind",
        name: "Port bind",
        category: "port",
        status: "pass",
        code: "port_managed",
        detail: `service listening on ${this.bindHost}:${this.port}`,
        meta: { ...result, host: this.bindHost, port: this.port }
      };
    }
    if (result.listening) {
      return {
        id: "port-bind",
        name: "Port bind",
        category: "port",
        status: "fail",
        code: "port_occupied_orphan",
        detail: `port ${this.bindHost}:${this.port} is occupied but health is not ok`,
        remediation: "Stop the process holding the port or choose a free PAW_SERVICE_PORT.",
        meta: { ...result, host: this.bindHost, port: this.port }
      };
    }
    return {
      id: "port-bind",
      name: "Port bind",
      category: "port",
      status: "warn",
      code: "port_free",
      detail: result.detail,
      remediation: "Start the service so it can bind the configured port.",
      meta: { ...result, host: this.bindHost, port: this.port }
    };
  }

  private async checkDataDirectory(): Promise<DoctorCheck> {
    const dir = this.options.dataDirectory;
    try {
      await this.fs.access(dir, fsConstants.R_OK | fsConstants.W_OK);
      return {
        id: "data-directory",
        name: "Data directory",
        category: "data",
        status: "pass",
        code: "data_dir_ok",
        detail: dir,
        meta: { path: dir }
      };
    } catch {
      return {
        id: "data-directory",
        name: "Data directory",
        category: "data",
        status: "fail",
        code: "data_dir_missing",
        detail: `data directory missing or not writable: ${dir}`,
        remediation: "Create the data directory or set PAW_DATA_DIR to a writable path.",
        fixable: true,
        meta: { path: dir }
      };
    }
  }

  private async checkStateFiles(): Promise<DoctorCheck> {
    const missing: string[] = [];
    const present: string[] = [];
    for (const name of this.stateFiles) {
      const path = join(this.options.dataDirectory, name);
      try {
        await this.fs.access(path, fsConstants.R_OK);
        present.push(name);
      } catch {
        missing.push(name);
      }
    }
    // Empty/missing state is acceptable on first run — warn, not fail.
    if (missing.length === this.stateFiles.length) {
      return {
        id: "state-files",
        name: "State / database files",
        category: "data",
        status: "warn",
        code: "state_files_empty",
        detail: "no state files yet (fresh install)",
        remediation: "Start the service once so state files initialize.",
        meta: { missing, present }
      };
    }
    if (missing.length > 0) {
      return {
        id: "state-files",
        name: "State / database files",
        category: "data",
        status: "warn",
        code: "state_files_partial",
        detail: `missing: ${missing.join(", ")}`,
        remediation: "Missing state files reinitialize on next service start for that domain.",
        meta: { missing, present }
      };
    }
    return {
      id: "state-files",
      name: "State / database files",
      category: "data",
      status: "pass",
      code: "state_files_ok",
      detail: `${present.length} state file(s) present`,
      meta: { present }
    };
  }

  private async checkCredentialManager(): Promise<DoctorCheck> {
    if (!this.options.credentialVaultProbe) {
      return {
        id: "credential-manager",
        name: "Credential Manager",
        category: "credentials",
        status: "skip",
        code: "credential_probe_not_configured",
        detail: "credential vault probe not configured"
      };
    }
    try {
      const result = await this.options.credentialVaultProbe();
      if (result.available) {
        return {
          id: "credential-manager",
          name: "Credential Manager",
          category: "credentials",
          status: "pass",
          code: "credential_manager_ok",
          detail: result.detail
        };
      }
      return {
        id: "credential-manager",
        name: "Credential Manager",
        category: "credentials",
        status: "fail",
        code: "credential_manager_unavailable",
        detail: result.detail,
        remediation: "Ensure Windows Credential Manager is available, or use a supported vault backend."
      };
    } catch (error) {
      return {
        id: "credential-manager",
        name: "Credential Manager",
        category: "credentials",
        status: "fail",
        code: "credential_manager_error",
        detail: error instanceof Error ? error.message : String(error),
        remediation: "Inspect Credential Manager permissions and re-save provider API keys."
      };
    }
  }

  private async checkDisk(): Promise<DoctorCheck> {
    try {
      const free = await this.disk.freeBytes(this.options.dataDirectory);
      if (free < this.minFreeDiskBytes) {
        return {
          id: "disk-space",
          name: "Disk space",
          category: "disk",
          status: "fail",
          code: "disk_low",
          detail: `free ${formatBytes(free)} < required ${formatBytes(this.minFreeDiskBytes)}`,
          remediation: "Free disk space on the data volume before starting new agent runs.",
          meta: { freeBytes: free, minFreeDiskBytes: this.minFreeDiskBytes }
        };
      }
      return {
        id: "disk-space",
        name: "Disk space",
        category: "disk",
        status: "pass",
        code: "disk_ok",
        detail: `free ${formatBytes(free)}`,
        meta: { freeBytes: free, minFreeDiskBytes: this.minFreeDiskBytes }
      };
    } catch (error) {
      return {
        id: "disk-space",
        name: "Disk space",
        category: "disk",
        status: "fail",
        code: "disk_check_failed",
        detail: error instanceof Error ? error.message : String(error),
        remediation: "Verify the data directory path is on a reachable volume."
      };
    }
  }

  private async checkProviders(): Promise<DoctorCheck> {
    if (!this.options.connections) {
      return {
        id: "providers",
        name: "Providers",
        category: "providers",
        status: "skip",
        code: "providers_not_wired",
        detail: "connection service not wired"
      };
    }
    const list = await this.options.connections.listPublic();
    const enabled = list.filter((c) => c.enabled);
    const withCreds = enabled.filter((c) => c.credentialPresent);
    if (list.length === 0) {
      return {
        id: "providers",
        name: "Providers",
        category: "providers",
        status: "warn",
        code: "providers_none",
        detail: "no model connections configured",
        remediation: "Add at least one OpenAI-compatible connection with a credential.",
        meta: { total: 0, enabled: 0, withCredentials: 0 }
      };
    }
    if (withCreds.length === 0) {
      return {
        id: "providers",
        name: "Providers",
        category: "providers",
        status: "fail",
        code: "providers_missing_credentials",
        detail: `${enabled.length} enabled connection(s) but none have credentials`,
        remediation: "Re-save API keys so Credential Manager stores them (credentialPresent=true).",
        meta: {
          total: list.length,
          enabled: enabled.length,
          withCredentials: 0,
          connections: list.map((c) => ({
            id: c.id,
            name: c.name,
            enabled: c.enabled,
            credentialPresent: c.credentialPresent
          }))
        }
      };
    }
    const failedTests = withCreds.filter((c) => c.lastTest && c.lastTest.kind !== "success");
    if (failedTests.length > 0) {
      return {
        id: "providers",
        name: "Providers",
        category: "providers",
        status: "warn",
        code: "providers_test_failed",
        detail: `${failedTests.length} connection(s) failed last test`,
        remediation: "Open Connections and re-test failing providers.",
        meta: {
          total: list.length,
          enabled: enabled.length,
          withCredentials: withCreds.length,
          failedTestIds: failedTests.map((c) => c.id)
        }
      };
    }
    return {
      id: "providers",
      name: "Providers",
      category: "providers",
      status: "pass",
      code: "providers_ok",
      detail: `${withCreds.length} credentialed connection(s)`,
      meta: { total: list.length, enabled: enabled.length, withCredentials: withCreds.length }
    };
  }

  private async checkModels(): Promise<DoctorCheck> {
    if (!this.options.connections) {
      return {
        id: "models",
        name: "Models",
        category: "models",
        status: "skip",
        code: "models_not_wired",
        detail: "connection service not wired"
      };
    }
    const list = await this.options.connections.listPublic();
    const withModel = list.filter((c) => c.enabled && c.modelId?.trim());
    if (withModel.length === 0) {
      return {
        id: "models",
        name: "Models",
        category: "models",
        status: "warn",
        code: "models_none",
        detail: "no enabled connection has a modelId",
        remediation: "Set a modelId on at least one enabled connection.",
        meta: { count: 0 }
      };
    }
    return {
      id: "models",
      name: "Models",
      category: "models",
      status: "pass",
      code: "models_ok",
      detail: `${withModel.length} enabled model(s)`,
      meta: {
        models: withModel.map((c) => ({ id: c.id, modelId: c.modelId, name: c.name }))
      }
    };
  }

  private async checkCodex(): Promise<DoctorCheck> {
    if (!this.options.codex) {
      return {
        id: "codex-cli",
        name: "Codex CLI",
        category: "codex",
        status: "skip",
        code: "codex_not_wired",
        detail: "codex service not wired"
      };
    }
    try {
      const status = await this.options.codex.status();
      if (status.installed && status.authenticated) {
        return {
          id: "codex-cli",
          name: "Codex CLI",
          category: "codex",
          status: "pass",
          code: "codex_ready",
          detail: status.version ? `installed+authenticated (${status.version})` : "installed+authenticated",
          meta: { ...status }
        };
      }
      if (!status.installed) {
        return {
          id: "codex-cli",
          name: "Codex CLI",
          category: "codex",
          status: "warn",
          code: "codex_not_installed",
          detail: status.reason ?? "Codex CLI is not installed",
          remediation: "Install Codex CLI and authenticate, or use the API harness only.",
          meta: { ...status }
        };
      }
      return {
        id: "codex-cli",
        name: "Codex CLI",
        category: "codex",
        status: "warn",
        code: "codex_not_authenticated",
        detail: status.reason ?? "Codex CLI is not authenticated",
        remediation: "Run Codex login on this machine, then re-run doctor.",
        meta: { ...status }
      };
    } catch (error) {
      return {
        id: "codex-cli",
        name: "Codex CLI",
        category: "codex",
        status: "warn",
        code: "codex_probe_error",
        detail: error instanceof Error ? error.message : String(error),
        remediation: "Verify Codex CLI is on PATH and re-check."
      };
    }
  }

  private async checkRuntimes(): Promise<DoctorCheck> {
    if (!this.options.runtimes) {
      return {
        id: "runtime-adapters",
        name: "Runtime adapters",
        category: "runtime",
        status: "skip",
        code: "runtime_not_wired",
        detail: "runtime registry not wired"
      };
    }
    const adapters = this.options.runtimes.list();
    if (adapters.length === 0) {
      return {
        id: "runtime-adapters",
        name: "Runtime adapters",
        category: "runtime",
        status: "warn",
        code: "runtime_empty",
        detail: "no runtime adapters registered",
        remediation: "Register at least the API Agent runtime adapter at service boot."
      };
    }
    const probes: Array<{ harness: string; ok: boolean; detail?: string }> = [];
    for (const adapter of adapters) {
      if (adapter.probe) {
        try {
          const result = await adapter.probe();
          probes.push({ harness: adapter.harness, ok: result.ok !== false, detail: result.detail });
        } catch (error) {
          probes.push({
            harness: adapter.harness,
            ok: false,
            detail: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
        probes.push({ harness: adapter.harness, ok: true, detail: "no probe (capabilities only)" });
      }
    }
    const failed = probes.filter((p) => !p.ok);
    if (failed.length > 0) {
      return {
        id: "runtime-adapters",
        name: "Runtime adapters",
        category: "runtime",
        status: "warn",
        code: "runtime_probe_failed",
        detail: `${failed.length}/${probes.length} adapter probe(s) failed`,
        remediation: "Inspect failing harness probes (API key / Codex login).",
        meta: { probes }
      };
    }
    return {
      id: "runtime-adapters",
      name: "Runtime adapters",
      category: "runtime",
      status: "pass",
      code: "runtime_ok",
      detail: `${adapters.length} adapter(s) registered`,
      meta: {
        harnesses: adapters.map((a) => a.harness),
        probes
      }
    };
  }

  private async checkMcp(): Promise<DoctorCheck> {
    if (!this.options.mcp) {
      return {
        id: "mcp-connections",
        name: "MCP connections",
        category: "mcp",
        status: "skip",
        code: "mcp_not_wired",
        detail: "mcp service not wired"
      };
    }
    const list = await this.options.mcp.listPublic();
    if (list.length === 0) {
      return {
        id: "mcp-connections",
        name: "MCP connections",
        category: "mcp",
        status: "pass",
        code: "mcp_none",
        detail: "no MCP connections (optional)",
        meta: { total: 0 }
      };
    }
    const enabled = list.filter((c) => c.enabled);
    const bad = enabled.filter((c) => c.lastTest && c.lastTest.kind !== "success");
    if (bad.length > 0) {
      return {
        id: "mcp-connections",
        name: "MCP connections",
        category: "mcp",
        status: "warn",
        code: "mcp_test_failed",
        detail: `${bad.length} enabled MCP connection(s) failed last test`,
        remediation: "Re-test MCP servers and verify transport credentials.",
        meta: {
          total: list.length,
          enabled: enabled.length,
          failedIds: bad.map((c) => c.id)
        }
      };
    }
    return {
      id: "mcp-connections",
      name: "MCP connections",
      category: "mcp",
      status: "pass",
      code: "mcp_ok",
      detail: `${enabled.length} enabled MCP connection(s)`,
      meta: { total: list.length, enabled: enabled.length }
    };
  }

  private async checkGit(): Promise<DoctorCheck> {
    if (!this.options.git) {
      return {
        id: "git-cli",
        name: "Git CLI",
        category: "git",
        status: "skip",
        code: "git_not_wired",
        detail: "git runtime not wired"
      };
    }
    try {
      const result = await this.options.git.run(["--version"]);
      if (result.exitCode === 0) {
        return {
          id: "git-cli",
          name: "Git CLI",
          category: "git",
          status: "pass",
          code: "git_ok",
          detail: (result.stdout || result.stderr).trim() || "git available",
          meta: { exitCode: result.exitCode }
        };
      }
      return {
        id: "git-cli",
        name: "Git CLI",
        category: "git",
        status: "fail",
        code: "git_failed",
        detail: result.stderr.trim() || `git --version exit ${result.exitCode}`,
        remediation: "Install Git for Windows and ensure git is on PATH."
      };
    } catch (error) {
      return {
        id: "git-cli",
        name: "Git CLI",
        category: "git",
        status: "fail",
        code: "git_missing",
        detail: error instanceof Error ? error.message : String(error),
        remediation: "Install Git for Windows and ensure git is on PATH."
      };
    }
  }

  private async checkWorktree(): Promise<DoctorCheck> {
    if (!this.options.worktrees) {
      return {
        id: "worktree-service",
        name: "Worktree service",
        category: "worktree",
        status: "skip",
        code: "worktree_not_wired",
        detail: "worktree service not wired"
      };
    }
    try {
      let active = 0;
      if (this.options.worktrees.countActive) {
        active = await this.options.worktrees.countActive();
      } else if (this.options.worktrees.list) {
        const list = await this.options.worktrees.list();
        active = list.length;
      }
      if (this.options.worktrees.statePath) {
        try {
          await this.fs.access(this.options.worktrees.statePath, fsConstants.R_OK);
        } catch {
          return {
            id: "worktree-service",
            name: "Worktree service",
            category: "worktree",
            status: "warn",
            code: "worktree_state_missing",
            detail: "worktree state file not found (fresh)",
            meta: { active }
          };
        }
      }
      return {
        id: "worktree-service",
        name: "Worktree service",
        category: "worktree",
        status: "pass",
        code: "worktree_ok",
        detail: `worktree service ready (${active} session(s))`,
        meta: { active }
      };
    } catch (error) {
      return {
        id: "worktree-service",
        name: "Worktree service",
        category: "worktree",
        status: "fail",
        code: "worktree_error",
        detail: error instanceof Error ? error.message : String(error),
        remediation: "Inspect worktrees.json and Git worktree permissions."
      };
    }
  }

  private async checkOffice(): Promise<DoctorCheck> {
    if (!this.options.office) {
      return {
        id: "office-wps",
        name: "Office / WPS",
        category: "office",
        status: "skip",
        code: "office_not_probed",
        detail: "office probe not configured"
      };
    }
    try {
      const result = await this.options.office();
      if (result.office || result.wps) {
        return {
          id: "office-wps",
          name: "Office / WPS",
          category: "office",
          status: "pass",
          code: "office_available",
          detail: result.detail,
          meta: { office: result.office, wps: result.wps }
        };
      }
      return {
        id: "office-wps",
        name: "Office / WPS",
        category: "office",
        status: "warn",
        code: "office_unavailable",
        detail: result.detail,
        remediation: "Install Microsoft Office or WPS if document workflows are required.",
        meta: { office: false, wps: false }
      };
    } catch (error) {
      return {
        id: "office-wps",
        name: "Office / WPS",
        category: "office",
        status: "warn",
        code: "office_probe_error",
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async checkLogDirectory(): Promise<DoctorCheck> {
    try {
      await this.fs.access(this.logDirectory, fsConstants.R_OK | fsConstants.W_OK);
      return {
        id: "log-directory",
        name: "Log directory",
        category: "logs",
        status: "pass",
        code: "log_dir_ok",
        detail: this.logDirectory,
        meta: { path: this.logDirectory }
      };
    } catch {
      return {
        id: "log-directory",
        name: "Log directory",
        category: "logs",
        status: "warn",
        code: "log_dir_missing",
        detail: `log directory missing: ${this.logDirectory}`,
        remediation: "Doctor can create the log directory when fix is confirmed.",
        fixable: true,
        meta: { path: this.logDirectory }
      };
    }
  }

  private async applySafeFix(checkId: string): Promise<string | undefined> {
    const custom = this.options.fixHandlers?.[checkId];
    if (custom) {
      const result = await custom();
      return typeof result === "string" && result ? result : `Applied custom fix for ${checkId}.`;
    }
    switch (checkId) {
      case "data-directory": {
        await this.fs.mkdir(this.options.dataDirectory, { recursive: true });
        return `Created data directory: ${this.options.dataDirectory}`;
      }
      case "log-directory": {
        await this.fs.mkdir(this.logDirectory, { recursive: true });
        // Touch empty service/crash logs for a predictable layout.
        const serviceLog = join(this.logDirectory, "service.log");
        const crashLog = join(this.logDirectory, "crash.log");
        try {
          await this.fs.access(serviceLog);
        } catch {
          await this.fs.writeFile(serviceLog, "", "utf8");
        }
        try {
          await this.fs.access(crashLog);
        } catch {
          await this.fs.writeFile(crashLog, "", "utf8");
        }
        return `Created log directory: ${this.logDirectory}`;
      }
      case "service-process": {
        // Clear stale pid file only when configured handler says so via custom; default: no-op.
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private async probeSelfHealth(): Promise<HealthProbeResult> {
    const url = `http://${this.bindHost}:${this.port}/api/health`;
    const probe = this.options.healthProbe ?? defaultHealthProbe;
    return probe(url, 1_500);
  }

  private resolveLogPath(kind: LogKind, archiveName?: string): string {
    if (kind === "archive") {
      if (!archiveName || archiveName.includes("..") || archiveName.includes("/") || archiveName.includes("\\")) {
        throw Object.assign(new Error("archiveName is required and must be a plain file name."), {
          statusCode: 400
        });
      }
      return join(this.logDirectory, archiveName);
    }
    if (kind === "crash") return join(this.logDirectory, "crash.log");
    return join(this.logDirectory, "service.log");
  }

  private async readLogSlice(
    path: string,
    kind: LogKind,
    linesWanted: number,
    redact: boolean
  ): Promise<LogSlice> {
    try {
      let text = await this.fs.readFile(path, "utf8");
      // Cap raw bytes before split.
      let truncated = false;
      if (text.length > this.maxLogBytes) {
        text = text.slice(text.length - this.maxLogBytes);
        truncated = true;
      }
      if (redact) text = redactLogText(text);
      const allLines = text.split(/\r?\n/);
      // Drop trailing empty from final newline
      if (allLines.length && allLines[allLines.length - 1] === "") allLines.pop();
      const lines =
        allLines.length > linesWanted ? allLines.slice(allLines.length - linesWanted) : allLines;
      if (allLines.length > linesWanted) truncated = true;
      return {
        kind,
        path,
        lines,
        redacted: redact,
        truncated,
        lineCount: lines.length,
        maxBytes: this.maxLogBytes
      };
    } catch {
      return {
        kind,
        path,
        lines: [],
        redacted: redact,
        truncated: false,
        lineCount: 0,
        maxBytes: this.maxLogBytes
      };
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function clampLines(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LOG_LINES;
  return Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(value)));
}

function mergeUnique(a: string[], b: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...a, ...b]) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Append a redacted line to a service or crash log (for callers that wire logging). */
export async function appendRedactedLogLine(
  fs: DoctorFs,
  logPath: string,
  line: string,
  options: { maxBytes?: number; now?: () => Date } = {}
): Promise<void> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES * 4;
  const stamp = (options.now ?? (() => new Date()))().toISOString();
  const redacted = redactLogText(line).replace(/\r?\n/g, " ");
  const entry = `${stamp} ${redacted}\n`;
  let existing = "";
  try {
    existing = await fs.readFile(logPath, "utf8");
  } catch {
    // create new
  }
  let next = existing + entry;
  if (next.length > maxBytes) {
    // Rotate: move current to .1 archive sibling.
    const archivePath = `${logPath}.${Date.now()}.log`;
    try {
      await fs.rename(logPath, archivePath);
    } catch {
      // if rename fails, just truncate head
    }
    next = entry;
  }
  await fs.writeFile(logPath, next, "utf8");
}
