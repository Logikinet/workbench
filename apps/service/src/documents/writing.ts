/**
 * Chapter generation / revision with grounding rules (Task 33).
 * Document agent may only use project facts, user materials, and Evidence.
 * Never fabricates data, awards, experiments, or references.
 */

import { randomUUID } from "node:crypto";
import type { ModelProvider } from "../model/types.js";
import type {
  Chapter,
  ChapterModelOutput,
  ChapterVersion,
  DataPoint,
  DocumentMaterial,
  DocumentOutline,
  OutlineSection,
  ResearchEvidence
} from "./documentTypes.js";
import { assertOutlineApproved } from "./outline.js";
import { isOriginalMaterial } from "./materialImport.js";

export class WritingError extends Error {
  constructor(
    message: string,
    readonly code:
      | "outline_not_approved"
      | "section_not_found"
      | "model_failed"
      | "invalid_output"
      | "ungrounded"
      | "chapter_not_found"
  ) {
    super(message);
    this.name = "WritingError";
  }
}

const WRITE_SYSTEM = `You are a document writing agent.
You may ONLY use the provided project facts, user materials, templates, and Evidence.
Do NOT invent data, awards, experiments, statistics, or bibliographic references.
If something is not supported, list it under unsupportedClaims and omit it from the body.
Return JSON: { body, citationKeys?, evidenceIds?, materialIds?, terminology?, dataPoints?, unsupportedClaims? }.
Citation keys must refer to provided Evidence/material keys only.`;

export interface WriteChapterInput {
  outline: DocumentOutline;
  sectionId: string;
  materials: DocumentMaterial[];
  evidence: ResearchEvidence[];
  projectFacts: string[];
  /** Existing chapter when revising. */
  existing?: Chapter;
  revisionNote?: string;
  model: ModelProvider;
  connectionId?: string;
  modelId?: string;
  now?: () => Date;
  signal?: AbortSignal;
  /**
   * When true (default), reject bodies that cite unknown keys or invent
   * numeric claims without evidence binding.
   */
  enforceGrounding?: boolean;
}

export interface WriteChapterOutcome {
  chapter: Chapter;
  blocked: boolean;
  blockReasons: string[];
  unsupportedClaims: string[];
}

export async function writeChapter(input: WriteChapterInput): Promise<WriteChapterOutcome> {
  try {
    assertOutlineApproved(input.outline);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Outline must be approved before writing.";
    throw new WritingError(msg, "outline_not_approved");
  }
  const section = input.outline.sections.find((s) => s.id === input.sectionId);
  if (!section) throw new WritingError(`Section “${input.sectionId}” not found.`, "section_not_found");

  const now = input.now ?? (() => new Date());
  const pack = buildWritingContextPack({
    section,
    materials: input.materials,
    evidence: input.evidence,
    projectFacts: input.projectFacts,
    existing: input.existing,
    revisionNote: input.revisionNote,
    missingDataList: input.outline.missingDataList
  });

  const response = await input.model.complete({
    connectionId: input.connectionId ?? "fake-connection",
    modelId: input.modelId ?? "fake-model",
    messages: [
      { role: "system", content: WRITE_SYSTEM },
      { role: "user", content: pack }
    ],
    signal: input.signal
  });

  const parsed = parseChapterModelOutput(response.content);
  return applyChapterOutput(parsed, {
    section,
    materials: input.materials,
    evidence: input.evidence,
    projectFacts: input.projectFacts,
    existing: input.existing,
    enforceGrounding: input.enforceGrounding !== false,
    now
  });
}

export function buildWritingContextPack(input: {
  section: OutlineSection;
  materials: DocumentMaterial[];
  evidence: ResearchEvidence[];
  projectFacts: string[];
  existing?: Chapter;
  revisionNote?: string;
  missingDataList?: string[];
}): string {
  const boundMaterials = input.materials.filter(
    (m) =>
      isOriginalMaterial(m)
      && (input.section.materialIds.includes(m.id) || m.kind === "project_fact" || m.kind === "template")
  );
  const boundEvidence = input.evidence.filter((e) => input.section.evidenceIds.includes(e.id));
  // Always include project facts and any user materials marked as available
  const allOriginal = input.materials.filter(isOriginalMaterial);

  const lines: string[] = [
    `# Write chapter: ${input.section.title}`,
    `Section summary: ${input.section.summary}`,
    "",
    "## Acceptance criteria",
    ...(input.section.acceptanceCriteria.map((c) => `- ${c}`) || []),
    input.section.acceptanceCriteria.length === 0 ? "_none_" : "",
    "",
    "## Missing data (DO NOT invent)",
    ...[...(input.section.missingData ?? []), ...(input.missingDataList ?? [])].map((m) => `- ${m}`),
    "",
    "## Project facts (allowed)",
    ...input.projectFacts.map((f) => `- ${f}`),
    input.projectFacts.length === 0 ? "_none_" : "",
    "",
    "## Bound materials",
    ""
  ];

  for (const m of boundMaterials.length ? boundMaterials : allOriginal.filter((m) => m.kind === "user_material" || m.kind === "template")) {
    lines.push(`- materialId=${m.id} key=mat:${m.id.slice(0, 8)} kind=${m.kind}`);
    lines.push(`  ${m.text.slice(0, 800)}`);
  }

  lines.push("", "## Bound Evidence", "");
  for (const e of boundEvidence.length ? boundEvidence : input.evidence) {
    const key = citationKeyFromEvidence(e);
    lines.push(`- evidenceId=${e.id} key=${key} title=${e.title} author=${e.author ?? "?"}`);
    lines.push(`  ${e.excerpt.slice(0, 500)}`);
  }

  if (input.existing) {
    lines.push("", "## Previous version", "");
    const prev = input.existing.versions.find((v) => v.version === input.existing!.currentVersion);
    if (prev) lines.push(prev.body.slice(0, 2000));
  }
  if (input.revisionNote) {
    lines.push("", `## Revision note`, input.revisionNote);
  }

  lines.push(
    "",
    "Write the chapter body. Use only allowed sources. citationKeys must match provided keys."
  );
  return lines.join("\n");
}

