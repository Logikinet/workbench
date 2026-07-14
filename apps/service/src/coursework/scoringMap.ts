/**
 * Scoring-point coverage map: each 评分点 maps to implementation files,
 * run evidence, and/or report chapters. Placeholder (fake UI) evidence never
 * counts as coverage.
 */

import type {
  CourseworkEvidenceItem,
  ScoringCoverageResult,
  ScoringMappingKind,
  ScoringMappingTarget,
  ScoringPoint,
  ScoringPointMapping,
  SpecExtractResult
} from "./courseworkTypes.js";

const KIND_RANK: Record<ScoringMappingKind, number> = {
  implementation_file: 3,
  run_evidence: 3,
  test_record: 2,
  screenshot: 2,
  report_chapter: 1
};

export function emptyMappings(points: ScoringPoint[]): ScoringPointMapping[] {
  return points.map((p) => ({
    scoringPointId: p.id,
    targets: [],
    covered: false
  }));
}

export function mapFromSpec(spec: SpecExtractResult): ScoringPointMapping[] {
  return emptyMappings(spec.scoringPoints);
}

/**
 * Attach a mapping target to a scoring point. Recomputes `covered`.
 * Fake/placeholder evidence refs are rejected (not added).
 */
export function addMappingTarget(
  mappings: ScoringPointMapping[],
  scoringPointId: string,
  target: ScoringMappingTarget,
  options: { rejectPlaceholders?: boolean; placeholderRefs?: Set<string> } = {}
): ScoringPointMapping[] {
  const rejectPlaceholders = options.rejectPlaceholders !== false;
  if (
    rejectPlaceholders &&
    options.placeholderRefs?.has(target.ref)
  ) {
    return mappings.map((m) => ({ ...m, targets: [...m.targets], covered: recomputeCovered(m.targets) }));
  }

  return mappings.map((m) => {
    if (m.scoringPointId !== scoringPointId) {
      return { ...m, targets: [...m.targets] };
    }
    const exists = m.targets.some((t) => t.kind === target.kind && t.ref === target.ref);
    const targets = exists ? [...m.targets] : [...m.targets, { ...target }];
    return { scoringPointId: m.scoringPointId, targets, covered: recomputeCovered(targets) };
  });
}

/**
 * Auto-bind evidence items that declare relatedScoringPointIds.
 * Placeholder evidence is skipped (cannot cover scoring points).
 */
export function bindEvidenceToScoringMap(
  mappings: ScoringPointMapping[],
  evidence: CourseworkEvidenceItem[]
): ScoringPointMapping[] {
  let next = mappings.map((m) => ({
    scoringPointId: m.scoringPointId,
    targets: [...m.targets],
    covered: m.covered
  }));

  for (const item of evidence) {
    if (item.isPlaceholder) continue;
    const kind = evidenceKindToMapping(item.kind);
    if (!kind) continue;
    const ref = item.path ?? item.id;
    for (const spId of item.relatedScoringPointIds) {
      next = addMappingTarget(next, spId, {
        kind,
        ref,
        note: item.title
      });
    }
  }
  return next.map((m) => ({ ...m, covered: recomputeCovered(m.targets) }));
}

export function recomputeCovered(targets: ScoringMappingTarget[]): boolean {
  // Covered when at least one substantive target exists (not report-only alone is ok
  // if report_chapter is the only kind — still counts, but no-mistakes may warn).
  return targets.length > 0;
}

/**
 * Stronger coverage: prefers implementation or run evidence over report-only.
 */
export function hasStrongCoverage(mapping: ScoringPointMapping): boolean {
  return mapping.targets.some(
    (t) => t.kind === "implementation_file" || t.kind === "run_evidence" || t.kind === "test_record"
  );
}

export function evaluateScoringCoverage(
  mappings: ScoringPointMapping[],
  options: { requireStrong?: boolean } = {}
): ScoringCoverageResult {
  const requireStrong = options.requireStrong === true;
  const uncoveredIds: string[] = [];
  for (const m of mappings) {
    const ok = requireStrong ? hasStrongCoverage(m) : m.covered;
    if (!ok) uncoveredIds.push(m.scoringPointId);
  }
  return {
    ok: uncoveredIds.length === 0 && mappings.length > 0,
    mappings: mappings.map((m) => ({
      ...m,
      covered: requireStrong ? hasStrongCoverage(m) : recomputeCovered(m.targets)
    })),
    uncoveredIds
  };
}

export function coverageSummary(
  mappings: ScoringPointMapping[],
  points: ScoringPoint[]
): string {
  const byId = new Map(points.map((p) => [p.id, p]));
  const covered = mappings.filter((m) => m.covered).length;
  const strong = mappings.filter((m) => hasStrongCoverage(m)).length;
  const lines = [
    `Scoring coverage: ${covered}/${mappings.length} mapped, ${strong}/${mappings.length} strong`,
    ...mappings.map((m) => {
      const title = byId.get(m.scoringPointId)?.title ?? m.scoringPointId;
      const kinds = m.targets.map((t) => t.kind).join("+") || "none";
      const strength = hasStrongCoverage(m) ? "strong" : m.covered ? "weak" : "uncovered";
      return `- ${title} [${strength}] → ${kinds}`;
    })
  ];
  return lines.join("\n");
}

function evidenceKindToMapping(kind: CourseworkEvidenceItem["kind"]): ScoringMappingKind | null {
  switch (kind) {
    case "implementation":
      return "implementation_file";
    case "screenshot":
      return "screenshot";
    case "test_record":
      return "test_record";
    case "run_log":
    case "verification":
      return "run_evidence";
    case "document":
      return "report_chapter";
    case "research":
    case "file":
      return "run_evidence";
    default:
      return null;
  }
}

export function bestMappingStrength(mapping: ScoringPointMapping): number {
  if (mapping.targets.length === 0) return 0;
  return Math.max(...mapping.targets.map((t) => KIND_RANK[t.kind] ?? 0));
}
