/**
 * Evidence creation, binding, and quality gating (Task 32).
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  ClaimKind,
  EvidenceLocation,
  EvidenceOrigin,
  EvidenceQualityFlag,
  ResearchClaim,
  ResearchEvidence,
  WebPageContent
} from "./researchTypes.js";
import { normalizeSourceUrl } from "./webTools.js";

const MAX_EXCERPT = 2000;
const MAX_BODY = 20_000;

export function hashContent(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

export function clipExcerpt(text: string, max = MAX_EXCERPT): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function clipBody(text: string, max = MAX_BODY): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

export function defaultTrustScore(origin: EvidenceOrigin, flags: EvidenceQualityFlag[]): number {
  let base =
    origin === "user_material" ? 0.85
      : origin === "pdf" ? 0.75
        : origin === "web" ? 0.6
          : origin === "manual" ? 0.7
            : 0.2; // ai_inference
  if (flags.includes("low_trust")) base -= 0.25;
  if (flags.includes("stale")) base -= 0.15;
  if (flags.includes("invalid") || flags.includes("unreachable")) base -= 0.5;
  if (flags.includes("duplicate")) base -= 0.1;
  if (flags.includes("paywalled")) base -= 0.1;
  if (flags.includes("conflicted")) base -= 0.1;
  return Math.max(0, Math.min(1, Math.round(base * 100) / 100));
}

/** Flags that prevent automatic promotion to final facts. */
export const BLOCKING_QUALITY_FLAGS: readonly EvidenceQualityFlag[] = [
  "duplicate",
  "invalid",
  "unreachable",
  "low_trust",
  "stale"
];

export function canUseAsFinalFact(evidence: ResearchEvidence): boolean {
  if (evidence.origin === "ai_inference") return false;
  if (evidence.status === "excluded" || evidence.status === "flagged") return false;
  if (evidence.qualityFlags.some((f) => BLOCKING_QUALITY_FLAGS.includes(f))) return false;
  if (evidence.trustScore < 0.4) return false;
  if (!evidence.excerpt.trim()) return false;
  return true;
}

export function createEvidence(input: {
  title: string;
  source: string;
  excerpt: string;
  origin: EvidenceOrigin;
  author?: string;
  publishedAt?: string;
  accessedAt?: string;
  location?: EvidenceLocation;
  body?: string;
  qualityFlags?: EvidenceQualityFlag[];
  trustScore?: number;
  status?: ResearchEvidence["status"];
  metadata?: Record<string, unknown>;
  id?: string;
  now?: () => Date;
}): ResearchEvidence {
  const now = input.now ?? (() => new Date());
  const accessedAt = input.accessedAt ?? now().toISOString();
  const flags = [...(input.qualityFlags ?? [])];
  const origin = input.origin;
  const trustScore = input.trustScore ?? defaultTrustScore(origin, flags);
  const excerpt = clipExcerpt(input.excerpt);
  const source =
    origin === "web" ? (normalizeSourceUrl(input.source) || input.source) : input.source;

  let status = input.status ?? "active";
  if (flags.some((f) => f === "invalid" || f === "unreachable") && status === "active") {
    status = "flagged";
  }

  return {
    id: input.id ?? randomUUID(),
    title: input.title.trim() || "Untitled",
    author: input.author?.trim() || undefined,
    source,
    publishedAt: input.publishedAt,
    accessedAt,
    excerpt,
    location: input.location,
    origin,
    contentHash: hashContent(excerpt || input.body || source),
    status,
    qualityFlags: flags,
    trustScore,
    body: input.body !== undefined ? clipBody(input.body) : undefined,
    metadata: input.metadata,
    createdAt: now().toISOString()
  };
}

export function evidenceFromWebPage(
  page: WebPageContent,
  options?: { excerpt?: string; location?: EvidenceLocation; qualityFlags?: EvidenceQualityFlag[]; now?: () => Date }
): ResearchEvidence {
  const excerpt = options?.excerpt ?? clipExcerpt(page.text);
  return createEvidence({
    title: page.title || page.url,
    source: page.url,
    author: page.author,
    publishedAt: page.publishedAt,
    accessedAt: page.fetchedAt,
    excerpt,
    body: page.text,
    origin: "web",
    location: options?.location ?? { charStart: 0, charEnd: Math.min(excerpt.length, page.text.length) },
    qualityFlags: options?.qualityFlags,
    metadata: { statusCode: page.statusCode, contentType: page.contentType },
    now: options?.now
  });
}

