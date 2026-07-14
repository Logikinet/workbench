/**
 * Safe path resolution under a Project workspace grant (Task 42).
 * Rejects absolute paths, drive letters, null bytes, and parent traversal.
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export class PathSafetyError extends Error {
  readonly code: "outside_workspace" | "invalid_path" | "not_found";

  constructor(message: string, code: PathSafetyError["code"] = "outside_workspace") {
    super(message);
    this.name = "PathSafetyError";
    this.code = code;
  }
}

/** Normalize to forward-slash project-relative form (no leading slash). */
export function toProjectRelative(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function parentRelativePath(relativePath: string): string | null {
  const normalized = toProjectRelative(relativePath);
  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

export function basenameOf(relativePath: string): string {
  const normalized = toProjectRelative(relativePath);
  if (!normalized) return "";
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

export function extensionOf(name: string): string {
  const base = name.includes("/") ? basenameOf(name) : name;
  const idx = base.lastIndexOf(".");
  if (idx <= 0 || idx === base.length - 1) return "";
  return base.slice(idx + 1).toLowerCase();
}

/**
 * Resolve a project-relative path strictly inside workspaceRoot.
 * Does not require the target to exist (for write destinations); use resolveExistingSafePath when needed.
 */
export function resolveSafePath(workspaceRoot: string, relativePath: string | undefined | null): {
  absolutePath: string;
  relativePath: string;
} {
  const root = resolve(workspaceRoot);
  const raw = (relativePath ?? "").trim();

  if (raw.includes("\0")) {
    throw new PathSafetyError("Path contains illegal null byte.", "invalid_path");
  }

  // Empty / "." → workspace root
  if (!raw || raw === "." || raw === "./") {
    return { absolutePath: root, relativePath: "" };
  }

  const asForward = raw.replace(/\\/g, "/");
  if (isAbsolute(raw) || isAbsolute(asForward) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    throw new PathSafetyError(
      "Paths must be relative to the approved Project workspace (absolute paths are rejected).",
      "invalid_path"
    );
  }

  if (asForward.startsWith("/") || asForward.startsWith("~")) {
    throw new PathSafetyError("Paths must be relative to the approved Project workspace.", "invalid_path");
  }

  const normalized = normalize(asForward);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.split(sep).includes("..")) {
    throw new PathSafetyError("Path traversal outside the approved Project workspace is not allowed.", "outside_workspace");
  }

  const target = join(root, normalized === "." ? "" : normalized);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathSafetyError("Path resolves outside the approved Project workspace.", "outside_workspace");
  }

  return {
    absolutePath: target,
    relativePath: toProjectRelative(rel)
  };
}

/** True when candidate is the root or a descendant (string-level, no realpath). */
export function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const relation = relative(resolvedRoot, resolvedCandidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

/**
 * Resolve and realpath an existing path, ensuring the final real path stays inside the workspace.
 * Prevents symlink escapes when the link target is outside the grant.
 */
export async function resolveExistingSafePath(
  workspaceRoot: string,
  relativePath: string | undefined | null
): Promise<{ absolutePath: string; relativePath: string; realPath: string }> {
  const { absolutePath, relativePath: rel } = resolveSafePath(workspaceRoot, relativePath);

  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
  } catch {
    throw new PathSafetyError("Project workspace is not accessible.", "not_found");
  }

  let real: string;
  try {
    real = await realpath(absolutePath);
  } catch (error: unknown) {
    // Parent may exist for partial paths; if leaf missing, still validate parent chain.
    if (isEnoent(error)) {
      throw new PathSafetyError(`Path not found: ${rel || "."}`, "not_found");
    }
    throw error;
  }

  if (!isInsideRoot(rootReal, real)) {
    throw new PathSafetyError("Resolved path escapes the approved Project workspace.", "outside_workspace");
  }

  return { absolutePath, relativePath: rel, realPath: real };
}

/** Stat without following into unsafe territory after resolveSafePath. */
export async function safeStat(
  workspaceRoot: string,
  relativePath: string | undefined | null
): Promise<{ absolutePath: string; relativePath: string; isFile: boolean; isDirectory: boolean; size: number; mtime: Date; birthtime?: Date }> {
  const resolved = await resolveExistingSafePath(workspaceRoot, relativePath);
  const info = await stat(resolved.realPath);
  return {
    absolutePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    isFile: info.isFile(),
    isDirectory: info.isDirectory(),
    size: info.size,
    mtime: info.mtime,
    birthtime: info.birthtime
  };
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
}
