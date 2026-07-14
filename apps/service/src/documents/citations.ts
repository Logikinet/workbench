/**
 * Citation traceability + bibliography formatting (Task 33).
 * Citations must bind to Evidence or original materials.
 */

import { randomUUID } from "node:crypto";
import type {
  BibliographyStyle,
  Chapter,
  Citation,
  CitationCheckFinding,
  CitationCheckResult,
  DocumentMaterial,
  ResearchEvidence
} from "./documentTypes.js";
import { citationKeyFromEvidence, getChapterBody } from "./writing.js";
import { isOriginalMaterial } from "./materialImport.js";

export function buildCitationsFromEvidence(
  evidence: ResearchEvidence[],
  materials: DocumentMaterial[] = [],
  now: () => Date = () => new Date()
): Citation[] {
  const accessed = now().toISOString();
  const fromEvidence: Citation[] = evidence.map((e) => ({
    id: randomUUID(),
    key: citationKeyFromEvidence(e),
    evidenceId: e.id,
    title: e.title,
    author: e.author,
    source: e.source,
    publishedAt: e.publishedAt,
    accessedAt: e.accessedAt || accessed,
    locator: e.location?.anchor ?? (e.location?.page !== undefined ? `p.${e.location.page}` : undefined)
  }));

  const fromMaterials: Citation[] = materials
    .filter(isOriginalMaterial)
    .filter((m) => m.kind === "user_material" || m.kind === "template")
    .map((m) => ({
      id: randomUUID(),
      key: `mat:${m.id.slice(0, 8)}`,
      materialId: m.id,
      evidenceId: m.evidenceId,
      title: m.title,
      source: m.sourcePath ?? `material://${m.id}`,
      accessedAt: accessed
    }));

  // Dedupe by key (prefer evidence)
  const map = new Map<string, Citation>();
  for (const c of fromMaterials) map.set(c.key, c);
  for (const c of fromEvidence) map.set(c.key, c);
  return [...map.values()];
}

/** Format a single citation entry. */
export function formatCitation(citation: Citation, style: BibliographyStyle, index: number): string {
  const author = citation.author?.trim() || "Unknown";
  const year = yearOf(citation) || "n.d.";
  const title = citation.title.trim() || "Untitled";
  const source = citation.source;
  const accessed = citation.accessedAt ? citation.accessedAt.slice(0, 10) : undefined;

  switch (style) {
    case "ieee":
      return `[${index}] ${author}, “${title},” ${source}${year !== "n.d." ? `, ${year}` : ""}.`;
    case "gb7714":
      return `[${index}] ${author}. ${title}[EB/OL]. ${source}${year !== "n.d." ? `, ${year}` : ""}${accessed ? ` [${accessed}]` : ""}.`;
    case "apa":
    default:
      return `${author} (${year}). ${title}. ${source}.${accessed ? ` Retrieved ${accessed}.` : ""}`;
  }
}

export function formatBibliography(
  citations: Citation[],
  style: BibliographyStyle
): string {
  const sorted =
    style === "apa"
      ? [...citations].sort((a, b) => (a.author ?? a.title).localeCompare(b.author ?? b.title))
      : [...citations];

  const lines = sorted.map((c, i) => formatCitation(c, style, i + 1));
  const header =
    style === "apa" ? "## References"
      : style === "ieee" ? "## References"
        : "## 参考文献";
  return [header, "", ...lines, ""].join("\n");
}

/**
 * Ensure every citation key used in chapters maps to a Citation with
 * evidenceId or materialId (traceable).
 */
export function checkCitations(
  chapters: Chapter[],
  citations: Citation[],
  style: BibliographyStyle
): CitationCheckResult {
  const byKey = new Map(citations.map((c) => [c.key, c]));
  const findings: CitationCheckFinding[] = [];
  const usedKeys = new Set<string>();

  for (const ch of chapters) {
    const body = getChapterBody(ch);
    const keysFromBody = extractCitationKeysFromBody(body);
    const keys = new Set([...keysFromBody, ...ch.versions.flatMap((v) => v.citationKeys)]);
    for (const key of keys) {
      usedKeys.add(key);
      const cit = byKey.get(key);
      if (!cit) {
        findings.push({
          citationKey: key,
          chapterId: ch.id,
          met: false,
          reason: `Citation “${key}” has no bibliography entry (cannot trace to source).`,
          severity: "error"
        });
        continue;
      }
      if (!cit.evidenceId && !cit.materialId) {
        findings.push({
          citationKey: key,
          chapterId: ch.id,
          met: false,
          reason: `Citation “${key}” is not bound to Evidence or material.`,
          severity: "error"
        });
        continue;
      }
      findings.push({
        citationKey: key,
        chapterId: ch.id,
        met: true,
        reason: `Traces to ${cit.evidenceId ? `evidence ${cit.evidenceId}` : `material ${cit.materialId}`}.`,
        severity: "info"
      });
    }
  }

  // Orphan bibliography entries are ok (info only)
  for (const c of citations) {
    if (!usedKeys.has(c.key)) {
      findings.push({
        citationKey: c.key,
        met: true,
        reason: "Listed in bibliography but not cited in body.",
        severity: "info"
      });
    }
  }

  const ok = findings.every((f) => f.met || f.severity === "info");
  const usedCitations = citations.filter((c) => usedKeys.has(c.key));
  const bibliography = formatBibliography(usedCitations.length ? usedCitations : citations, style);

  return { ok, findings, bibliography, style };
}

/** Pull keys from [Key] or (Author, Year) or (Author Year) patterns. */
export function extractCitationKeysFromBody(body: string): string[] {
  const keys = new Set<string>();
  // [Smith2024] or [1] — prefer alphanumeric keys
  for (const m of body.matchAll(/\[([A-Za-z][A-Za-z0-9:_-]{1,40})\]/g)) {
    keys.add(m[1]!);
  }
  // (Smith, 2024) → Smith2024
  for (const m of body.matchAll(/\(([A-Za-z][A-Za-z-]+),\s*(\d{4}|n\.d\.)\)/g)) {
    keys.add(`${m[1]}${m[2]}`);
  }
  return [...keys];
}

function yearOf(c: Citation): string | undefined {
  if (c.publishedAt && /^\d{4}/.test(c.publishedAt)) return c.publishedAt.slice(0, 4);
  return undefined;
}
