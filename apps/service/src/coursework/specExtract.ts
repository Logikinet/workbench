/**
 * Extract functional requirements, scoring points, prohibitions, delivery
 * format, and missing critical info from a coursework assignment brief (任务书).
 *
 * Uses deterministic heuristics; optional ModelProvider for structured enrich.
 */

import { randomUUID } from "node:crypto";
import type { ModelProvider } from "../model/types.js";
import type {
  DeliveryFormatSpec,
  FunctionalRequirement,
  MissingCriticalInfo,
  Prohibition,
  ScoringPoint,
  ScoringPointCategory,
  SpecExtractModelOutput,
  SpecExtractResult
} from "./courseworkTypes.js";

export class SpecExtractError extends Error {
  constructor(
    message: string,
    readonly code: "empty_brief" | "model_failed" | "invalid_output"
  ) {
    super(message);
    this.name = "SpecExtractError";
  }
}

export interface ExtractSpecInput {
  assignmentBrief: string;
  existingProjectNotes?: string;
  model?: ModelProvider;
  connectionId?: string;
  modelId?: string;
  now?: () => Date;
  signal?: AbortSignal;
}

const SPEC_SYSTEM = `You extract structured coursework assignment requirements.
Return JSON only: {
  functionalRequirements: [{ text, source? }],
  scoringPoints: [{ title, description?, maxScore?, category? }],
  prohibitions: [{ text }],
  deliveryFormats: string[],
  deliveryNotes?: string,
  missingCriticalInfo: [{ question, reason? }],
  summary?: string
}
Categories: function|code|test|docs|demo|other.
List missing critical info when deadlines, stack, score weights, or demo env are unclear.
Never invent scores or requirements not implied by the brief.`;

/** Pure heuristic extract — always available without a model. */
export function extractSpecHeuristic(
  brief: string,
  options: { existingProjectNotes?: string; now?: () => Date } = {}
): SpecExtractResult {
  const text = brief?.trim() ?? "";
  if (!text) throw new SpecExtractError("Assignment brief is empty.", "empty_brief");
  const now = options.now ?? (() => new Date());
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const functionalRequirements = collectSectionItems(lines, [
    /功能要求|功能需求|需求|requirements?|features?/i
  ]).map((t, i) => toRequirement(t, i));

  // Fall back: numbered / bulleted lines that look like features
  if (functionalRequirements.length === 0) {
    for (const line of lines) {
      if (isBulletOrNumbered(line) && !looksLikeScoreLine(line) && !looksLikeProhibition(line)) {
        functionalRequirements.push(
          toRequirement(stripBullet(line), functionalRequirements.length)
        );
      }
    }
  }

  const scoringPoints = collectScoringPoints(lines, text);
  const prohibitions = collectSectionItems(lines, [
    /禁止|不允许|不得|prohibitions?|must not|不要/i
  ]).map((t, i) => toProhibition(t, i));

  // Inline prohibition phrases
  if (prohibitions.length === 0) {
    for (const line of lines) {
      if (looksLikeProhibition(line)) {
        prohibitions.push(toProhibition(stripBullet(line), prohibitions.length));
      }
    }
  }

  const deliveryFormat = detectDeliveryFormat(text, lines);
  const missingCriticalInfo = detectMissingInfo(text, options.existingProjectNotes);

  // Ensure at least one scoring point from requirements if none found
  if (scoringPoints.length === 0 && functionalRequirements.length > 0) {
    for (const req of functionalRequirements.slice(0, 8)) {
      scoringPoints.push({
        id: `sp-${scoringPoints.length + 1}`,
        title: truncate(req.text, 48),
        description: req.text,
        category: "function"
      });
    }
  }

  const rawSummary = [
    `Requirements: ${functionalRequirements.length}`,
    `Scoring points: ${scoringPoints.length}`,
    `Prohibitions: ${prohibitions.length}`,
    `Delivery: ${deliveryFormat.formats.join(", ") || "unspecified"}`,
    `Missing critical: ${missingCriticalInfo.length}`
  ].join("; ");

  return {
    functionalRequirements,
    scoringPoints,
    prohibitions,
    deliveryFormat,
    missingCriticalInfo,
    rawSummary,
    extractedAt: now().toISOString()
  };
}

