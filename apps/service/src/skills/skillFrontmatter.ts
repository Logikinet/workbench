/**
 * SKILL.md frontmatter parser (NextClaw-inspired, no yaml dependency).
 * Supports simple key: value and key: [a, b] forms.
 */

import type { ToolPermissionCategory } from "../tools/toolTypes.js";
import { TOOL_PERMISSION_CATEGORIES } from "../tools/toolTypes.js";
import type { SkillFrontmatterMeta } from "./skillTypes.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatterBlock(raw: string): string | null {
  const match = raw.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  return match?.[1] ?? null;
}

export function stripSkillFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(FRONTMATTER_RE);
  return match ? normalized.slice(match[0].length).trim() : normalized.trim();
}

export function parseSkillFrontmatter(raw: string): SkillFrontmatterMeta {
  const block = parseFrontmatterBlock(raw);
  if (!block) return {};

  const map = parseSimpleYaml(block);
  return {
    name: readString(map, "name"),
    version: readString(map, "version"),
    description: readString(map, "description"),
    author: readString(map, "author"),
    tags: readStringList(map, "tags"),
    requiredTools: readStringList(map, "requiredTools", "required_tools", "tools"),
    permissionHints: readCategories(map, "permissionHints", "permission_hints")
  };
}

function parseSimpleYaml(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (!key) continue;

    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      result[key] = inner
        ? inner.split(",").map((part) => unquote(part.trim())).filter(Boolean)
        : [];
      continue;
    }

    if (value === "true") {
      result[key] = true;
      continue;
    }
    if (value === "false") {
      result[key] = false;
      continue;
    }

    result[key] = value;
  }
  return result;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readString(map: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = map[name] ?? map[normalizeKey(name)];
    // also try case-insensitive
    const found = value ?? findCi(map, name);
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return undefined;
}

function readStringList(map: Record<string, unknown>, ...names: string[]): string[] | undefined {
  for (const name of names) {
    const found = map[name] ?? findCi(map, name);
    if (Array.isArray(found)) {
      const list = found
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
      return list.length > 0 ? list : undefined;
    }
    if (typeof found === "string" && found.trim()) {
      return found.split(",").map((part) => part.trim()).filter(Boolean);
    }
  }
  return undefined;
}

function readCategories(map: Record<string, unknown>, ...names: string[]): ToolPermissionCategory[] | undefined {
  const list = readStringList(map, ...names);
  if (!list) return undefined;
  const categories = list.filter((entry): entry is ToolPermissionCategory =>
    (TOOL_PERMISSION_CATEGORIES as readonly string[]).includes(entry)
  );
  return categories.length > 0 ? categories : undefined;
}

function findCi(map: Record<string, unknown>, name: string): unknown {
  const target = normalizeKey(name);
  for (const [key, value] of Object.entries(map)) {
    if (normalizeKey(key) === target) return value;
  }
  return undefined;
}

function normalizeKey(raw: string): string {
  return raw.replace(/[-_]/g, "").toLowerCase();
}