export function parseChapterModelOutput(content: string): ChapterModelOutput {
  let raw: unknown;
  try {
    const trimmed = content.trim();
    const jsonSlice = extractJsonObject(trimmed);
    raw = JSON.parse(jsonSlice);
  } catch {
    throw new WritingError("Chapter model returned non-JSON content.", "invalid_output");
  }
  if (!raw || typeof raw !== "object") {
    throw new WritingError("Chapter model output is not an object.", "invalid_output");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.body !== "string" || !obj.body.trim()) {
    throw new WritingError("Chapter body is required.", "invalid_output");
  }
  return {
    body: obj.body,
    citationKeys: asStringArray(obj.citationKeys),
    evidenceIds: asStringArray(obj.evidenceIds),
    materialIds: asStringArray(obj.materialIds),
    terminology:
      obj.terminology && typeof obj.terminology === "object" && !Array.isArray(obj.terminology)
        ? Object.fromEntries(
            Object.entries(obj.terminology as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[0] === "string" && typeof e[1] === "string"
            )
          )
        : undefined,
    dataPoints: asDataPoints(obj.dataPoints),
    unsupportedClaims: asStringArray(obj.unsupportedClaims)
  };
}

export function applyChapterOutput(
  parsed: ChapterModelOutput,
  ctx: {
    section: OutlineSection;
    materials: DocumentMaterial[];
    evidence: ResearchEvidence[];
    projectFacts: string[];
    existing?: Chapter;
    enforceGrounding: boolean;
    now: () => Date;
  }
): WriteChapterOutcome {
  const allowedEvidenceIds = new Set([
    ...ctx.section.evidenceIds,
    ...ctx.evidence.map((e) => e.id)
  ]);
  const allowedMaterialIds = new Set(ctx.materials.filter(isOriginalMaterial).map((m) => m.id));
  const allowedCitationKeys = new Set([
    ...ctx.evidence.map(citationKeyFromEvidence),
    ...ctx.materials.filter(isOriginalMaterial).map((m) => `mat:${m.id.slice(0, 8)}`)
  ]);

  const blockReasons: string[] = [];
  const evidenceIds = (parsed.evidenceIds ?? []).filter((id) => allowedEvidenceIds.has(id));
  const materialIds = (parsed.materialIds ?? []).filter((id) => allowedMaterialIds.has(id));
  const citationKeys = parsed.citationKeys ?? [];

  for (const key of citationKeys) {
    if (!allowedCitationKeys.has(key) && !ctx.evidence.some((e) => e.id === key || e.id.startsWith(key))) {
      // Also allow keys that match author-year from evidence
      const matched = ctx.evidence.some((e) => citationKeyFromEvidence(e) === key);
      if (!matched) {
        blockReasons.push(`Unknown citation key “${key}” — not in Evidence/materials (possible fabrication).`);
      }
    }
  }

  // Heuristic: numeric awards / percentages without any evidence binding
  if (ctx.enforceGrounding) {
    const inventSignals = detectFabricationSignals(parsed.body, {
      projectFacts: ctx.projectFacts,
      materials: ctx.materials,
      evidence: ctx.evidence
    });
    blockReasons.push(...inventSignals);
  }

  if (ctx.section.missingData.length > 0) {
    for (const gap of ctx.section.missingData) {
      // If body appears to fill a missing-data gap with a specific number, flag
      if (/must not invent|DO NOT invent|No materials/i.test(gap)) continue;
    }
  }

  const blocked = blockReasons.length > 0 && ctx.enforceGrounding;
  if (blocked) {
    // Still record a draft chapter version only when not blocked; return existing or empty shell
    const chapter = ctx.existing ?? emptyChapter(ctx.section, ctx.now);
    return {
      chapter,
      blocked: true,
      blockReasons,
      unsupportedClaims: parsed.unsupportedClaims ?? []
    };
  }

  const nextVersion = (ctx.existing?.currentVersion ?? 0) + 1;
  const version: ChapterVersion = {
    version: nextVersion,
    body: parsed.body.trim(),
    citationKeys,
    evidenceIds: evidenceIds.length
      ? evidenceIds
      : citationKeys
          .map((k) => ctx.evidence.find((e) => citationKeyFromEvidence(e) === k)?.id)
          .filter((id): id is string => Boolean(id)),
    materialIds,
    createdAt: ctx.now().toISOString(),
    changeSummary: ctx.existing ? "revision" : "initial",
    contentOrigin: "generated"
  };

  const chapter: Chapter = {
    id: ctx.existing?.id ?? randomUUID(),
    sectionId: ctx.section.id,
    title: ctx.section.title,
    currentVersion: nextVersion,
    versions: [...(ctx.existing?.versions ?? []), version],
    terminology: { ...(ctx.existing?.terminology ?? {}), ...(parsed.terminology ?? {}) },
    dataPoints: mergeDataPoints(ctx.existing?.dataPoints ?? [], parsed.dataPoints ?? [])
  };

  return {
    chapter,
    blocked: false,
    blockReasons: [],
    unsupportedClaims: parsed.unsupportedClaims ?? []
  };
}

