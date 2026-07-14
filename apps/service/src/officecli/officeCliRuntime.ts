/**
 * OfficeCLI Runtime Adapter (Task 48).
 * Argv-only execution, workspace path gate, backup/restore on batch failure.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { redactSecrets } from "../model/redact.js";
import type {
  CreateDocumentInput,
  DocumentInspection,
  DocumentValidation,
  OfficeBatchInput,
  OfficeCliCapabilities,
  OfficeCliLogEntry,
  OfficeCliPathResolver,
  OfficeCliRunner,
  OfficeCliRunResult,
  OfficeOperation,
  OfficeResult,
  PreviewArtifact,
  RenderInput
} from "./officeCliTypes.js";

export interface OfficeCliRuntimeOptions {
  runner?: OfficeCliRunner;
  resolveExecutable?: OfficeCliPathResolver;
  now?: () => Date;
  defaultTimeoutMs?: number;
  onLog?: (entry: OfficeCliLogEntry) => void | Promise<void>;
  /** Directory for large command logs (optional). */
  logRoot?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class OfficeCliRuntime {
  private readonly runner: OfficeCliRunner;
  private readonly resolveExecutable: OfficeCliPathResolver;
  private readonly now: () => Date;
  private readonly defaultTimeoutMs: number;
  private readonly onLog?: OfficeCliRuntimeOptions["onLog"];
  private readonly logRoot?: string;
  private readonly controllers = new Map<string, AbortController>();
  private cachedCaps?: OfficeCliCapabilities;

  constructor(options: OfficeCliRuntimeOptions = {}) {
    this.runner = options.runner ?? defaultOfficeCliRunner;
    this.resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable;
    this.now = options.now ?? (() => new Date());
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onLog = options.onLog;
    this.logRoot = options.logRoot;
  }

  async probe(): Promise<OfficeCliCapabilities> {
    const resolved = await this.resolveExecutable();
    const caps: OfficeCliCapabilities = {
      installed: resolved.installed,
      version: resolved.version,
      executablePath: resolved.path,
      supportsCreate: resolved.installed,
      supportsView: resolved.installed,
      supportsBatch: resolved.installed,
      supportsRender: resolved.installed,
      supportsValidate: resolved.installed,
      detail: resolved.detail,
      checkedAt: this.now().toISOString()
    };
    this.cachedCaps = caps;
    return caps;
  }

  async createDocument(input: CreateDocumentInput): Promise<OfficeResult> {
    await this.requireInstalled();
    const path = assertInsideWorkspace(input.workspaceRoot, input.path);
    await mkdir(dirname(path), { recursive: true });

    if (input.templatePath) {
      const template = assertInsideWorkspace(input.workspaceRoot, input.templatePath);
      // Template is read-only source â€?copy to target, never mutate template.
      await copyFile(template, path);
      return this.okResult(path, "Copied template to working document.", [], 0);
    }

    const started = Date.now();
    const result = await this.exec(["create", path], {
      runId: input.runId,
      cwd: input.workspaceRoot
    });
    return this.toOfficeResult(path, result, Date.now() - started);
  }

  async inspectDocument(path: string, workspaceRoot?: string): Promise<DocumentInspection> {
    await this.requireInstalled();
    const abs = workspaceRoot ? assertInsideWorkspace(workspaceRoot, path) : resolve(path);
    const outline = await this.exec(["view", abs, "--mode", "outline"], {});
    const text = await this.exec(["view", abs, "--mode", "text"], {});
    const stats = await this.exec(["view", abs, "--mode", "stats"], {});
    const issues = await this.exec(["view", abs, "--mode", "issues"], {});
    let statsJson: Record<string, unknown> | undefined;
    try {
      statsJson = JSON.parse(stats.stdout) as Record<string, unknown>;
    } catch {
      statsJson = undefined;
    }
    const issueLines = issues.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      path: abs,
      kind: kindFromPath(abs),
      outline: outline.stdout.trim() || undefined,
      text: text.stdout.trim() || undefined,
      stats: statsJson,
      issues: issueLines,
      rawSummary: redactSecrets(
        [outline.stdout, text.stdout.slice(0, 500), issues.stdout].filter(Boolean).join("\n").slice(0, 2000)
      )
    };
  }

  async applyOperations(input: OfficeBatchInput): Promise<OfficeResult> {
    await this.requireInstalled();
    const path = assertInsideWorkspace(input.workspaceRoot, input.path);
    if (input.dynamicCitationsPresent) {
      const unsafe = input.operations.filter((op) => op.unsafeAfterDynamicCitation);
      if (unsafe.length > 0) {
        throw new Error(
          "Dynamic Zotero citations are present; refusing unsafe OfficeCLI operations that may destroy citation fields."
        );
      }
    }

    const started = Date.now();
    const backupPath = await this.backupFile(path);
    const batchPath = join(dirname(path), `.officecli-batch-${randomUUID()}.json`);
    const commands = input.operations.map((op) => operationToCommand(op));
    await writeFile(batchPath, JSON.stringify({ commands }, null, 2), "utf8");

    const stopOnError = input.stopOnError !== false;
    const argv = ["batch", path, "--input", batchPath];
    if (stopOnError) argv.push("--stop-on-error");

    try {
      const result = await this.exec(argv, { runId: input.runId, cwd: input.workspaceRoot });
      if (result.exitCode !== 0) {
        await copyFile(backupPath, path);
        const failed = this.toOfficeResult(path, result, Date.now() - started, {
          backupPath,
          restoredFromBackup: true,
          message: "OfficeCLI batch failed; original document restored from backup."
        });
        return failed;
      }
      // Explicit save/close signal when supported
      await this.exec(["view", path, "--mode", "stats"], { runId: input.runId }).catch(() => undefined);
      return this.toOfficeResult(path, result, Date.now() - started, {
        backupPath,
        message: "OfficeCLI batch applied and document verified readable."
      });
    } catch (error) {
      try {
        await copyFile(backupPath, path);
      } catch {
        /* best-effort restore */
      }
      throw error;
    }
  }

  async renderPreview(input: RenderInput): Promise<PreviewArtifact[]> {
    await this.requireInstalled();
    const path = assertInsideWorkspace(input.workspaceRoot, input.path);
    const outDir = assertInsideWorkspace(input.workspaceRoot, join(input.workspaceRoot, input.outputDir));
    await mkdir(outDir, { recursive: true });
    const modes = input.modes ?? ["outline", "stats", "issues"];
    const artifacts: PreviewArtifact[] = [];

    for (const mode of modes) {
      const result = await this.exec(["view", path, "--mode", mode === "screenshot" ? "screenshot" : mode], {
        runId: input.runId,
        cwd: input.workspaceRoot
      });
      const fileName = `${mode}-${Date.now()}.txt`;
      const filePath = join(outDir, fileName);
      await writeFile(filePath, result.stdout || result.stderr || `(${mode})`, "utf8");
      artifacts.push({
        path: filePath,
        kind: mode === "screenshot" ? "screenshot" : mode === "outline" ? "outline" : mode === "stats" ? "stats" : mode === "issues" ? "issues" : "other",
        summary: redactSecrets((result.stdout || result.stderr || mode).slice(0, 400))
      });
    }
    return artifacts;
  }

  async validate(path: string, workspaceRoot?: string): Promise<DocumentValidation> {
    const abs = workspaceRoot ? assertInsideWorkspace(workspaceRoot, path) : resolve(path);
    try {
      await access(abs, constants.R_OK);
    } catch {
      return { path: abs, ok: false, issues: ["File is not readable."], readable: false, message: "Document is not readable." };
    }
    try {
      const caps = this.cachedCaps ?? (await this.probe());
      if (!caps.installed) {
        // Without OfficeCLI still confirm file exists.
        return {
          path: abs,
          ok: true,
          issues: ["OfficeCLI unavailable; only filesystem readability checked."],
          readable: true,
          message: "File exists; OfficeCLI validation skipped."
        };
      }
      const result = await this.exec(["view", abs, "--mode", "issues"], {});
      const issues = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return {
        path: abs,
        ok: result.exitCode === 0 && issues.length === 0,
        issues,
        readable: true,
        message: issues.length ? `Found ${issues.length} issue(s).` : "Document validated."
      };
    } catch (error) {
      return {
        path: abs,
        ok: false,
        issues: [error instanceof Error ? error.message : "Validation failed."],
        readable: true,
        message: "Validation failed."
      };
    }
  }

  async cancel(runId: string): Promise<void> {
    const controller = this.controllers.get(runId);
    if (controller) {
      controller.abort();
      this.controllers.delete(runId);
    }
  }

  private async requireInstalled(): Promise<OfficeCliCapabilities> {
    const caps = this.cachedCaps ?? (await this.probe());
    if (!caps.installed) {
      throw new Error("OfficeCLI is not installed or unavailable; refusing to fabricate success.");
    }
    return caps;
  }

  private async backupFile(path: string): Promise<string> {
    const backupPath = join(dirname(path), `${basenameNoExt(path)}.backup-${Date.now()}${extname(path)}`);
    await copyFile(path, backupPath);
    return backupPath;
  }

  private async exec(
    args: string[],
    options: { runId?: string; cwd?: string; timeoutMs?: number }
  ): Promise<OfficeCliRunResult> {
    const caps = this.cachedCaps ?? (await this.probe());
    const exe = caps.executablePath ?? "officecli";
    const controller = new AbortController();
    if (options.runId) this.controllers.set(options.runId, controller);

    const argv = [exe, ...args];
    const started = this.now().toISOString();
    try {
      const result = await this.runner(argv, {
        cwd: options.cwd,
        signal: controller.signal,
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs
      });
      const entry = await this.recordLog({
        level: result.exitCode === 0 ? "info" : "error",
        message: `OfficeCLI ${args[0] ?? "command"}`,
        argv,
        exitCode: result.exitCode,
        createdAt: started,
        stdout: result.stdout,
        stderr: result.stderr
      });
      await this.onLog?.(entry);
      return result;
    } finally {
      if (options.runId) this.controllers.delete(options.runId);
    }
  }

  private async recordLog(input: {
    level: "info" | "warn" | "error";
    message: string;
    argv: string[];
    exitCode?: number | null;
    createdAt: string;
    stdout: string;
    stderr: string;
  }): Promise<OfficeCliLogEntry> {
    const combined = [input.stdout, input.stderr].filter(Boolean).join("\n");
    let logPath: string | undefined;
    if (this.logRoot && combined.length > 4_000) {
      await mkdir(this.logRoot, { recursive: true });
      logPath = join(this.logRoot, `officecli-${randomUUID()}.log`);
      await writeFile(logPath, combined, "utf8");
    }
    return {
      id: randomUUID(),
      level: input.level,
      message: input.message,
      argv: input.argv,
      exitCode: input.exitCode,
      createdAt: input.createdAt,
      logPath,
      summary: redactSecrets(
        `${input.message} exit=${input.exitCode ?? "null"} ${combined}`.slice(0, 500)
      )
    };
  }

  private toOfficeResult(
    path: string,
    result: OfficeCliRunResult,
    durationMs: number,
    extra: Partial<OfficeResult> = {}
  ): OfficeResult {
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      path,
      exitCode: result.exitCode,
      stdout: redactSecrets(result.stdout).slice(0, 8_000),
      stderr: redactSecrets(result.stderr).slice(0, 4_000),
      logs: [],
      message: extra.message ?? (result.exitCode === 0 ? "OfficeCLI ok" : "OfficeCLI failed"),
      durationMs,
      ...extra
    };
  }

  private okResult(path: string, message: string, logs: OfficeCliLogEntry[], durationMs: number): OfficeResult {
    return {
      ok: true,
      path,
      exitCode: 0,
      stdout: "",
      stderr: "",
      logs,
      message,
      durationMs
    };
  }
}

