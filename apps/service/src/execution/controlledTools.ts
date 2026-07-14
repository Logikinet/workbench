/**
 * Controlled workspace tools for the API Professional Agent tool loop (Task 23).
 * Filesystem tools stay inside the approved Project workspace; shell tools only
 * run plan-approved verification commands (test/build/script argv).
 */

import { spawn } from "node:child_process";
import { access, readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { resolveSpawnArgv } from "../git/gitWorktreeService.js";
import { checkApprovedExecution } from "../verification/approvedExecution.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./toolLoop.js";

export interface ControlledToolsOptions {
  workspacePath: string;
  /** Role tools list (filesystem, shell, ...). */
  authorizedTools: string[];
  permissions: {
    workspace: "project_only" | "read_only";
    network: boolean;
    shell: boolean;
    externalSend: boolean;
  };
  /** argv commands bound to the approved plan (verificationCommands). */
  approvedCommands?: string[][];
  /** Optional skill gate (requested skill must be in this set). */
  authorizedSkills?: string[];
  /** Max files visited by list/search. */
  maxEntries?: number;
  /** Injected runners for tests. */
  runCommand?: (argv: string[], cwd: string, signal: AbortSignal) => Promise<CommandRunResult>;
  /** When true, write/patch are allowed without separate overwrite approval for existing files. */
  allowOverwrite?: boolean;
  /** Callback so host can gate overwrite/delete via approval before mutation (optional). */
  onDangerousWrite?: (info: { path: string; kind: "overwrite_file" | "write_file" }) => Promise<ToolResult | undefined>;
}

export interface CommandRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

const DEFAULT_MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

/**
 * Build the default controlled tool set for a Professional Agent run.
 * Only tools the Role authorized (and plan/shell gates allow) are exposed.
 */
export function createControlledTools(options: ControlledToolsOptions): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const hasFs = options.authorizedTools.includes("filesystem")
    && (options.permissions.workspace === "project_only" || options.permissions.workspace === "read_only");
  const canWrite = hasFs && options.permissions.workspace === "project_only";
  const hasShell = options.authorizedTools.includes("shell") && options.permissions.shell === true;

  if (hasFs) {
    tools.push(listFilesTool(options));
    tools.push(readFileTool(options));
    tools.push(searchFilesTool(options));
  }
  if (canWrite) {
    tools.push(writeFileTool(options));
    tools.push(applyPatchTool(options));
  }
  if (hasShell) {
    tools.push(runCommandTool(options));
  }

  return tools;
}

function listFilesTool(options: ControlledToolsOptions): ToolDefinition {
  return {
    name: "list_files",
    description: "List files/directories under a relative path inside the project workspace.",
    risk: "read",
    async execute(args, ctx): Promise<ToolResult> {
      const rel = stringArg(args, "path", ".");
      const maxEntries = Math.min(
        numberArg(args, "maxEntries", options.maxEntries ?? DEFAULT_MAX_ENTRIES),
        options.maxEntries ?? DEFAULT_MAX_ENTRIES
      );
      let abs: string;
      try {
        abs = resolveWorkspacePath(options.workspacePath, rel);
      } catch (error) {
        return outside(error);
      }
      try {
        const info = await stat(abs);
        if (!info.isDirectory()) {
          return { ok: false, summary: `Not a directory: ${rel}` };
        }
        const entries = await readdir(abs, { withFileTypes: true });
        const lines: string[] = [];
        for (const entry of entries.slice(0, maxEntries)) {
          if (ctx.signal.aborted) throw new Error("Professional Agent request was interrupted.");
          lines.push(`${entry.isDirectory() ? "dir" : "file"}\t${entry.name}`);
        }
        const truncated = entries.length > maxEntries;
        const summary = [
          `Listed ${Math.min(entries.length, maxEntries)} of ${entries.length} entries in ${rel === "." ? "." : rel}`,
          ...lines,
          truncated ? `…truncated after ${maxEntries} entries` : ""
        ].filter(Boolean).join("\n");
        return { ok: true, summary: clip(summary, ctx.maxOutputBytes), truncated };
      } catch (error) {
        if (isOutsideError(error)) return outside(error);
        return { ok: false, summary: errorMessage(error, "list_files failed") };
      }
    }
  };
}

