/**
 * Research question split, parallel steps, and pre-summary aggregation (Task 32).
 *
 * Aggregation must finish source dedup + conflict organization before
 * research.md / final facts are produced.
 */

import { randomUUID } from "node:crypto";
import {
  canUseAsFinalFact,
  markEvidence,
  reevaluateClaimEligibility
} from "./evidence.js";
import type {
  AggregateResult,
  ConflictingViewpoint,
  ResearchClaim,
  ResearchEvidence,
  ResearchSession,
  ResearchStep,
  StructuredSource
} from "./researchTypes.js";
import { normalizeSourceUrl } from "./webTools.js";

/** Split a research goal into sub-questions (heuristic, deterministic). */
export function splitResearchQuestions(goal: string, max = 6): string[] {
  const cleaned = goal.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  // Prefer explicit numbered / bulleted lines.
  const lines = cleaned
    .split(/\n+/)
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter((l) => l.length >= 8);

  if (lines.length >= 2) {
    return lines.slice(0, max);
  }

  // Split on Chinese/English question separators.
  const parts = cleaned
    .split(/[?？;；]|以及|and then|以及|、(?=[^、]{8,})/i)
    .map((p) => p.trim())
    .filter((p) => p.length >= 8);

  if (parts.length >= 2) {
    return parts.slice(0, max).map((p) => (p.endsWith("?") || p.endsWith("？") ? p : `${p}?`));
  }

  // Keyword facets for a single topic.
  const topic = cleaned.replace(/[?？]/g, "").trim();
  return [
    `What is the definition and scope of: ${topic}?`,
    `What are the key facts and recent developments about: ${topic}?`,
    `What are competing viewpoints or controversies about: ${topic}?`,
    `What sources and evidence quality issues exist for: ${topic}?`
  ].slice(0, max);
}

export function createStepsFromQuestions(
  questions: string[],
  options?: { parallel?: boolean; now?: () => Date }
): ResearchStep[] {
  const parallel = options?.parallel !== false;
  return questions.map((question, index) => ({
    id: randomUUID(),
    question,
    parallelGroup: parallel ? "gather" : `serial-${index}`,
    status: "pending" as const,
    evidenceIds: [],
    claimIds: []
  }));
}

export function startStep(step: ResearchStep, now = () => new Date()): ResearchStep {
  return {
    ...step,
    status: "running",
    startedAt: step.startedAt ?? now().toISOString()
  };
}

export function completeStep(
  step: ResearchStep,
  input: { evidenceIds?: string[]; claimIds?: string[]; error?: string },
  now = () => new Date()
): ResearchStep {
  if (input.error) {
    return {
      ...step,
      status: "failed",
      error: input.error,
      completedAt: now().toISOString()
    };
  }
  return {
    ...step,
    status: "completed",
    evidenceIds: [...new Set([...(step.evidenceIds ?? []), ...(input.evidenceIds ?? [])])],
    claimIds: [...new Set([...(step.claimIds ?? []), ...(input.claimIds ?? [])])],
    completedAt: now().toISOString(),
    error: undefined
  };
}

/** Steps that may run concurrently (same parallel group, pending). */
export function frontierParallelSteps(steps: ResearchStep[]): ResearchStep[] {
  const pending = steps.filter((s) => s.status === "pending");
  if (pending.length === 0) return [];
  const runningGroups = new Set(
    steps.filter((s) => s.status === "running").map((s) => s.parallelGroup ?? s.id)
  );
  // Prefer one group at a time for fairness; all pending in that group.
  const firstGroup = pending[0]!.parallelGroup ?? pending[0]!.id;
  if (runningGroups.size > 0 && !runningGroups.has(firstGroup)) {
    // Another group is running — only return empty if groups differ and we want exclusive groups.
    // Ticket: research steps can be parallel — allow all pending in non-conflicting groups.
  }
  return pending.filter((s) => (s.parallelGroup ?? s.id) === firstGroup || !runningGroups.size);
}

/** Prefer richer / higher-trust evidence as the canonical record for a source. */
function evidenceRichness(e: ResearchEvidence): number {
  const bodyLen = e.body?.length ?? 0;
  const excerptLen = e.excerpt?.length ?? 0;
  return e.trustScore * 1000 + bodyLen + excerptLen;
}

function sourceKeyOf(item: ResearchEvidence): string {
  return item.origin === "web"
    ? `url:${normalizeSourceUrl(item.source) || item.source}`
    : `src:${item.source}`;
}

/**
 * Deduplicate evidence by normalized source URL and content hash.
 * Keeps the richest record as canonical; other copies are flagged duplicate
 * (not used as independent final facts). Claims should remap via duplicateOf.
 */