export function markEvidence(
  evidence: ResearchEvidence,
  flags: EvidenceQualityFlag[],
  status?: ResearchEvidence["status"]
): ResearchEvidence {
  const qualityFlags = uniqueFlags([...evidence.qualityFlags, ...flags]);
  const nextStatus =
    status
    ?? (qualityFlags.some((f) => f === "invalid" || f === "unreachable" || f === "low_trust")
      ? "flagged"
      : evidence.status);
  return {
    ...evidence,
    qualityFlags,
    status: nextStatus,
    trustScore: defaultTrustScore(evidence.origin, qualityFlags)
  };
}

function uniqueFlags(flags: EvidenceQualityFlag[]): EvidenceQualityFlag[] {
  return [...new Set(flags)];
}

export function originMarkerForClaim(kind: ClaimKind): ResearchClaim["originMarker"] {
  if (kind === "ai_inference") return "ai_inference";
  if (kind === "user_material") return "user_material";
  return "source_backed";
}

/**
 * Bind a claim to Evidence. Facts/conclusions require at least one usable
 * evidence id when forceEvidenceMode is true.
 */
export function createClaim(input: {
  text: string;
  kind: ClaimKind;
  evidenceIds?: string[];
  evidencePool?: ResearchEvidence[];
  forceEvidenceMode?: boolean;
  notes?: string;
  id?: string;
  now?: () => Date;
}): ResearchClaim {
  const now = input.now ?? (() => new Date());
  const kind = input.kind;
  const evidenceIds = [...new Set(input.evidenceIds ?? [])];
  const originMarker = originMarkerForClaim(kind);
  const force = input.forceEvidenceMode !== false;

  if ((kind === "fact" || kind === "conclusion") && force && evidenceIds.length === 0) {
    throw new EvidenceBindingError(
      `${kind} claims require at least one Evidence binding when forceEvidenceMode is enabled.`,
      "missing_evidence"
    );
  }

  if (kind === "ai_inference" && evidenceIds.length > 0) {
    // AI inference may cite sources as context but keeps distinct marker.
  }

  let finalFactEligible = false;
  if (kind === "fact" || kind === "conclusion") {
    if (evidenceIds.length === 0) {
      finalFactEligible = !force;
    } else if (input.evidencePool) {
      const bound = input.evidencePool.filter((e) => evidenceIds.includes(e.id));
      finalFactEligible =
        bound.length > 0 && bound.every((e) => canUseAsFinalFact(e));
    } else {
      finalFactEligible = evidenceIds.length > 0;
    }
  } else if (kind === "user_material") {
    finalFactEligible = false; // user materials are inputs, not auto final facts
  } else {
    finalFactEligible = false; // ai_inference never final fact
  }

  return {
    id: input.id ?? randomUUID(),
    text: input.text.trim(),
    kind,
    evidenceIds,
    originMarker,
    finalFactEligible,
    notes: input.notes,
    createdAt: now().toISOString()
  };
}

export class EvidenceBindingError extends Error {
  constructor(
    message: string,
    readonly code: "missing_evidence" | "invalid_evidence" | "unsupported_kind"
  ) {
    super(message);
    this.name = "EvidenceBindingError";
  }
}

/**
 * Recompute finalFactEligible after evidence quality changes.
 */
export function reevaluateClaimEligibility(
  claim: ResearchClaim,
  evidencePool: ResearchEvidence[],
  forceEvidenceMode: boolean
): ResearchClaim {
  if (claim.kind === "ai_inference" || claim.kind === "user_material") {
    return { ...claim, finalFactEligible: false };
  }
  if (claim.evidenceIds.length === 0) {
    return { ...claim, finalFactEligible: !forceEvidenceMode };
  }
  const bound = evidencePool.filter((e) => claim.evidenceIds.includes(e.id));
  if (bound.length !== claim.evidenceIds.length) {
    return { ...claim, finalFactEligible: false };
  }
  return {
    ...claim,
    finalFactEligible: bound.every((e) => canUseAsFinalFact(e))
  };
}

/** Simple support heuristic: excerpt/body contains a substantial token overlap with claim. */
export function evidenceSupportsClaim(evidence: ResearchEvidence, claimText: string): boolean {
  const corpus = `${evidence.excerpt} ${evidence.body ?? ""}`.toLowerCase();
  if (!corpus.trim()) return false;
  const tokens = claimText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) {
    return corpus.includes(claimText.toLowerCase().trim());
  }
  const hits = tokens.filter((t) => corpus.includes(t)).length;
  // At least half of significant tokens, or a long contiguous substring.
  if (claimText.trim().length >= 12 && corpus.includes(claimText.toLowerCase().trim())) {
    return true;
  }
  return hits / tokens.length >= 0.5;
}
