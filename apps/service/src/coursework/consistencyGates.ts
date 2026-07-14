/**
 * Consistency gates for coursework delivery.
 *
 * Code, real tests, screenshot evidence, and report claims must align.
 * Empty shell / fake UI must never count as completed functionality.
 */

import { randomUUID } from "node:crypto";
import type {
  ConsistencyCheckResult,
  ConsistencyFinding,
  CourseworkEvidenceItem,
  CourseworkSession,
  ProjectScopePolicy,
  ScoringPointMapping,
  SpecExtractResult
} from "./courseworkTypes.js";
import { evaluateScoringCoverage, hasStrongCoverage } from "./scoringMap.js";

/** Phrases that indicate placeholder / fake UI rather than real implementation. */
export const FAKE_UI_PATTERNS: RegExp[] = [
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bcoming soon\b/i,
  /\bunder construction\b/i,
  /\bplaceholder\b/i,
  /\blorem ipsum\b/i,
  /功能开发中/,
  /暂未实现/,
  /待实现/,
  /假数据/,
  /mock\s*only/i,
  /\bstub\s*ui\b/i,
  /\bshell\s*only\b/i,
  /空壳/,
  /仅界面/,
  /静态页面冒充/,
  /fake\s*ui/i,
  /not\s*implemented/i
];

export interface ReportClaim {
  id: string;
  text: string;
  /** Scoring points or requirements this claim asserts. */
  relatedIds?: string[];
}

export interface ConsistencyCheckInput {
  spec?: SpecExtractResult;
  scoringMap: ScoringPointMapping[];
  evidence: CourseworkEvidenceItem[];
  scopePolicy: ProjectScopePolicy;
  /** Free-text report / README excerpts to scan for unsupported claims. */
  reportClaims?: ReportClaim[];
  /** Paths modified during development (for scope checks). */
  changedPaths?: string[];
  /** When true, require strong coverage (impl/run/test) for every scoring point. */
  requireStrongCoverage?: boolean;
}

export function checkConsistency(input: ConsistencyCheckInput): ConsistencyCheckResult {
  const findings: ConsistencyFinding[] = [];

  findings.push(...checkFakeUiEvidence(input.evidence));
  findings.push(...checkPlaceholderCoverage(input.scoringMap, input.evidence));
  findings.push(...checkScoringCoverage(input.scoringMap, input.requireStrongCoverage));
  findings.push(...checkReportAlignment(input.reportClaims ?? [], input.evidence, input.spec));
  findings.push(...checkScopeViolations(input.scopePolicy, input.changedPaths ?? []));
  findings.push(...checkTestEvidence(input.evidence, input.spec));

  const ok = !findings.some((f) => f.severity === "error");
  return { ok, findings };
}

export function checkSessionConsistency(
  session: CourseworkSession,
  options: {
    reportClaims?: ReportClaim[];
    changedPaths?: string[];
    requireStrongCoverage?: boolean;
  } = {}
): ConsistencyCheckResult {
  return checkConsistency({
    spec: session.spec,
    scoringMap: session.scoringMap,
    evidence: session.evidence,
    scopePolicy: session.scopePolicy,
    reportClaims: options.reportClaims,
    changedPaths: options.changedPaths,
    requireStrongCoverage: options.requireStrongCoverage
  });
}

export function detectFakeUiText(text: string): string[] {
  const hits: string[] = [];
  for (const re of FAKE_UI_PATTERNS) {
    if (re.test(text)) hits.push(re.source);
  }
  return hits;
}