export function deduplicateEvidence(evidence: ResearchEvidence[]): {
  evidence: ResearchEvidence[];
  duplicatesMerged: number;
  /** Maps every evidence id → canonical id (identity for canonicals). */
  canonicalIdByEvidenceId: Map<string, string>;
  canonicalByKey: Map<string, string>;
} {
  // Group by source key first (primary), then merge pure content-hash groups.
  const bySource = new Map<string, ResearchEvidence[]>();
  for (const item of evidence) {
    const key = sourceKeyOf(item);
    const list = bySource.get(key) ?? [];
    list.push(item);
    bySource.set(key, list);
  }

  const canonicalByKey = new Map<string, string>();
  const canonicalIdByEvidenceId = new Map<string, string>();
  const result: ResearchEvidence[] = [];
  let duplicatesMerged = 0;

  // Track hash → canonical for cross-source identical excerpts.
  const hashCanonical = new Map<string, string>();

  for (const [, group] of bySource) {
    const ranked = [...group].sort((a, b) => evidenceRichness(b) - evidenceRichness(a));
    const winner = ranked[0]!;
    // If an earlier group already claimed this content hash, defer to that canonical.
    const priorHashCanonical = hashCanonical.get(winner.contentHash);
    let canonical = winner;
    if (priorHashCanonical && priorHashCanonical !== winner.id) {
      // Entire group duplicates prior content — all map to prior canonical.
      for (const item of ranked) {
        duplicatesMerged += item.id === priorHashCanonical ? 0 : 1;
        if (item.id === priorHashCanonical) {
          result.push(item);
          canonicalIdByEvidenceId.set(item.id, item.id);
        } else {
          const flagged = markEvidence(item, ["duplicate"], "flagged");
          result.push({
            ...flagged,
            metadata: { ...flagged.metadata, duplicateOf: priorHashCanonical }
          });
          canonicalIdByEvidenceId.set(item.id, priorHashCanonical);
        }
      }
      canonicalByKey.set(sourceKeyOf(winner), priorHashCanonical);
      continue;
    }

    canonicalByKey.set(sourceKeyOf(winner), canonical.id);
    hashCanonical.set(canonical.contentHash, canonical.id);
    canonicalByKey.set(`hash:${canonical.contentHash}`, canonical.id);

    for (const item of ranked) {
      if (item.id === canonical.id) {
        // Strip accidental duplicate flag from winner.
        const cleaned: ResearchEvidence = {
          ...item,
          qualityFlags: item.qualityFlags.filter((f) => f !== "duplicate"),
          status: item.status === "flagged" && item.qualityFlags.every((f) => f === "duplicate")
            ? "active"
            : item.status,
          metadata: item.metadata?.duplicateOf
            ? { ...item.metadata, duplicateOf: undefined }
            : item.metadata
        };
        // Recompute trust if we removed only duplicate flags — keep existing trustScore.
        result.push(cleaned);
        canonicalIdByEvidenceId.set(item.id, canonical.id);
      } else {
        duplicatesMerged += 1;
        const flagged = markEvidence(item, ["duplicate"], "flagged");
        result.push({
          ...flagged,
          metadata: { ...flagged.metadata, duplicateOf: canonical.id }
        });
        canonicalIdByEvidenceId.set(item.id, canonical.id);
      }
    }
  }

  return { evidence: result, duplicatesMerged, canonicalIdByEvidenceId, canonicalByKey };
}

/** Remap claim evidence ids from duplicates onto their canonical records. */
export function remapClaimEvidenceIds(
  claims: ResearchClaim[],
  canonicalIdByEvidenceId: Map<string, string>
): ResearchClaim[] {
  return claims.map((claim) => {
    if (claim.evidenceIds.length === 0) return claim;
    const remapped = [...new Set(claim.evidenceIds.map((id) => canonicalIdByEvidenceId.get(id) ?? id))];
    return { ...claim, evidenceIds: remapped };
  });
}

export function buildStructuredSources(evidence: ResearchEvidence[]): StructuredSource[] {
  const bySource = new Map<string, StructuredSource>();

  for (const e of evidence) {
    const key =
      e.origin === "web" ? normalizeSourceUrl(e.source) || e.source : e.source;
    const existing = bySource.get(key);
    if (!existing) {
      bySource.set(key, {
        id: randomUUID(),
        title: e.title,
        author: e.author,
        source: e.source,
        publishedAt: e.publishedAt,
        accessedAt: e.accessedAt,
        origin: e.origin,
        evidenceIds: [e.id],
        qualityFlags: [...e.qualityFlags],
        trustScore: e.trustScore,
        canonicalEvidenceId: e.id,
        duplicateOf: typeof e.metadata?.duplicateOf === "string" ? e.metadata.duplicateOf : undefined
      });
    } else {
      existing.evidenceIds.push(e.id);
      existing.qualityFlags = [...new Set([...existing.qualityFlags, ...e.qualityFlags])];
      existing.trustScore = Math.max(existing.trustScore, e.trustScore);
      if (e.qualityFlags.includes("duplicate")) {
        existing.duplicateOf = existing.duplicateOf ?? (e.metadata?.duplicateOf as string | undefined);
      }
    }
  }

  return [...bySource.values()];
}

/**
 * Detect conflicting viewpoints: claims that share topic tokens but disagree
 * (negation / opposite markers) with different evidence.
 */