export async function extractSpec(input: ExtractSpecInput): Promise<SpecExtractResult> {
  const base = extractSpecHeuristic(input.assignmentBrief, {
    existingProjectNotes: input.existingProjectNotes,
    now: input.now
  });

  if (!input.model) return base;

  try {
    const response = await input.model.complete({
      connectionId: input.connectionId ?? "fake-connection",
      modelId: input.modelId ?? "fake-model",
      messages: [
        { role: "system", content: SPEC_SYSTEM },
        {
          role: "user",
          content: buildSpecContextPack(input.assignmentBrief, input.existingProjectNotes)
        }
      ],
      signal: input.signal
    });
    const parsed = parseSpecModelOutput(response.content);
    return mergeSpecExtract(base, parsed, input.now ?? (() => new Date()));
  } catch (error: unknown) {
    if (error instanceof SpecExtractError && error.code === "empty_brief") throw error;
    // Model enrichment is optional — keep heuristic result.
    return base;
  }
}

export function buildSpecContextPack(brief: string, existingProjectNotes?: string): string {
  const lines = [
    "# Coursework assignment brief",
    "",
    brief.trim(),
    ""
  ];
  if (existingProjectNotes?.trim()) {
    lines.push("## Existing project notes", "", existingProjectNotes.trim(), "");
  }
  lines.push("Extract requirements, scoring points, prohibitions, delivery formats, and missing critical info.");
  return lines.join("\n");
}

export function parseSpecModelOutput(content: string): SpecExtractModelOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonObject(content.trim()));
  } catch {
    throw new SpecExtractError("Spec model returned non-JSON content.", "invalid_output");
  }
  if (!raw || typeof raw !== "object") {
    throw new SpecExtractError("Spec model output is not an object.", "invalid_output");
  }
  return raw as SpecExtractModelOutput;
}

export function mergeSpecExtract(
  base: SpecExtractResult,
  model: SpecExtractModelOutput,
  now: () => Date
): SpecExtractResult {
  const functionalRequirements =
    model.functionalRequirements && model.functionalRequirements.length > 0
      ? model.functionalRequirements
          .map((r) => r.text?.trim())
          .filter((t): t is string => Boolean(t))
          .map((text, i) => ({
            id: `req-${i + 1}`,
            text,
            source: model.functionalRequirements![i]?.source
          }))
      : base.functionalRequirements;

  const scoringPoints =
    model.scoringPoints && model.scoringPoints.length > 0
      ? model.scoringPoints
          .filter((s) => s.title?.trim())
          .map((s, i) => ({
            id: `sp-${i + 1}`,
            title: s.title.trim(),
            description: (s.description ?? s.title).trim(),
            maxScore: typeof s.maxScore === "number" ? s.maxScore : undefined,
            category: normalizeCategory(s.category)
          }))
      : base.scoringPoints;

  const prohibitions =
    model.prohibitions && model.prohibitions.length > 0
      ? model.prohibitions
          .map((p) => p.text?.trim())
          .filter((t): t is string => Boolean(t))
          .map((text, i) => ({ id: `proh-${i + 1}`, text }))
      : base.prohibitions;

  const deliveryFormat: DeliveryFormatSpec =
    model.deliveryFormats && model.deliveryFormats.length > 0
      ? {
          formats: model.deliveryFormats.map((f) => f.trim()).filter(Boolean),
          notes: model.deliveryNotes?.trim() || base.deliveryFormat.notes
        }
      : base.deliveryFormat;

  const missingCriticalInfo: MissingCriticalInfo[] =
    model.missingCriticalInfo && model.missingCriticalInfo.length > 0
      ? model.missingCriticalInfo
          .filter((m) => m.question?.trim())
          .map((m, i) => ({
            id: `miss-${i + 1}`,
            question: m.question.trim(),
            reason: (m.reason ?? "Unclear from assignment brief").trim(),
            resolved: false
          }))
      : base.missingCriticalInfo;

  const rawSummary =
    model.summary?.trim() ||
    [
      `Requirements: ${functionalRequirements.length}`,
      `Scoring points: ${scoringPoints.length}`,
      `Prohibitions: ${prohibitions.length}`,
      `Delivery: ${deliveryFormat.formats.join(", ") || "unspecified"}`,
      `Missing critical: ${missingCriticalInfo.length}`
    ].join("; ");

  return {
    functionalRequirements,
    scoringPoints,
    prohibitions,
    deliveryFormat,
    missingCriticalInfo,
    rawSummary,
    extractedAt: now().toISOString()
  };
}