function checkFakeUiEvidence(evidence: CourseworkEvidenceItem[]): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  for (const item of evidence) {
    if (item.isPlaceholder) {
      findings.push({
        id: randomUUID(),
        severity: "error",
        kind: "fake_ui",
        message: `Placeholder evidence “${item.title}” cannot prove feature completion.`,
        refs: [item.id, item.path].filter(Boolean) as string[]
      });
      continue;
    }
    const blob = [
      item.title,
      item.path ?? "",
      typeof item.metadata?.caption === "string" ? item.metadata.caption : "",
      typeof item.metadata?.body === "string" ? item.metadata.body : ""
    ].join("\n");
    const hits = detectFakeUiText(blob);
    if (hits.length > 0) {
      findings.push({
        id: randomUUID(),
        severity: "error",
        kind: "fake_ui",
        message: `Evidence “${item.title}” looks like fake/shell UI (${hits.slice(0, 3).join(", ")}).`,
        refs: [item.id]
      });
    }
  }
  return findings;
}

function checkPlaceholderCoverage(
  scoringMap: ScoringPointMapping[],
  evidence: CourseworkEvidenceItem[]
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const placeholderRefs = new Set(
    evidence.filter((e) => e.isPlaceholder).flatMap((e) => [e.id, e.path].filter(Boolean) as string[])
  );
  if (placeholderRefs.size === 0) return findings;

  for (const m of scoringMap) {
    const bad = m.targets.filter((t) => placeholderRefs.has(t.ref));
    if (bad.length > 0) {
      findings.push({
        id: randomUUID(),
        severity: "error",
        kind: "fake_ui",
        message: `Scoring point ${m.scoringPointId} is only backed by placeholder evidence.`,
        refs: bad.map((t) => t.ref)
      });
    }
  }
  return findings;
}

function checkScoringCoverage(
  scoringMap: ScoringPointMapping[],
  requireStrong?: boolean
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const result = evaluateScoringCoverage(scoringMap, { requireStrong: requireStrong === true });
  for (const id of result.uncoveredIds) {
    const m = scoringMap.find((x) => x.scoringPointId === id);
    const weakOnly = m && m.covered && requireStrong && !hasStrongCoverage(m);
    findings.push({
      id: randomUUID(),
      severity: "error",
      kind: "scoring_uncovered",
      message: weakOnly
        ? `Scoring point ${id} has report-only mapping; need implementation file, run evidence, or test record.`
        : `Scoring point ${id} has no mapping to implementation, run evidence, or report chapter.`,
      refs: [id]
    });
  }
  return findings;
}

function checkReportAlignment(
  claims: ReportClaim[],
  evidence: CourseworkEvidenceItem[],
  spec?: SpecExtractResult
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  if (claims.length === 0) return findings;

  const realEvidence = evidence.filter((e) => !e.isPlaceholder);
  const evidenceText = realEvidence
    .map((e) => `${e.title} ${e.path ?? ""} ${JSON.stringify(e.metadata ?? {})}`)
    .join("\n")
    .toLowerCase();

  for (const claim of claims) {
    const fakeHits = detectFakeUiText(claim.text);
    if (fakeHits.length > 0) {
      findings.push({
        id: randomUUID(),
        severity: "error",
        kind: "fake_ui",
        message: `Report claim admits incomplete work: “${truncate(claim.text, 80)}”`,
        refs: [claim.id]
      });
      continue;
    }

    // Claims that assert completion of a scoring point need related evidence
    if (claim.relatedIds?.length) {
      for (const rid of claim.relatedIds) {
        const has = realEvidence.some(
          (e) =>
            e.relatedScoringPointIds.includes(rid) ||
            e.relatedRequirementIds.includes(rid)
        );
        if (!has) {
          findings.push({
            id: randomUUID(),
            severity: "error",
            kind: "report_mismatch",
            message: `Report claims completion for ${rid} without bound non-placeholder evidence.`,
            refs: [claim.id, rid]
          });
        }
      }
    }

    // Heuristic: "已实现 X" / "implemented X" should appear in evidence titles/paths
    const implMatch = claim.text.match(
      /(?:已实现|实现了|implemented|completed|supports?)\s*[“"]?([^”"，。,\n]{2,40})/i
    );
    if (implMatch) {
      const feature = implMatch[1]!.trim().toLowerCase();
      if (feature.length >= 2 && !evidenceText.includes(feature) && realEvidence.length > 0) {
        // Only warn when we have evidence but none mention the feature
        const spMatch = spec?.scoringPoints.some((s) =>
          s.title.toLowerCase().includes(feature) || s.description.toLowerCase().includes(feature)
        );
        if (spMatch) {
          findings.push({
            id: randomUUID(),
            severity: "warning",
            kind: "report_mismatch",
            message: `Report claims “${feature}” but evidence catalog does not mention it.`,
            refs: [claim.id]
          });
        }
      }
    }
  }
  return findings;
}

