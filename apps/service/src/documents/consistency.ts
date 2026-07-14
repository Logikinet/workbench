/**
 * Terminology / data-point consistency + version comparison (Task 33).
 */

import { randomUUID } from "node:crypto";
import type {
  Chapter,
  ConsistencyIssue,
  DataPoint,
  VersionDiff
} from "./documentTypes.js";
import { getChapterBody } from "./writing.js";

/** Compare two chapter versions (line-oriented). */
export function compareChapterVersions(
  chapter: Chapter,
  fromVersion: number,
  toVersion: number
): VersionDiff {
  const from = chapter.versions.find((v) => v.version === fromVersion);
  const to = chapter.versions.find((v) => v.version === toVersion);
  if (!from) throw new Error(`Version ${fromVersion} not found on chapter “${chapter.id}”.`);
  if (!to) throw new Error(`Version ${toVersion} not found on chapter “${chapter.id}”.`);

  const a = from.body.split(/\r?\n/);
  const b = to.body.split(/\r?\n/);
  const setA = new Set(a);
  const setB = new Set(b);
  const addedLines = b.filter((line) => !setA.has(line));
  const removedLines = a.filter((line) => !setB.has(line));
  const unchangedCount = a.filter((line) => setB.has(line)).length;

  const summary =
    addedLines.length === 0 && removedLines.length === 0
      ? "No line-level changes."
      : `+${addedLines.length} / -${removedLines.length} lines (${unchangedCount} unchanged).`;

  return {
    chapterId: chapter.id,
    fromVersion,
    toVersion,
    addedLines,
    removedLines,
    unchangedCount,
    summary
  };
}

/**
 * Check terminology and data-point consistency across chapters.
 * Same term must not map to conflicting canonical forms; same data key must agree.
 */
export function checkConsistency(chapters: Chapter[]): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];

  // Terminology: term → list of {chapterId, form}
  const termMap = new Map<string, Array<{ chapterId: string; form: string }>>();
  for (const ch of chapters) {
    for (const [term, form] of Object.entries(ch.terminology)) {
      const key = normalizeTerm(term);
      const list = termMap.get(key) ?? [];
      list.push({ chapterId: ch.id, form: form.trim() });
      termMap.set(key, list);
    }
  }
  for (const [term, entries] of termMap) {
    const forms = [...new Set(entries.map((e) => e.form.toLowerCase()))];
    if (forms.length > 1) {
      issues.push({
        id: randomUUID(),
        kind: "terminology",
        severity: "error",
        message: `Term “${term}” has conflicting forms: ${[...new Set(entries.map((e) => e.form))].join(" vs ")}.`,
        chapterIds: [...new Set(entries.map((e) => e.chapterId))],
        term,
        expected: entries[0]?.form,
        actual: entries.map((e) => e.form).join(" | ")
      });
    }
  }

  // Data points: key → values
  const dataMap = new Map<string, Array<{ chapterId: string; value: string; point: DataPoint }>>();
  for (const ch of chapters) {
    for (const dp of ch.dataPoints) {
      const key = dp.key.trim().toLowerCase();
      const list = dataMap.get(key) ?? [];
      list.push({ chapterId: ch.id, value: dp.value.trim(), point: dp });
      dataMap.set(key, list);
    }
  }
  for (const [key, entries] of dataMap) {
    const values = [...new Set(entries.map((e) => e.value))];
    if (values.length > 1) {
      issues.push({
        id: randomUUID(),
        kind: "data_point",
        severity: "error",
        message: `Data key “${key}” has conflicting values: ${values.join(" vs ")}.`,
        chapterIds: [...new Set(entries.map((e) => e.chapterId))],
        expected: values[0],
        actual: values.join(" | ")
      });
    }
  }

  // Body vs declared terminology: if multiple chapters use different surface forms
  // of a known term without declaring them, warn.
  for (const [term, entries] of termMap) {
    if (entries.length === 0) continue;
    const canonical = entries[0]!.form;
    for (const ch of chapters) {
      const body = getChapterBody(ch);
      if (!body) continue;
      // Look for alternate casing of the term that isn't the canonical form
      const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi");
      const matches = body.match(re) ?? [];
      for (const m of matches) {
        if (m !== canonical && m.toLowerCase() === canonical.toLowerCase() && m !== canonical) {
          // case drift only — info
          issues.push({
            id: randomUUID(),
            kind: "terminology",
            severity: "info",
            message: `Chapter “${ch.title}” uses “${m}” vs canonical “${canonical}”.`,
            chapterIds: [ch.id],
            term,
            expected: canonical,
            actual: m
          });
        }
      }
    }
  }

  return issues;
}

export function consistencyOk(issues: ConsistencyIssue[]): boolean {
  return !issues.some((i) => i.severity === "error");
}

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
