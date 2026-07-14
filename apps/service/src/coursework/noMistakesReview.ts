/**
 * /no-mistakes comprehensive review for coursework:
 * scoring coverage, feature regression, data authenticity, delivery completeness.
 */

import type { ModelProvider } from "../model/types.js";
import type {
  ConsistencyFinding,
  CourseworkSession,
  DeliveryPackageManifest,
  NoMistakesFinding,
  NoMistakesReviewResult,
  ReviewSeverity
} from "./courseworkTypes.js";
import { checkSessionConsistency, type ReportClaim } from "./consistencyGates.js";
import { deliveryCompleteness } from "./deliveryPackage.js";
import { evaluateScoringCoverage, hasStrongCoverage } from "./scoringMap.js";

export class NoMistakesReviewError extends Error {
  constructor(
    message: string,
    readonly code: "not_ready" | "model_failed" | "invalid_output"
  ) {
    super(message);
    this.name = "NoMistakesReviewError";
  }
}

export interface NoMistakesReviewInput {
  session: CourseworkSession;
  manifest?: DeliveryPackageManifest;
  reportClaims?: ReportClaim[];
  changedPaths?: string[];
  /** Prior consistency findings to fold in. */
  consistencyFindings?: ConsistencyFinding[];
  model?: ModelProvider;
  connectionId?: string;
  modelId?: string;
  now?: () => Date;
  signal?: AbortSignal;
}

const REVIEW_SYSTEM = `You are the Independent Reviewer for coursework delivery (/no-mistakes).
Evaluate: scoring-point coverage, feature regression vs retained features, data authenticity
(no fake UI / invented test pass), and delivery package completeness.
Return JSON: {
  conclusion: "passed"|"changes_requested",
  summary: string,
  findings: [{ criterion, met, evidence, severity, fixScope? }],
  residualRisks: string[]
}
Never mark passed if any scoring point lacks real evidence or delivery is incomplete.
User final acceptance is separate — do not claim archival complete.`;