export function organizeConflicts(claims: ResearchClaim[]): ConflictingViewpoint[] {
  const facts = claims.filter((c) => c.kind === "fact" || c.kind === "conclusion");
  const conflicts: ConflictingViewpoint[] = [];
  const used = new Set<string>();

  for (let i = 0; i < facts.length; i++) {
    const a = facts[i]!;
    if (used.has(a.id)) continue;
    const group: ResearchClaim[] = [a];

    for (let j = i + 1; j < facts.length; j++) {
      const b = facts[j]!;
      if (used.has(b.id)) continue;
      if (looksConflicting(a.text, b.text)) {
        group.push(b);
      }
    }

    if (group.length >= 2) {
      for (const c of group) used.add(c.id);
      const topic = sharedTopic(group.map((g) => g.text));
      conflicts.push({
        id: randomUUID(),
        topic,
        positions: group.map((c) => ({
          claimId: c.id,
          summary: c.text,
          evidenceIds: [...c.evidenceIds]
        })),
        resolution: "present_both",
        notes: "Conflicting viewpoints retained for Reviewer; neither auto-selected as sole final fact."
      });
    }
  }

  return conflicts;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function sharedTopic(texts: string[]): string {
  if (texts.length === 0) return "unknown";
  const sets = texts.map((t) => new Set(tokenize(t)));
  const first = [...sets[0]!];
  const shared = first.filter((t) => sets.every((s) => s.has(t)));
  return shared.slice(0, 6).join(" ") || texts[0]!.slice(0, 80);
}

function looksConflicting(a: string, b: string): boolean {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  const overlap = [...ta].filter((t) => tb.has(t));
  if (overlap.length < 2) return false;

  const negA = /\b(not|no|never|false|incorrect|不是|并非|未|没有|否认)\b/i.test(a);
  const negB = /\b(not|no|never|false|incorrect|不是|并非|未|没有|否认)\b/i.test(b);
  if (negA !== negB) return true;

  // Opposite comparatives
  const up = /\b(increase|rise|higher|增长|上升|更高)\b/i;
  const down = /\b(decrease|fall|lower|下降|减少|更低)\b/i;
  if ((up.test(a) && down.test(b)) || (down.test(a) && up.test(b))) return true;

  return false;
}

/**
 * Full aggregation gate: dedup sources, organize conflicts, re-evaluate claims.
 * Must run before producing final research artifacts.
 */
export function aggregateSession(session: ResearchSession): AggregateResult {
  const { evidence, duplicatesMerged, canonicalIdByEvidenceId } = deduplicateEvidence(session.evidence);

  // Remap bindings so claims point at canonical (richest) evidence after dedup.
  const remappedClaims = remapClaimEvidenceIds(session.claims, canonicalIdByEvidenceId);

  // Exclude non-usable evidence from final-fact path (flag, don't delete).
  let flaggedExcludedFromFacts = 0;
  const gated = evidence.map((e) => {
    if (!canUseAsFinalFact(e) && e.status === "active" && e.origin !== "ai_inference") {
      // Keep active but claim eligibility will fail; count blocking flags.
      if (e.qualityFlags.length > 0) flaggedExcludedFromFacts += 1;
      return e;
    }
    if (!canUseAsFinalFact(e)) {
      flaggedExcludedFromFacts += 1;
    }
    return e;
  });

  const conflicts = organizeConflicts(remappedClaims);
  // Mark evidence involved in conflicts
  const conflictedEvidenceIds = new Set(conflicts.flatMap((c) => c.positions.flatMap((p) => p.evidenceIds)));
  const withConflictFlags = gated.map((e) =>
    conflictedEvidenceIds.has(e.id) && !e.qualityFlags.includes("conflicted")
      ? markEvidence(e, ["conflicted"])
      : e
  );

  const claims = remappedClaims.map((c) =>
    reevaluateClaimEligibility(c, withConflictFlags, session.forceEvidenceMode)
  );

  // Claims that participate in unresolved conflicts are not sole final facts.
  const conflictClaimIds = new Set(conflicts.flatMap((c) => c.positions.map((p) => p.claimId)));
  const claimsWithConflict = claims.map((c) =>
    conflictClaimIds.has(c.id) ? { ...c, finalFactEligible: false, notes: c.notes ?? "In conflicting viewpoint set." } : c
  );

  const sources = buildStructuredSources(withConflictFlags);
  const now = new Date().toISOString();

  const next: ResearchSession = {
    ...session,
    evidence: withConflictFlags,
    claims: claimsWithConflict,
    sources,
    conflicts,
    aggregated: true,
    status: "ready_for_review",
    updatedAt: now
  };

  return {
    session: next,
    duplicatesMerged,
    conflictsFound: conflicts.length,
    flaggedExcludedFromFacts
  };
}

export function assertAggregated(session: ResearchSession): void {
  if (!session.aggregated) {
    throw new Error("Research aggregation (dedup + conflict organization) must complete before summary artifacts.");
  }
}