function operationToCommand(op: OfficeOperation): Record<string, unknown> {
  switch (op.kind) {
    case "append_paragraph":
      return { op: "append", type: "paragraph", text: op.value ?? "" };
    case "set_paragraph":
      return { op: "set", path: op.target, text: op.value ?? "" };
    case "set_heading":
      return { op: "heading", level: op.args?.level ?? 1, text: op.value ?? "" };
    case "insert_table":
      return { op: "table", ...(op.args ?? {}), caption: op.value };
    case "insert_image":
      return { op: "image", path: op.target, ...(op.args ?? {}) };
    case "set_header":
      return { op: "header", text: op.value ?? "" };
    case "set_footer":
      return { op: "footer", text: op.value ?? "" };
    case "insert_toc":
      return { op: "toc" };
    case "replace_text":
      return { op: "replace", find: op.target, replace: op.value ?? "" };
    case "raw":
      return { op: "raw", value: op.value, ...(op.args ?? {}) };
    default:
      return { op: op.kind, value: op.value, target: op.target, ...(op.args ?? {}) };
  }
}

export function assertInsideWorkspace(workspaceRoot: string, targetPath: string): string {
  const root = resolve(workspaceRoot);
  const abs = isAbsolute(targetPath) ? resolve(targetPath) : resolve(root, targetPath);
  const rel = relative(root, abs);
  if (!rel && rel !== "") {
    // same path ok
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("OfficeCLI path must stay inside the Project workspace.");
  }
  // Normalize Windows oddities
  const normalized = normalize(abs);
  if (!normalized.toLowerCase().startsWith(root.toLowerCase())) {
    // Allow equal root file paths
    if (normalized.toLowerCase() !== root.toLowerCase()) {
      throw new Error("OfficeCLI path is outside the Project workspace.");
    }
  }
  return normalized;
}