/** Pure rules-based /no-mistakes review (always runs). */
export function reviewCourseworkRules(input: NoMistakesReviewInput): NoMistakesReviewResult {
  const now = input.now ?? (() => new Date());
  const session = input.session;
  const findings: NoMistakesFinding[] = [];
  const residualRisks: string[] = [];

  // 1) Scoring coverage
  const coverage = evaluateScoringCoverage(session.scoringMap, { requireStrong: true });
  const scoringCoverageOk =
    session.scoringMap.length > 0 &&
    coverage.uncoveredIds.length === 0 &&
    session.scoringMap.every((m) => hasStrongCoverage(m));

  if (session.scoringMap.length === 0) {
    findings.push({
      criterion: "Scoring map present",
      met: false,
      evidence: "No scoring points mapped.",
      severity: "critical"
    });
  }
  for (const id of coverage.uncoveredIds) {
    const sp = session.spec?.scoringPoints.find((s) => s.id === id);
    findings.push({
      criterion: `Scoring coverage: ${sp?.title ?? id}`,
      met: false,
      evidence: "Missing implementation file, run evidence, or test record mapping.",
      severity: "high",
      fixScope: "Add real evidence and update scoring map"
    });
  }
  if (scoringCoverageOk) {
    findings.push({
      criterion: "Scoring-point coverage (strong)",
      met: true,
      evidence: `${session.scoringMap.length} points mapped to impl/run/test evidence.`,
      severity: "none"
    });
  }

  // 2) Consistency / fake UI / authenticity
  const consistency = checkSessionConsistency(session, {
    reportClaims: input.reportClaims,
    changedPaths: input.changedPaths,
    requireStrongCoverage: true
  });
  const extraFindings = input.consistencyFindings ?? [];
  const allConsistency = [...consistency.findings, ...extraFindings];

  const fakeUi = allConsistency.filter((f) => f.kind === "fake_ui");
  const dataAuthenticityOk = fakeUi.length === 0 && !allConsistency.some(
    (f) => f.kind === "test_gap" && f.severity === "error"
  );

  if (fakeUi.length > 0) {
    for (const f of fakeUi) {
      findings.push({
        criterion: "No fake/shell UI as completed work",
        met: false,
        evidence: f.message,
        severity: "critical",
        fixScope: "Replace placeholders with real implementation and evidence"
      });
    }
  } else {
    findings.push({
      criterion: "No fake/shell UI as completed work",
      met: true,
      evidence: "No placeholder or fake-UI signals in evidence.",
      severity: "none"
    });
  }

  const testGaps = allConsistency.filter((f) => f.kind === "test_gap");
  for (const f of testGaps) {
    findings.push({
      criterion: "Data authenticity — tests",
      met: f.severity !== "error",
      evidence: f.message,
      severity: f.severity === "error" ? "high" : "low"
    });
  }

  // Placeholder evidence counting as coverage already handled; double-check
  const placeholderUsed = session.evidence.some((e) => e.isPlaceholder);
  if (placeholderUsed) {
    findings.push({
      criterion: "Data authenticity — evidence purity",
      met: false,
      evidence: "Session still contains placeholder evidence items.",
      severity: "high"
    });
  }

  // 3) Feature regression / scope
  const scopeErrors = allConsistency.filter((f) => f.kind === "scope_violation");
  const retainedOk =
    session.scopePolicy.mode === "greenfield" ||
    (session.scopePolicy.retainedFeatures.length >= 0 && scopeErrors.length === 0);
  // For minimal_modify, require retained features listed
  let featureRegressionOk = scopeErrors.length === 0;
  if (session.scopePolicy.mode === "minimal_modify") {
    if (session.scopePolicy.retainedFeatures.length === 0) {
      residualRisks.push("Minimal-modify mode without explicit retained feature list.");
      findings.push({
        criterion: "Feature regression — retained features listed",
        met: false,
        evidence: "No retained features declared for existing project.",
        severity: "medium",
        fixScope: "Declare retained features in scope policy"
      });
      featureRegressionOk = false;
    } else {
      findings.push({
        criterion: "Feature regression — retained features listed",
        met: true,
        evidence: session.scopePolicy.retainedFeatures.join("; "),
        severity: "none"
      });
    }
  } else {
    findings.push({
      criterion: "Feature regression — greenfield",
      met: true,
      evidence: "Greenfield project; no retained baseline.",
      severity: "none"
    });
  }
  for (const f of scopeErrors) {
    findings.push({
      criterion: "Feature regression — modification scope",
      met: false,
      evidence: f.message,
      severity: "high",
      fixScope: "Revert out-of-scope changes"
    });
  }
  void retainedOk;

  // 4) Delivery completeness
  const manifest = input.manifest ?? session.delivery;
  let deliveryCompletenessOk = false;
  if (!manifest) {
    findings.push({
      criterion: "Delivery package completeness",
      met: false,
      evidence: "No delivery package/manifest built yet.",
      severity: "high",
      fixScope: "Build ZIP delivery package"
    });
  } else {
    const complete = deliveryCompleteness(session, manifest);
    deliveryCompletenessOk = complete.ok;
    findings.push({
      criterion: "Delivery package completeness",
      met: complete.ok,
      evidence: complete.ok
        ? `ZIP entries: ${manifest.entries.length}; runnable=${manifest.projectRunnable}`
        : `Missing: ${complete.missing.join(", ")}`,
      severity: complete.ok ? "none" : "high",
      fixScope: complete.ok ? undefined : `Add: ${complete.missing.join(", ")}`
    });
  }

  // 5) User accept is NOT automatic
  findings.push({
    criterion: "User final acceptance required before archive",
    met: session.userAccepted === true,
    evidence: session.userAccepted
      ? `Accepted at ${session.userAcceptedAt}`
      : "User has not accepted yet — archive must wait.",
    severity: session.userAccepted ? "none" : "medium"
  });
  // Note: user accept is required for "completed" status but review can pass
  // technical gates without accept — conclusion ignores accept for pass/fail of review.

  const blocking = findings.filter(
    (f) =>
      !f.met &&
      f.severity !== "none" &&
      f.severity !== "low" &&
      f.criterion !== "User final acceptance required before archive"
  );

  // medium-only on retained features still blocks when featureRegressionOk false
  const conclusion: "passed" | "changes_requested" =
    scoringCoverageOk &&
    dataAuthenticityOk &&
    featureRegressionOk &&
    deliveryCompletenessOk &&
    blocking.length === 0
      ? "passed"
      : "changes_requested";

  if (!session.userAccepted) {
    residualRisks.push("Awaiting user final acceptance before archive/complete.");
  }
  if (session.spec?.missingCriticalInfo.some((m) => !m.resolved)) {
    residualRisks.push("Unresolved missing critical info from assignment brief.");
  }

  const summary =
    conclusion === "passed"
      ? "Coursework technical gates passed: scoring coverage, authenticity, scope, and delivery look complete. User acceptance still required to archive."
      : `Coursework /no-mistakes requested changes (${blocking.length} blocking findings).`;

  return {
    conclusion,
    summary,
    scoringCoverageOk,
    featureRegressionOk,
    dataAuthenticityOk,
    deliveryCompletenessOk,
    findings,
    residualRisks,
    reviewedAt: now().toISOString(),
    reviewSource: "rules"
  };
}