function checkScopeViolations(
  scope: ProjectScopePolicy,
  changedPaths: string[]
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  if (scope.mode !== "minimal_modify" || changedPaths.length === 0) return findings;

  for (const p of changedPaths) {
    const norm = p.replace(/\\/g, "/");
    if (scope.forbiddenPaths.some((f) => pathMatch(norm, f))) {
      findings.push({
        id: randomUUID(),
        severity: "error",
        kind: "scope_violation",
        message: `Modified forbidden path “${p}” under minimal-modify policy.`,
        refs: [p]
      });
      continue;
    }
    if (
      scope.allowedModificationScope.length > 0 &&
      !scope.allowedModificationScope.some((a) => pathMatch(norm, a))
    ) {
      findings.push({
        id: randomUUID(),
        severity: "error",
        kind: "scope_violation",
        message: `Path “${p}” is outside allowed modification scope.`,
        refs: [p]
      });
    }
  }
  return findings;
}

function checkTestEvidence(
  evidence: CourseworkEvidenceItem[],
  spec?: SpecExtractResult
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const needsTests =
    spec?.scoringPoints.some((s) => s.category === "test") ||
    spec?.deliveryFormat.formats.includes("test-records") ||
    spec?.functionalRequirements.some((r) => /测试|test/i.test(r.text));

  if (!needsTests) return findings;

  const testEv = evidence.filter(
    (e) =>
      !e.isPlaceholder &&
      (e.kind === "test_record" ||
        e.kind === "verification" ||
        (e.kind === "run_log" && e.verification?.allPassed !== undefined))
  );

  if (testEv.length === 0) {
    findings.push({
      id: randomUUID(),
      severity: "error",
      kind: "test_gap",
      message: "Assignment expects tests/verification but no real test records were attached.",
      refs: []
    });
    return findings;
  }

  for (const e of testEv) {
    if (e.verification && e.verification.allPassed === false) {
      findings.push({
        id: randomUUID(),
        severity: "error",
        kind: "test_gap",
        message: `Verification evidence “${e.title}” did not all pass.`,
        refs: [e.id]
      });
    }
    // Keyword-only pass without structured exit codes
    const claimPass =
      typeof e.metadata?.claimedPass === "boolean" ? e.metadata.claimedPass : undefined;
    const hasStructured =
      e.verification?.results?.some((r) => r.exitCode !== null && r.exitCode !== undefined) ||
      typeof e.metadata?.exitCode === "number";
    if (claimPass === true && !hasStructured && !e.verification) {
      findings.push({
        id: randomUUID(),
        severity: "error",
        kind: "test_gap",
        message: `“${e.title}” claims pass without structured exitCode/verification rows.`,
        refs: [e.id]
      });
    }
  }
  return findings;
}

/** Simple glob: ** / *, * , exact, prefix/ */
function pathMatch(path: string, pattern: string): boolean {
  const p = pattern.replace(/\\/g, "/");
  if (p === "**/*" || p === "**") return true;
  if (p.endsWith("/**")) {
    const prefix = p.slice(0, -3);
    return path === prefix || path.startsWith(prefix + "/");
  }
  if (p.includes("*")) {
    const re = new RegExp(
      "^" +
        p
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*") +
        "$"
    );
    return re.test(path);
  }
  return path === p || path.startsWith(p.endsWith("/") ? p : p + "/");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function consistencyOk(result: ConsistencyCheckResult): boolean {
  return result.ok;
}