function readFileTool(options: ControlledToolsOptions): ToolDefinition {
  return {
    name: "read_file",
    description: "Read a text file relative to the project workspace (size-capped).",
    risk: "read",
    async execute(args, ctx): Promise<ToolResult> {
      const rel = stringArg(args, "path");
      if (!rel) return { ok: false, summary: "read_file requires path." };
      let abs: string;
      try {
        abs = resolveWorkspacePath(options.workspacePath, rel);
      } catch (error) {
        return outside(error);
      }
      try {
        const info = await stat(abs);
        if (!info.isFile()) return { ok: false, summary: `Not a file: ${rel}` };
        if (info.size > MAX_FILE_BYTES) {
          return { ok: false, summary: `File too large to read (${info.size} bytes; max ${MAX_FILE_BYTES}).` };
        }
        const content = await readFile(abs, "utf8");
        const clipped = clip(content, ctx.maxOutputBytes);
        const truncated = Buffer.byteLength(content, "utf8") > ctx.maxOutputBytes;
        return {
          ok: true,
          summary: truncated
            ? `Read ${rel} (${info.size} bytes, truncated for model):\n${clipped}`
            : `Read ${rel} (${info.size} bytes):\n${clipped}`,
          truncated,
          data: { path: rel, bytes: info.size }
        };
      } catch (error) {
        if (isOutsideError(error)) return outside(error);
        return { ok: false, summary: errorMessage(error, `Unable to read ${rel}`) };
      }
    }
  };
}

function searchFilesTool(options: ControlledToolsOptions): ToolDefinition {
  return {
    name: "search_files",
    description: "Search file contents under the workspace for a query string (bounded).",
    risk: "read",
    async execute(args, ctx): Promise<ToolResult> {
      const query = stringArg(args, "query") || stringArg(args, "pattern");
      if (!query) return { ok: false, summary: "search_files requires query." };
      const rootRel = stringArg(args, "path", ".");
      const maxMatches = Math.min(numberArg(args, "maxMatches", 20), 50);
      const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
      let absRoot: string;
      try {
        absRoot = resolveWorkspacePath(options.workspacePath, rootRel);
      } catch (error) {
        return outside(error);
      }

      const matches: string[] = [];
      let visited = 0;
      const queryLower = query.toLowerCase();

      const walk = async (dir: string, relDir: string): Promise<void> => {
        if (matches.length >= maxMatches || visited >= maxEntries || ctx.signal.aborted) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= maxMatches || visited >= maxEntries || ctx.signal.aborted) return;
          if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
          const abs = join(dir, entry.name);
          const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(abs, rel);
            continue;
          }
          if (!entry.isFile()) continue;
          visited += 1;
          try {
            const info = await stat(abs);
            if (info.size > 256 * 1024) continue;
            const text = await readFile(abs, "utf8");
            const idx = text.toLowerCase().indexOf(queryLower);
            if (idx < 0) continue;
            const line = lineNumberAt(text, idx);
            const snippet = text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + query.length + 40))
              .replace(/\s+/g, " ");
            matches.push(`${rel}:${line}: ${snippet}`);
          } catch {
            // skip unreadable
          }
        }
      };

      try {
        await walk(absRoot, rootRel === "." ? "" : rootRel.replaceAll("\\", "/"));
      } catch (error) {
        if (isOutsideError(error)) return outside(error);
        return { ok: false, summary: errorMessage(error, "search_files failed") };
      }

      const summary = matches.length === 0
        ? `No matches for ${JSON.stringify(query)} under ${rootRel} (visited ${visited} files).`
        : `Found ${matches.length} match(es) for ${JSON.stringify(query)} (visited ${visited} files):\n${matches.join("\n")}`;
      return { ok: true, summary: clip(summary, ctx.maxOutputBytes) };
    }
  };
}