export async function reviewCoursework(
  input: NoMistakesReviewInput
): Promise<NoMistakesReviewResult> {
  const rules = reviewCourseworkRules(input);
  if (!input.model) return rules;

  try {
    const response = await input.model.complete({
      connectionId: input.connectionId ?? "fake-connection",
      modelId: input.modelId ?? "fake-model",
      messages: [
        { role: "system", content: REVIEW_SYSTEM },
        { role: "user", content: buildReviewContextPack(input, rules) }
      ],
      signal: input.signal
    });
    const modelPart = parseReviewModelOutput(response.content);
    return mergeReview(rules, modelPart, input.now ?? (() => new Date()));
  } catch {
    return rules;
  }
}

export function buildReviewContextPack(
  input: NoMistakesReviewInput,
  rules: NoMistakesReviewResult
): string {
  const s = input.session;
  return [
    `# Coursework review: ${s.title}`,
    `Goal: ${s.goal}`,
    `Status: ${s.status}`,
    "",
    "## Rules pre-check",
    JSON.stringify(
      {
        conclusion: rules.conclusion,
        scoringCoverageOk: rules.scoringCoverageOk,
        featureRegressionOk: rules.featureRegressionOk,
        dataAuthenticityOk: rules.dataAuthenticityOk,
        deliveryCompletenessOk: rules.deliveryCompletenessOk,
        findings: rules.findings
      },
      null,
      2
    ),
    "",
    "## Scoring map",
    JSON.stringify(s.scoringMap, null, 2),
    "",
    "## Evidence (non-placeholder titles)",
    ...s.evidence.filter((e) => !e.isPlaceholder).map((e) => `- ${e.kind}: ${e.title}`),
    "",
    "## Scope",
    JSON.stringify(s.scopePolicy, null, 2),
    "",
    "Confirm or strengthen the rules pre-check. Never pass if rules failed."
  ].join("\n");
}

export function parseReviewModelOutput(content: string): {
  conclusion?: "passed" | "changes_requested";
  summary?: string;
  findings?: NoMistakesFinding[];
  residualRisks?: string[];
} {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonObject(content.trim()));
  } catch {
    throw new NoMistakesReviewError("Review model returned non-JSON.", "invalid_output");
  }
  if (!raw || typeof raw !== "object") {
    throw new NoMistakesReviewError("Review model output is not an object.", "invalid_output");
  }
  return raw as {
    conclusion?: "passed" | "changes_requested";
    summary?: string;
    findings?: NoMistakesFinding[];
    residualRisks?: string[];
  };
}

/**
 * Model may only tighten (never loosen) a rules failure.
 * If rules passed, model may still request changes.
 */
export function mergeReview(
  rules: NoMistakesReviewResult,
  model: {
    conclusion?: "passed" | "changes_requested";
    summary?: string;
    findings?: NoMistakesFinding[];
    residualRisks?: string[];
  },
  now: () => Date
): NoMistakesReviewResult {
  const modelConclusion = model.conclusion;
  let conclusion = rules.conclusion;
  if (rules.conclusion === "passed" && modelConclusion === "changes_requested") {
    conclusion = "changes_requested";
  }
  // rules changes_requested always wins
  if (rules.conclusion === "changes_requested") {
    conclusion = "changes_requested";
  }

  const findings = [
    ...rules.findings,
    ...(model.findings ?? []).map((f) => ({
      criterion: f.criterion,
      met: f.met,
      evidence: f.evidence,
      severity: normalizeSeverity(f.severity),
      fixScope: f.fixScope
    }))
  ];

  return {
    ...rules,
    conclusion,
    summary: model.summary?.trim() || rules.summary,
    findings,
    residualRisks: [
      ...rules.residualRisks,
      ...(model.residualRisks ?? []).map((r) => r.trim()).filter(Boolean)
    ],
    reviewedAt: now().toISOString(),
    reviewSource: "rules+model"
  };
}

/** Whether the session may move to awaiting_user_accept. */
export function reviewMayAwaitUserAccept(review: NoMistakesReviewResult): boolean {
  return (
    review.conclusion === "passed" &&
    review.scoringCoverageOk &&
    review.dataAuthenticityOk &&
    review.featureRegressionOk &&
    review.deliveryCompletenessOk
  );
}

/** Archive/complete only after user accept + passed review. */
export function mayArchiveComplete(
  session: Pick<CourseworkSession, "userAccepted" | "review">
): boolean {
  return (
    session.userAccepted === true &&
    session.review?.conclusion === "passed" &&
    reviewMayAwaitUserAccept(session.review)
  );
}

function normalizeSeverity(s: string | undefined): ReviewSeverity {
  const allowed: ReviewSeverity[] = ["none", "low", "medium", "high", "critical"];
  if (s && (allowed as string[]).includes(s)) return s as ReviewSeverity;
  return "medium";
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}
