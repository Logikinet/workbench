/**
 * Secondmate-style outline generation for document/paper workflow (Task 33).
 * Uses injectable ModelProvider (FakeModelProvider in tests).
 * User must approve outline before writing.
 */

import { randomUUID } from "node:crypto";
import type { ModelProvider } from "../model/types.js";
import type {
  DocumentMaterial,
  DocumentOutline,
  OutlineModelOutput,
  OutlineSection,
  ResearchEvidence
} from "./documentTypes.js";
import { isOriginalMaterial } from "./materialImport.js";

export class OutlineError extends Error {
  constructor(
    message: string,
    readonly code: "model_failed" | "invalid_output" | "not_awaiting" | "already_approved"
  ) {
    super(message);
    this.name = "OutlineError";
  }
}

export interface GenerateOutlineInput {
  title: string;
  goal: string;
  materials: DocumentMaterial[];
  evidence: ResearchEvidence[];
  projectFacts: string[];
  model: ModelProvider;
  connectionId?: string;
  modelId?: string;
  now?: () => Date;
  signal?: AbortSignal;
}

const OUTLINE_SYSTEM = `You are Secondmate planning a document/paper outline.
Only use provided project facts, user materials, templates, and Evidence.
Never invent data, awards, experiments, or references.
Return JSON: { title, summary, sections: [{ title, summary, materialIds?, evidenceIds?, acceptanceCriteria?, missingData? }], missingDataList?, acceptanceCriteria? }.
Bind real material/evidence ids when available. List missing data explicitly.`;

export async function generateOutline(input: GenerateOutlineInput): Promise<DocumentOutline> {
  const now = input.now ?? (() => new Date());
  const pack = buildOutlineContextPack(input);
  const response = await input.model.complete({
    connectionId: input.connectionId ?? "fake-connection",
    modelId: input.modelId ?? "fake-model",
    messages: [
      { role: "system", content: OUTLINE_SYSTEM },
      { role: "user", content: pack }
    ],
    signal: input.signal
  });

  const parsed = parseOutlineModelOutput(response.content);
  return outlineFromModelOutput(parsed, input, now);
}

export function buildOutlineContextPack(input: {
  title: string;
  goal: string;
  materials: DocumentMaterial[];
  evidence: ResearchEvidence[];
  projectFacts: string[];
}): string {
  const originals = input.materials.filter(isOriginalMaterial);
  const lines: string[] = [
    `# Document: ${input.title}`,
    `Goal: ${input.goal}`,
    "",
    "## Project facts",
    ...input.projectFacts.map((f, i) => `${i + 1}. ${f}`),
    input.projectFacts.length === 0 ? "_none_" : "",
    "",
    "## Materials (original only)",
    ""
  ];
  for (const m of originals) {
    lines.push(`- id=${m.id} kind=${m.kind} format=${m.format} title=${m.title}`);
    lines.push(`  excerpt: ${m.text.slice(0, 400).replace(/\n/g, " ")}`);
  }
  if (originals.length === 0) lines.push("_none_");

  lines.push("", "## Evidence", "");
  for (const e of input.evidence) {
    lines.push(`- id=${e.id} title=${e.title} source=${e.source} origin=${e.origin}`);
    lines.push(`  excerpt: ${e.excerpt.slice(0, 300).replace(/\n/g, " ")}`);
  }
  if (input.evidence.length === 0) lines.push("_none_");

  lines.push(
    "",
    "Produce a chapter outline with material/evidence bindings, acceptance criteria, and missing data list."
  );
  return lines.filter((l) => l !== undefined).join("\n");
}