function writeFileTool(options: ControlledToolsOptions): ToolDefinition {
  return {
    name: "write_file",
    description: "Write or create a text file relative to the project workspace.",
    risk: "write",
    async execute(args, ctx): Promise<ToolResult> {
      const skillGate = gateSkill(args, options);
      if (skillGate) return skillGate;
      const rel = stringArg(args, "path");
      const content = typeof args.content === "string" ? args.content : undefined;
      if (!rel || content === undefined) {
        return { ok: false, summary: "write_file requires path and content." };
      }
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
        return { ok: false, summary: "Professional Agent file content is too large." };
      }
      let abs: string;
      try {
        abs = resolveWorkspacePath(options.workspacePath, rel);
      } catch (error) {
        return outside(error);
      }

      const exists = await fileExists(abs);
      const kind = exists ? "overwrite_file" as const : "write_file" as const;
      if (exists && options.onDangerousWrite) {
        const gated = await options.onDangerousWrite({ path: rel, kind });
        if (gated) return gated;
      }

      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        return {
          ok: true,
          summary: `Wrote ${rel} (${Buffer.byteLength(content, "utf8")} bytes)${exists ? " [overwrite]" : ""}.`,
          artifacts: [{ path: rel, kind: "file", summary: kind }]
        };
      } catch (error) {
        return { ok: false, summary: errorMessage(error, `Unable to write ${rel}`) };
      }
    }
  };
}

function applyPatchTool(options: ControlledToolsOptions): ToolDefinition {
  return {
    name: "apply_patch",
    description: "Apply a text patch to a workspace file (find/replace or full content).",
    risk: "write",
    async execute(args, ctx): Promise<ToolResult> {
      const skillGate = gateSkill(args, options);
      if (skillGate) return skillGate;
      const rel = stringArg(args, "path");
      if (!rel) return { ok: false, summary: "apply_patch requires path." };
      let abs: string;
      try {
        abs = resolveWorkspacePath(options.workspacePath, rel);
      } catch (error) {
        return outside(error);
      }

      const find = typeof args.find === "string" ? args.find
        : typeof args.old_string === "string" ? args.old_string
          : typeof args.oldString === "string" ? args.oldString
            : undefined;
      const replace = typeof args.replace === "string" ? args.replace
        : typeof args.new_string === "string" ? args.new_string
          : typeof args.newString === "string" ? args.newString
            : undefined;
      const fullContent = typeof args.content === "string" ? args.content : undefined;

      try {
        const exists = await fileExists(abs);
        if (!exists && fullContent === undefined) {
          return { ok: false, summary: `File not found for patch: ${rel}` };
        }
        if (exists && options.onDangerousWrite) {
          const gated = await options.onDangerousWrite({ path: rel, kind: "overwrite_file" });
          if (gated) return gated;
        }

        let next: string;
        let diffSummary: string;
        if (fullContent !== undefined) {
          if (Buffer.byteLength(fullContent, "utf8") > MAX_FILE_BYTES) {
            return { ok: false, summary: "Professional Agent file content is too large." };
          }
          const previous = exists ? await readFile(abs, "utf8") : "";
          next = fullContent;
          diffSummary = summarizeDiff(previous, next);
        } else if (find !== undefined && replace !== undefined) {
          const previous = await readFile(abs, "utf8");
          if (!previous.includes(find)) {
            return { ok: false, summary: `apply_patch find string not present in ${rel}.` };
          }
          const occurrences = previous.split(find).length - 1;
          const replaceAll = args.replaceAll === true;
          next = replaceAll ? previous.split(find).join(replace) : previous.replace(find, replace);
          if (Buffer.byteLength(next, "utf8") > MAX_FILE_BYTES) {
            return { ok: false, summary: "Patched file content is too large." };
          }
          diffSummary = `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${rel} (${find.length}→${replace.length} chars).`;
        } else {
          return { ok: false, summary: "apply_patch requires content or find+replace." };
        }

        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, next, "utf8");
        const summary = `Patched ${rel}. ${diffSummary}`;
        return {
          ok: true,
          summary: clip(summary, ctx.maxOutputBytes),
          artifacts: [
            { path: rel, kind: "file", summary: "apply_patch" },
            { path: `diff:${rel}`, kind: "diff", summary: diffSummary }
          ]
        };
      } catch (error) {
        if (isOutsideError(error)) return outside(error);
        return { ok: false, summary: errorMessage(error, `apply_patch failed for ${rel}`) };
      }
    }
  };
}