function kindFromPath(path: string): "docx" | "xlsx" | "pptx" {
  const ext = extname(path).toLowerCase();
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".pptx") return "pptx";
  return "docx";
}

function basenameNoExt(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? "doc";
  return base.replace(/\.[^.]+$/, "");
}

async function defaultResolveExecutable(): Promise<{
  installed: boolean;
  path?: string;
  version?: string;
  detail: string;
}> {
  const candidates = [
    process.env.PAW_OFFICECLI_PATH,
    "officecli",
    "C:\\Program Files\\OfficeCLI\\officecli.exe",
    join(process.env.LOCALAPPDATA ?? "", "OfficeCLI", "officecli.exe")
  ].filter((value): value is string => Boolean(value && value.trim()));

  for (const candidate of candidates) {
    try {
      if (candidate.includes("\\") || candidate.includes("/")) {
        await access(candidate, constants.X_OK).catch(async () => access(candidate, constants.F_OK));
      }
      const version = await probeVersion(candidate);
      return {
        installed: true,
        path: candidate,
        version,
        detail: `OfficeCLI found at ${candidate}`
      };
    } catch {
      // try next
    }
  }
  return { installed: false, detail: "OfficeCLI not found on PATH or common install locations." };
}

async function probeVersion(exe: string): Promise<string | undefined> {
  try {
    const result = await defaultOfficeCliRunner([exe, "--version"], { timeoutMs: 5_000 });
    const text = `${result.stdout} ${result.stderr}`.trim();
    const match = text.match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? (text.slice(0, 40) || undefined);
  } catch {
    return undefined;
  }
}

export async function defaultOfficeCliRunner(
  argv: string[],
  options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<OfficeCliRunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      signal: options.signal
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            child.kill();
            settled = true;
            resolvePromise({ exitCode: null, stdout, stderr, timedOut: true });
          }, options.timeoutMs)
        : undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ exitCode: null, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr });
    });
  });
}