export function parseOutlineModelOutput(content: string): OutlineModelOutput {
  let raw: unknown;
  try {
    const trimmed = content.trim();
    const jsonSlice = extractJsonObject(trimmed);
    raw = JSON.parse(jsonSlice);
  } catch {
    throw new OutlineError("Outline model returned non-JSON content.", "invalid_output");
  }
  if (!raw || typeof raw !== "object") {
    throw new OutlineError("Outline model output is not an object.", "invalid_output");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string" || !obj.title.trim()) {
    throw new OutlineError("Outline missing title.", "invalid_output");
  }
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) {
    throw new OutlineError("Outline must include at least one section.", "invalid_output");
  }
  const sections = obj.sections.map((s, i) => {
    if (!s || typeof s !== "object") {
      throw new OutlineError(`Section ${i} invalid.`, "invalid_output");
    }
    const sec = s as Record<string, unknown>;
    if (typeof sec.title !== "string" || !sec.title.trim()) {
      throw new OutlineError(`Section ${i} missing title.`, "invalid_output");
    }
    return {
      title: sec.title.trim(),
      summary: typeof sec.summary === "string" ? sec.summary : "",
      materialIds: asStringArray(sec.materialIds),
      evidenceIds: asStringArray(sec.evidenceIds),
      acceptanceCriteria: asStringArray(sec.acceptanceCriteria),
      missingData: asStringArray(sec.missingData)
    };
  });
  return {
    title: obj.title.trim(),
    summary: typeof obj.summary === "string" ? obj.summary : "",
    sections,
    missingDataList: asStringArray(obj.missingDataList),
    acceptanceCriteria: asStringArray(obj.acceptanceCriteria)
  };
}

export function outlineFromModelOutput(
  parsed: OutlineModelOutput,
  ctx: {
    materials: DocumentMaterial[];
    evidence: ResearchEvidence[];
  },
  now: () => Date = () => new Date()
): DocumentOutline {
  const materialIds = new Set(ctx.materials.map((m) => m.id));
  const evidenceIds = new Set(ctx.evidence.map((e) => e.id));

  const sections: OutlineSection[] = parsed.sections.map((s, order) => {
    const validMaterials = (s.materialIds ?? []).filter((id) => materialIds.has(id));
    const validEvidence = (s.evidenceIds ?? []).filter((id) => evidenceIds.has(id));
    const missing = [...(s.missingData ?? [])];
    // Unbound section with no materials/evidence → mark missing grounding
    if (validMaterials.length === 0 && validEvidence.length === 0) {
      missing.push("No materials or Evidence bound — writer must not invent facts for this section.");
    }
    return {
      id: randomUUID(),
      title: s.title,
      order,
      summary: s.summary ?? "",
      materialIds: validMaterials,
      evidenceIds: validEvidence,
      acceptanceCriteria: s.acceptanceCriteria ?? [],
      missingData: missing,
      status: "planned" as const
    };
  });

  const sessionMissing = [
    ...(parsed.missingDataList ?? []),
    ...sections.flatMap((s) => s.missingData)
  ];
  const uniqueMissing = [...new Set(sessionMissing.map((m) => m.trim()).filter(Boolean))];

  return {
    id: randomUUID(),
    title: parsed.title,
    summary: parsed.summary ?? "",
    sections,
    missingDataList: uniqueMissing,
    acceptanceCriteria: parsed.acceptanceCriteria ?? [],
    status: "awaiting_approval",
    generatedAt: now().toISOString()
  };
}

/** User approves outline — required before writing. */
export function approveOutline(
  outline: DocumentOutline,
  now: () => Date = () => new Date()
): DocumentOutline {
  if (outline.status === "approved") {
    throw new OutlineError("Outline is already approved.", "already_approved");
  }
  if (outline.status !== "awaiting_approval" && outline.status !== "draft" && outline.status !== "rejected") {
    throw new OutlineError(`Cannot approve outline in status ${outline.status}.`, "not_awaiting");
  }
  return {
    ...outline,
    status: "approved",
    approvedAt: now().toISOString(),
    rejectedReason: undefined,
    sections: outline.sections.map((s) => ({ ...s, status: "approved" as const }))
  };
}

export function rejectOutline(
  outline: DocumentOutline,
  reason: string
): DocumentOutline {
  return {
    ...outline,
    status: "rejected",
    approvedAt: undefined,
    rejectedReason: reason.trim() || "Rejected by user",
    sections: outline.sections.map((s) => ({ ...s, status: "planned" as const }))
  };
}

export function assertOutlineApproved(outline: DocumentOutline | undefined): asserts outline is DocumentOutline {
  if (!outline) throw new OutlineError("No outline present.", "not_awaiting");
  if (outline.status !== "approved") {
    throw new OutlineError("Outline must be approved before writing.", "not_awaiting");
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}

function extractJsonObject(text: string): string {
  if (text.startsWith("{")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}