function runCommandTool(options: ControlledToolsOptions): ToolDefinition {
  return {
    name: "run_command",
    description: "Run a plan-approved test/build/shell command (argv only; no shell interpolation).",
    risk: "shell",
    async execute(args, ctx): Promise<ToolResult> {
      const argv = parseArgv(args);
      if (!argv || argv.length === 0) {
        return { ok: false, summary: "run_command requires command argv (string[] or command string)." };
      }

      // Reject obvious install / network / destructive patterns unless explicitly approved later.
      if (looksLikeSystemInstall(argv)) {
        return {
          ok: false,
          summary: `System install requires user confirmation: ${argv.join(" ")}`,
          needsApproval: {
            kind: "system_install",
            summary: `Professional Agent 请求系统级安装，必须由用户确认：run_command ${argv.join(" ")}`
          }
        };
      }

      const approved = options.approvedCommands ?? [];
      const check = checkApprovedExecution([argv], approved);
      if (!check.ok) {
        return {
          ok: false,
          summary: check.reason ?? "Command is not in the approved plan.",
          needsApproval: {
            kind: "unapproved_tool",
            summary: `Professional Agent 请求未批准的命令，必须由用户确认：${argv.join(" ")}`
          }
        };
      }

      const runner = options.runCommand ?? defaultRunCommand;
      try {
        const result = await runner(argv, options.workspacePath, ctx.signal);
        const combined = [
          `$ ${argv.join(" ")}`,
          `exit=${result.exitCode ?? "null"}${result.timedOut ? " (timeout)" : ""}`,
          result.stdout ? `stdout:\n${result.stdout}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : ""
        ].filter(Boolean).join("\n");
        const summary = clip(combined, ctx.maxOutputBytes);
        const evidencePath = `evidence/command-${safeSlug(argv.join("-"))}-${Date.now()}.log`;
        // Persist evidence so Reviewer / users can open a real file path.
        try {
          const absEvidence = resolveWorkspacePath(options.workspacePath, evidencePath);
          await mkdir(dirname(absEvidence), { recursive: true });
          await writeFile(absEvidence, combined, "utf8");
        } catch {
          // Evidence write is best-effort; tool result still carries the summary.
        }
        return {
          ok: result.exitCode === 0 && !result.timedOut,
          summary,
          truncated: Buffer.byteLength(combined, "utf8") > ctx.maxOutputBytes,
          artifacts: [{
            path: evidencePath,
            kind: "command_result",
            summary: `exit ${result.exitCode ?? "null"}: ${argv.join(" ")}`
          }],
          data: {
            argv,
            exitCode: result.exitCode,
            timedOut: result.timedOut === true,
            evidencePath
          }
        };
      } catch (error) {
        return { ok: false, summary: errorMessage(error, "run_command failed") };
      }
    }
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

export function resolveWorkspacePath(workspacePath: string, actionPath: string): string {
  const trimmed = actionPath.trim();
  if (!trimmed || isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error("Professional Agent file paths must be relative to the approved Project workspace.");
  }
  const normalized = normalize(trimmed);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error("Professional Agent file paths must be relative to the approved Project workspace.");
  }
  const target = join(workspacePath, normalized === "." ? "" : normalized);
  const rel = relative(workspacePath, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Professional Agent file paths must be relative to the approved Project workspace.");
  }
  return target;
}

function gateSkill(args: Record<string, unknown>, options: ControlledToolsOptions): ToolResult | undefined {
  const requested = typeof args.skill === "string" ? args.skill.trim() : "implement";
  const authorized = options.authorizedSkills ?? ["implement"];
  if (!authorized.includes(requested)) {
    return {
      ok: false,
      summary: `Unauthorized skill: ${requested}`,
      needsApproval: {
        kind: "unapproved_skill",
        summary: `Professional Agent 请求未获角色授权的 Skill：${requested}。`
      }
    };
  }
  return undefined;
}

function outside(error: unknown): ToolResult {
  const summary = errorMessage(error, "Path is outside the approved Project workspace.");
  return {
    ok: false,
    summary,
    needsApproval: {
      kind: "outside_workspace",
      summary: `Professional Agent 请求访问 Project 工作区外路径：${summary}`
    }
  };
}

function isOutsideError(error: unknown): boolean {
  return error instanceof Error && /outside|relative to the approved/i.test(error.message);
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  if (typeof value === "string") return value.trim();
  return fallback;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return fallback;
}

function parseArgv(args: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(args.argv) && args.argv.every((part) => typeof part === "string")) {
    return (args.argv as string[]).map((part) => part.trim()).filter(Boolean);
  }
  if (Array.isArray(args.command) && args.command.every((part) => typeof part === "string")) {
    return (args.command as string[]).map((part) => part.trim()).filter(Boolean);
  }
  if (typeof args.command === "string" && args.command.trim()) {
    // Conservative split — no shell; host still gates via approvedCommands exact match.
    return args.command.trim().split(/\s+/).filter(Boolean);
  }
  return undefined;
}

function looksLikeSystemInstall(argv: string[]): boolean {
  const text = argv.join(" ");
  return /\b(?:npm|pnpm|yarn|pip|brew|winget|choco)\s+(?:install|add)\b/i.test(text)
    || argv[0] === "system_install";
}

function summarizeDiff(before: string, after: string): string {
  if (before === after) return "No content change.";
  const beforeLines = before.split(/\r?\n/).length;
  const afterLines = after.split(/\r?\n/).length;
  return `Diff ${beforeLines}→${afterLines} lines (${Buffer.byteLength(before, "utf8")}→${Buffer.byteLength(after, "utf8")} bytes).`;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function clip(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return `${Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8")}\n…[truncated]`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function safeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "cmd";
}

export async function defaultRunCommand(
  argv: string[],
  cwd: string,
  signal: AbortSignal
): Promise<CommandRunResult> {
  if (signal.aborted) throw new Error("Professional Agent request was interrupted.");
  const resolved = resolveSpawnArgv(argv);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(resolved.command, resolved.argv, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Failed to spawn command."));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish({ exitCode: null, stdout, stderr, timedOut: true });
    }, COMMAND_TIMEOUT_MS);

    const onAbort = (): void => {
      child.kill();
      finish({ exitCode: null, stdout, stderr });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const finish = (result: CommandRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 512_000) stdout = stdout.slice(-512_000);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 512_000) stderr = stderr.slice(-512_000);
    });
    child.once("error", (error) => {
      finish({ exitCode: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("close", (exitCode) => {
      finish({ exitCode, stdout, stderr });
    });
  });
}

/** Pure fake tools for unit tests — no filesystem or process. */
export function createFakeTools(handlers: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult>): ToolDefinition[] {
  return Object.entries(handlers).map(([name, handler]) => ({
    name,
    description: `Fake tool ${name}`,
    risk: "read" as const,
    async execute(args, ctx) {
      return handler(args, ctx);
    }
  }));
}