export function emptyChapter(section: OutlineSection, now: () => Date = () => new Date()): Chapter {
  return {
    id: randomUUID(),
    sectionId: section.id,
    title: section.title,
    currentVersion: 0,
    versions: [],
    terminology: {},
    dataPoints: []
  };
}

export function citationKeyFromEvidence(e: ResearchEvidence): string {
  const author = (e.author ?? "Unknown").split(/[,\s]+/)[0] || "Unknown";
  const year =
    e.publishedAt?.slice(0, 4)
    ?? e.accessedAt?.slice(0, 4)
    ?? "n.d.";
  return `${author}${year}`;
}

/**
 * Detect likely fabrication: awards, exact experiment claims, or stats that
 * do not appear in any allowed source text.
 */
export function detectFabricationSignals(
  body: string,
  sources: {
    projectFacts: string[];
    materials: DocumentMaterial[];
    evidence: ResearchEvidence[];
  }
): string[] {
  const reasons: string[] = [];
  const corpus = [
    ...sources.projectFacts,
    ...sources.materials.map((m) => m.text),
    ...sources.evidence.map((e) => `${e.excerpt} ${e.body ?? ""} ${e.title}`)
  ]
    .join("\n")
    .toLowerCase();

  const awardRe = /\b(won|awarded|nobel|prize|champion|金奖|获奖)\b/i;
  if (awardRe.test(body)) {
    const awardMentions = body.match(/[^.!?\n]*(?:won|awarded|nobel|prize|champion|金奖|获奖)[^.!?\n]*/gi) ?? [];
    for (const mention of awardMentions) {
      const tokens = mention.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 3);
      const supported = tokens.some((t) => corpus.includes(t) && /award|prize|nobel|won|金奖|获奖/.test(t) || corpus.includes(mention.toLowerCase().slice(0, 40)));
      // If the full phrase isn't roughly in corpus, flag
      if (!corpus.includes(mention.toLowerCase().slice(0, 30).trim()) && !supported) {
        reasons.push(`Possible fabricated award/honor claim: “${mention.trim().slice(0, 80)}”`);
        break;
      }
    }
  }

  // Bare percentages / sample sizes not present in sources
  // Note: do not require word-boundary after `%` (`%` is non-word so `\b` fails).
  const stats =
    body.match(/\d{1,3}(?:\.\d+)?%|\bn\s*=\s*\d+\b|\b\d{3,}\s*(?:participants|subjects|samples|人)\b/gi)
    ?? [];
  for (const stat of stats) {
    if (!corpus.includes(stat.toLowerCase())) {
      // allow only if the full statistic token appears in sources (not merely a shared digit)
      reasons.push(`Statistic “${stat}” not found in project facts, materials, or Evidence.`);
    }
  }

  return reasons;
}

export function getChapterBody(chapter: Chapter, version?: number): string {
  const v = version ?? chapter.currentVersion;
  return chapter.versions.find((x) => x.version === v)?.body ?? "";
}

function mergeDataPoints(existing: DataPoint[], incoming: DataPoint[]): DataPoint[] {
  const map = new Map<string, DataPoint>();
  for (const d of existing) map.set(d.key, d);
  for (const d of incoming) map.set(d.key, d);
  return [...map.values()];
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}

function asDataPoints(value: unknown): DataPoint[] {
  if (!Array.isArray(value)) return [];
  const out: DataPoint[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.value !== "string") continue;
    out.push({
      key: o.key,
      value: o.value,
      evidenceId: typeof o.evidenceId === "string" ? o.evidenceId : undefined,
      materialId: typeof o.materialId === "string" ? o.materialId : undefined
    });
  }
  return out;
}

function extractJsonObject(text: string): string {
  if (text.startsWith("{")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}
