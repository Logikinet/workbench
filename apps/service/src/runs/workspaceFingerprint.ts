import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

export interface WorkspaceFingerprint {
  kind: "git_status" | "content_hash" | "empty";
  value: string;
  capturedAt: string;
  pathCount: number;
}

const EMPTY_FINGERPRINT_VALUE = createHash("sha256").update("empty").digest("hex");
const MAX_LISTING_FILES = 200;
const MAX_LISTING_DEPTH = 3;

/** Shared empty fingerprint constructor — value matches captureWorkspaceFingerprint empty kind. */
export function createEmptyFingerprint(capturedAt: string = new Date().toISOString()): WorkspaceFingerprint {
  return { kind: "empty", value: EMPTY_FINGERPRINT_VALUE, capturedAt, pathCount: 0 };
}

/** Captures a durable workspace fingerprint via git status when available, otherwise content hashes. */
export async function captureWorkspaceFingerprint(
  workspacePath: string,
  trackedRelativePaths: string[] = []
): Promise<WorkspaceFingerprint> {
  const capturedAt = new Date().toISOString();
  const uniquePaths = [...new Set(trackedRelativePaths.map(normalizeRelativePath).filter(Boolean))];
  const contentPart = await hashTrackedFiles(workspacePath, uniquePaths);
  const gitPart = await tryGitFingerprint(workspacePath);

  if (gitPart) {
    return {
      kind: "git_status",
      value: createHash("sha256").update(`git:${gitPart}\ncontent:${contentPart}`).digest("hex"),
      capturedAt,
      pathCount: uniquePaths.length
    };
  }

  if (!contentPart && uniquePaths.length === 0) {
    const listing = await recursiveWorkspaceListing(workspacePath);
    if (!listing) {
      return createEmptyFingerprint(capturedAt);
    }
    return {
      kind: "content_hash",
      value: createHash("sha256").update(`listing:${listing}`).digest("hex"),
      capturedAt,
      pathCount: 0
    };
  }

  return {
    kind: "content_hash",
    value: createHash("sha256").update(`content:${contentPart}`).digest("hex"),
    capturedAt,
    pathCount: uniquePaths.length
  };
}

export function fingerprintsMatch(expected: WorkspaceFingerprint, actual: WorkspaceFingerprint): boolean {
  return expected.value === actual.value;
}

function normalizeRelativePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return "";
  const normalized = normalize(trimmed).replace(/\\/g, "/");
  if (normalized === ".." || normalized.startsWith("../")) return "";
  return normalized;
}

async function hashTrackedFiles(workspacePath: string, relativePaths: string[]): Promise<string> {
  const parts: string[] = [];
  for (const relative of relativePaths.sort()) {
    const absolute = join(workspacePath, ...relative.split("/"));
    try {
      const content = await readFile(absolute);
      parts.push(`${relative}:${createHash("sha256").update(content).digest("hex")}`);
    } catch {
      parts.push(`${relative}:missing`);
    }
  }
  return parts.join("\n");
}

/** Bounded recursive listing so nested external edits are visible without tracked artifacts. */
async function recursiveWorkspaceListing(workspacePath: string): Promise<string> {
  try {
    await access(workspacePath);
    const lines: string[] = [];
    await walkListing(workspacePath, "", 0, lines);
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function walkListing(root: string, relative: string, depth: number, lines: string[]): Promise<void> {
  if (lines.length >= MAX_LISTING_FILES || depth > MAX_LISTING_DEPTH) return;
  const absolute = relative ? join(root, ...relative.split("/")) : root;
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (lines.length >= MAX_LISTING_FILES) return;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".paw") continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const full = join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (depth >= MAX_LISTING_DEPTH) {
        lines.push(`${childRelative}/`);
        continue;
      }
      await walkListing(root, childRelative, depth + 1, lines);
      continue;
    }
    try {
      const fileStat = await stat(full);
      if (fileStat.size > 256 * 1024) {
        lines.push(`${childRelative}:${fileStat.size}:large`);
        continue;
      }
      const content = await readFile(full);
      lines.push(`${childRelative}:${fileStat.size}:${createHash("sha256").update(content).digest("hex")}`);
    } catch {
      lines.push(`${childRelative}:unreadable`);
    }
  }
}

async function tryGitFingerprint(workspacePath: string): Promise<string | undefined> {
  const head = await runGit(["rev-parse", "HEAD"], workspacePath);
  if (head === undefined) return undefined;
  const status = await runGit(["status", "--porcelain"], workspacePath);
  if (status === undefined) return undefined;
  return `HEAD=${head.trim()}\nSTATUS=${status}`;
}

function runGit(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      resolve(stdout);
    });
  });
}

export function isDangerousActionKind(kind: string): boolean {
  return kind === "delete_file"
    || kind === "overwrite_file"
    || kind === "system_install"
    || kind === "external_send";
}

export function actionKindFromStep(step: string): "write_file" | "overwrite_file" | "delete_file" | "system_install" | "external_send" | "other" {
  const normalized = step.trim();
  if (normalized.startsWith("overwrite_file:")) return "overwrite_file";
  if (normalized.startsWith("delete_file:")) return "delete_file";
  if (normalized.startsWith("system_install:") || normalized.startsWith("run_command:install:")) return "system_install";
  if (normalized.startsWith("external_send:")) return "external_send";
  if (normalized.startsWith("write_file:")) return "write_file";
  return "other";
}

/** Unused but kept for path join safety references in fingerprint module consumers. */
export function joinWorkspaceRelative(workspacePath: string, relativePath: string): string {
  return join(workspacePath, ...relativePath.split(/[/\\]/).filter(Boolean));
}

export function pathUsesWorkspaceSep(relativePath: string): string {
  return relativePath.split(/[/\\]/).join(sep);
}