function collectSectionItems(lines: string[], headers: RegExp[]): string[] {
  const items: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (headers.some((h) => h.test(line)) && !isBulletOrNumbered(line)) {
      inSection = true;
      // Same-line content after colon
      const after = line.split(/[:：]/).slice(1).join(":").trim();
      if (after && after.length >= 4) items.push(after);
      continue;
    }
    if (inSection) {
      if (/^#{1,3}\s|^[一二三四五六七八九十]+[、.．]|^第.+[章节部分]/.test(line) && !isBulletOrNumbered(line)) {
        inSection = false;
        continue;
      }
      if (
        /评分|得分|交付|提交|禁止|不允许|delivery|scoring|score/i.test(line) &&
        !isBulletOrNumbered(line) &&
        line.length < 40
      ) {
        inSection = false;
        continue;
      }
      if (isBulletOrNumbered(line) || line.length >= 6) {
        items.push(stripBullet(line));
      }
    }
  }
  return uniqueStrings(items);
}

function collectScoringPoints(lines: string[], fullText: string): ScoringPoint[] {
  const points: ScoringPoint[] = [];
  const sectionItems = collectSectionItems(lines, [
    /评分|得分点|评分标准|评分点|分值|grading|rubric|score/i
  ]);
  for (const item of sectionItems) {
    points.push(parseScoreItem(item, points.length));
  }

  // Pattern: "登录功能 10分" / "UI design (15 pts)"
  // Note: avoid \b after 分 — JS word boundaries treat CJK as non-word.
  if (points.length === 0) {
    const re =
      /(?:^|\n)\s*(?:[-*•]|\d+[.)、])?\s*([^:\n]{2,60}?)[：:\s]+(\d{1,3})\s*(?:分|pts?|points?|marks?)(?=\s|$|[，。,.;；])/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fullText)) !== null) {
      const title = m[1]!.trim();
      const maxScore = Number(m[2]);
      if (title.length < 2) continue;
      points.push({
        id: `sp-${points.length + 1}`,
        title: truncate(title, 48),
        description: title,
        maxScore: Number.isFinite(maxScore) ? maxScore : undefined,
        category: inferCategory(title)
      });
    }
  }

  return points;
}

function parseScoreItem(item: string, index: number): ScoringPoint {
  const scoreMatch = item.match(/(\d{1,3})\s*(?:分|pts?|points?|marks?)(?=\s|$|[，。,.;；\/)])/i);
  const maxScore = scoreMatch ? Number(scoreMatch[1]) : undefined;
  const title = item
    .replace(/[：:]\s*\d{1,3}\s*(?:分|pts?|points?|marks?)(?=\s|$|[，。,.;；\/)])/i, "")
    .replace(/\d{1,3}\s*(?:分|pts?|points?|marks?)(?=\s|$|[，。,.;；\/)])/i, "")
    .trim();
  return {
    id: `sp-${index + 1}`,
    title: truncate(title || item, 48),
    description: item,
    maxScore: Number.isFinite(maxScore) ? maxScore : undefined,
    category: inferCategory(item)
  };
}

