import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, sep } from "node:path";
import type {
  AvailableScript,
  DetectedProjectStack,
  PackageManager,
  ProjectStackClue,
  ProjectStackKind
} from "./types.js";

const MAX_SCAN_DEPTH = 2;
const MAX_ENTRIES = 200;

/**
 * Inspect a Project workspace and return stack clues + available scripts.
 * Read-only; never mutates the workspace.
 */
export async function detectProjectStack(workspacePath: string): Promise<DetectedProjectStack> {
  const root = workspacePath.trim();
  if (!root) {
    return emptyStack(root);
  }

  try {
    await access(root, constants.R_OK);
  } catch {
    return emptyStack(root);
  }

  const clues: ProjectStackClue[] = [];
  const scripts: AvailableScript[] = [];
  let packageManager: PackageManager | undefined;

  const listing = await listWorkspaceFiles(root);
  const has = (name: string) => listing.some((entry) => entry.toLowerCase() === name.toLowerCase() || entry.toLowerCase().endsWith(`/${name.toLowerCase()}`));
  const findExact = (name: string) => listing.find((entry) => entry === name || entry.endsWith(`/${name}`));

  // --- Node.js ---
  const packageJsonRel = findExact("package.json");
  if (packageJsonRel || has("package.json")) {
    const rel = packageJsonRel ?? "package.json";
    clues.push({
      kind: "nodejs",
      path: rel,
      detail: "package.json present",
      confidence: "high"
    });
    const parsed = await readPackageJson(join(root, ...rel.split("/")));
    if (parsed?.scripts) {
      for (const [name, body] of Object.entries(parsed.scripts)) {
        scripts.push({ name, command: body, source: rel });
      }
    }
    packageManager = detectPackageManager(listing, root);
    if (packageManager) {
      clues.push({
        kind: "nodejs",
        path: lockfileFor(packageManager) ?? rel,
        detail: `package manager: ${packageManager}`,
        confidence: "medium"
      });
    }
  }

  // --- Python ---
  const pythonMarkers = ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "pytest.ini", "tox.ini", "Pipfile", "manage.py"];
  for (const marker of pythonMarkers) {
    const rel = findExact(marker);
    if (!rel && !has(marker)) continue;
    const path = rel ?? marker;
    clues.push({
      kind: "python",
      path,
      detail: `${marker} present`,
      confidence: marker === "pytest.ini" || marker === "pyproject.toml" ? "high" : "medium"
    });
  }
  if (listing.some((entry) => /(^|\/)tests?\//.test(entry) || /(^|\/)test_[^/]+\.py$/.test(entry) || /_test\.py$/.test(entry))) {
    clues.push({
      kind: "python",
      path: listing.find((entry) => /test/.test(entry)) ?? "tests",
      detail: "Python test paths detected",
      confidence: "medium"
    });
  }
  const pyprojectRel = findExact("pyproject.toml");
  if (pyprojectRel) {
    const body = await readText(join(root, ...pyprojectRel.split("/")));
    if (body && /\[tool\.pytest/.test(body)) {
      scripts.push({ name: "pytest", command: "pytest", source: pyprojectRel });
    }
    if (body && /\bpytest\b/.test(body)) {
      scripts.push({ name: "pytest-dep", command: "pytest", source: pyprojectRel });
    }
  }
  if (findExact("pytest.ini") || has("pytest.ini")) {
    scripts.push({ name: "pytest", command: "pytest", source: "pytest.ini" });
  }

  // --- Pure HTML ---
  const indexHtml = findExact("index.html") ?? listing.find((entry) => entry.toLowerCase().endsWith("/index.html"));
  if (indexHtml) {
    clues.push({
      kind: "html",
      path: indexHtml,
      detail: "index.html present",
      confidence: "medium"
    });
  }

  // --- Git ---
  if (await pathExists(join(root, ".git"))) {
    clues.push({
      kind: "git",
      path: ".git",
      detail: "Git repository metadata present",
      confidence: "high"
    });
  }

  // --- HarmonyOS ---
  const harmonyMarkers = ["oh-package.json5", "build-profile.json5", "hvigorfile.ts", "hvigorfile.js", "module.json5"];
  for (const marker of harmonyMarkers) {
    const rel = listing.find((entry) => entry === marker || entry.endsWith(`/${marker}`));
    if (!rel) continue;
    clues.push({
      kind: "harmonyos",
      path: rel,
      detail: `${marker} present (HarmonyOS / OpenHarmony)`,
      confidence: "high"
    });
  }
  if (listing.some((entry) => entry.endsWith("hvigorw") || entry.endsWith("hvigorw.bat"))) {
    scripts.push({ name: "hvigor-test", command: "hvigorw test", source: "hvigorw" });
  }

  // --- Cangjie ---
  const cjpm = findExact("cjpm.toml") ?? listing.find((entry) => entry.endsWith("/cjpm.toml"));
  if (cjpm) {
    clues.push({
      kind: "cangjie",
      path: cjpm,
      detail: "cjpm.toml present (仓颉)",
      confidence: "high"
    });
    scripts.push({ name: "cjpm-test", command: "cjpm test", source: cjpm });
  }
  if (listing.some((entry) => entry.endsWith(".cj"))) {
    clues.push({
      kind: "cangjie",
      path: listing.find((entry) => entry.endsWith(".cj")) ?? "*.cj",
      detail: "Cangjie source files (.cj)",
      confidence: "medium"
    });
  }

  const uniqueScripts = dedupeScripts(scripts);
  const kinds = uniqueKinds(clues.map((clue) => clue.kind).filter((kind) => kind !== "git"));
  // Git alone is a hosting clue, not a primary language stack.
  if (kinds.length === 0 && clues.some((clue) => clue.kind === "git")) {
    kinds.push("git");
  }

  let primary: ProjectStackKind = "unknown";
  if (kinds.length === 0) primary = "unknown";
  else if (kinds.length === 1) primary = kinds[0]!;
  else if (kinds.includes("nodejs") && kinds.includes("python")) primary = "mixed";
  else if (kinds.includes("harmonyos")) primary = "harmonyos";
  else if (kinds.includes("cangjie")) primary = "cangjie";
  else if (kinds.includes("nodejs")) primary = "nodejs";
  else if (kinds.includes("python")) primary = "python";
  else if (kinds.includes("html") && !kinds.includes("nodejs") && !kinds.includes("python")) primary = "html";
  else if (kinds.length > 1) primary = "mixed";
  else primary = kinds[0] ?? "unknown";

  // Pure HTML: demote if a real language stack is present.
  if (primary === "html" && (kinds.includes("nodejs") || kinds.includes("python") || kinds.includes("harmonyos") || kinds.includes("cangjie"))) {
    primary = kinds.find((kind) => kind !== "html" && kind !== "git") ?? "mixed";
  }

  const hasAutomatedTests = detectHasAutomatedTests(primary, uniqueScripts, clues, listing);

  return {
    primary,
    kinds: kinds.length > 0 ? kinds : ["unknown"],
    clues,
    availableScripts: uniqueScripts,
    packageManager,
    hasAutomatedTests,
    workspacePath: root
  };
}

function emptyStack(workspacePath: string): DetectedProjectStack {
  return {
    primary: "unknown",
    kinds: ["unknown"],
    clues: [],
    availableScripts: [],
    hasAutomatedTests: false,
    workspacePath
  };
}

function detectHasAutomatedTests(
  primary: ProjectStackKind,
  scripts: AvailableScript[],
  clues: ProjectStackClue[],
  listing: string[]
): boolean {
  if (scripts.some((script) => /^(test|test:|pytest|cjpm-test|hvigor-test)/i.test(script.name) || /\bpytest\b/i.test(script.command ?? ""))) {
    return true;
  }
  if (primary === "python" && clues.some((clue) => /pytest|tests?/i.test(clue.detail + clue.path))) {
    return true;
  }
  if (primary === "nodejs" && scripts.some((script) => script.name === "test" || script.name.startsWith("test:"))) {
    return true;
  }
  if (listing.some((entry) => /\.(test|spec)\.(js|ts|jsx|tsx|mjs|cjs)$/.test(entry))) {
    return true;
  }
  return false;
}

function detectPackageManager(listing: string[], _root: string): PackageManager | undefined {
  if (listing.some((entry) => entry === "pnpm-lock.yaml" || entry.endsWith("/pnpm-lock.yaml"))) return "pnpm";
  if (listing.some((entry) => entry === "yarn.lock" || entry.endsWith("/yarn.lock"))) return "yarn";
  if (listing.some((entry) => entry === "bun.lockb" || entry === "bun.lock" || entry.endsWith("/bun.lockb"))) return "bun";
  if (listing.some((entry) => entry === "package-lock.json" || entry.endsWith("/package-lock.json"))) return "npm";
  if (listing.some((entry) => entry === "package.json" || entry.endsWith("/package.json"))) return "npm";
  return undefined;
}

function lockfileFor(manager: PackageManager): string | undefined {
  switch (manager) {
    case "pnpm": return "pnpm-lock.yaml";
    case "yarn": return "yarn.lock";
    case "bun": return "bun.lockb";
    case "npm": return "package-lock.json";
  }
}

async function readPackageJson(absolute: string): Promise<{ scripts?: Record<string, string> } | undefined> {
  try {
    const raw = await readFile(absolute, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (parsed.scripts && typeof parsed.scripts === "object") {
      const scripts: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.scripts)) {
        if (typeof value === "string") scripts[key] = value;
      }
      return { scripts };
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function readText(absolute: string): Promise<string | undefined> {
  try {
    return await readFile(absolute, "utf8");
  } catch {
    return undefined;
  }
}

async function pathExists(absolute: string): Promise<boolean> {
  try {
    await access(absolute, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, root, 0, out);
  return out;
}

async function walk(root: string, current: string, depth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_ENTRIES || depth > MAX_SCAN_DEPTH) return;
  let entries: string[];
  try {
    entries = await readdir(current);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= MAX_ENTRIES) return;
    if (name === "node_modules" || name === "dist" || name === "build" || name === ".git" || name === "__pycache__" || name === ".venv" || name === "venv") {
      // Record .git as a clue path without walking contents.
      if (name === ".git") {
        const rel = relative(root, join(current, name)).split(sep).join("/");
        out.push(rel || ".git");
      }
      continue;
    }
    const absolute = join(current, name);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      continue;
    }
    const rel = relative(root, absolute).split(sep).join("/");
    out.push(rel);
    if (info.isDirectory()) {
      await walk(root, absolute, depth + 1, out);
    }
  }
}

function uniqueKinds(kinds: ProjectStackKind[]): ProjectStackKind[] {
  return [...new Set(kinds)];
}

function dedupeScripts(scripts: AvailableScript[]): AvailableScript[] {
  const seen = new Set<string>();
  const out: AvailableScript[] = [];
  for (const script of scripts) {
    const key = `${script.source}::${script.name}::${script.command ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(script);
  }
  return out;
}