function detectDeliveryFormat(text: string, lines: string[]): DeliveryFormatSpec {
  const formats = new Set<string>();
  const lower = text.toLowerCase();
  if (/\bzip\b|压缩包|打包/i.test(text)) formats.add("zip");
  if (/源码|源代码|source\s*code|\.git|仓库/i.test(text)) formats.add("source");
  if (/readme|运行说明|部署说明|使用说明/i.test(text)) formats.add("readme");
  if (/报告|report|论文|文档/i.test(text)) formats.add("report");
  if (/pdf/i.test(lower)) formats.add("report-pdf");
  if (/截图|screenshot|录屏|demo/i.test(text)) formats.add("screenshots");
  if (/测试|test\s*report|测试记录/i.test(text)) formats.add("test-records");
  if (/可运行|runnable|能跑|演示/i.test(text)) formats.add("runnable-project");

  const sectionNotes = collectSectionItems(lines, [/交付|提交格式|delivery|submission/i]);
  return {
    formats: [...formats],
    notes: sectionNotes.length ? sectionNotes.join("; ") : undefined
  };
}

function detectMissingInfo(text: string, existingProjectNotes?: string): MissingCriticalInfo[] {
  const missing: MissingCriticalInfo[] = [];
  const push = (question: string, reason: string) => {
    missing.push({
      id: `miss-${missing.length + 1}`,
      question,
      reason,
      resolved: false
    });
  };

  if (!/\d{4}[-/年]\d{1,2}|截止|deadline|due\s*date|提交时间/i.test(text)) {
    push("What is the submission deadline?", "No deadline found in the assignment brief.");
  }
  if (!/node|python|java|spring|react|vue|android|harmony|cangjie|技术栈|框架|language/i.test(text)) {
    push("What tech stack / language is required?", "Stack constraints are not stated clearly.");
  }
  if (!/分|score|point|满分|总分/i.test(text)) {
    push("What are the score weights per criterion?", "Scoring weights are missing or incomplete.");
  }
  if (
    existingProjectNotes?.trim() &&
    !/保留|不得修改|允许修改|minimal|retain|do not change/i.test(text + existingProjectNotes)
  ) {
    push(
      "Which existing features must be retained vs may be modified?",
      "Existing project present but modification scope is unclear."
    );
  }
  return missing;
}

function toRequirement(text: string, index: number): FunctionalRequirement {
  return { id: `req-${index + 1}`, text: stripBullet(text) };
}

function toProhibition(text: string, index: number): Prohibition {
  return { id: `proh-${index + 1}`, text: stripBullet(text) };
}

function isBulletOrNumbered(line: string): boolean {
  return /^\s*(?:[-*•]|（?\d+[.)、．]|\([a-z]\)|[a-z][.)])\s+/i.test(line);
}

function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*•]|（?\d+[.)、．]|\([a-z]\)|[a-z][.)])\s+/i, "").trim();
}

function looksLikeScoreLine(line: string): boolean {
  return (
    /\d{1,3}\s*(?:分|pts?|points?|marks?)(?=\s|$|[，。,.;；\/)])/i.test(line) ||
    /评分|得分|rubric/i.test(line)
  );
}

function looksLikeProhibition(line: string): boolean {
  return /禁止|不允许|不得|must not|do not|don't|勿|严禁/i.test(line);
}

function inferCategory(text: string): ScoringPointCategory {
  if (/测试|test|单元|集成/i.test(text)) return "test";
  if (/文档|报告|readme|论文|说明/i.test(text)) return "docs";
  if (/界面|ui|ux|演示|demo|截图/i.test(text)) return "demo";
  if (/代码|规范|结构|架构|重构|code/i.test(text)) return "code";
  if (/功能|实现|feature|function/i.test(text)) return "function";
  return "other";
}

function normalizeCategory(c?: string): ScoringPointCategory {
  const allowed: ScoringPointCategory[] = ["function", "code", "test", "docs", "demo", "other"];
  if (c && (allowed as string[]).includes(c)) return c as ScoringPointCategory;
  return "other";
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const k = i.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

/** Resolve a missing-info item after user answers. */
export function resolveMissingInfo(
  list: MissingCriticalInfo[],
  id: string,
  answer: string
): MissingCriticalInfo[] {
  return list.map((m) =>
    m.id === id
      ? { ...m, resolved: true, answer: answer.trim() }
      : m
  );
}

export function allCriticalInfoResolved(list: MissingCriticalInfo[]): boolean {
  return list.every((m) => m.resolved);
}

/** Stable id generator for tests that need deterministic ids without UUID. */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
