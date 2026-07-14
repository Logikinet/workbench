import type {
  ManualChecklistEvidence,
  ManualChecklistItem,
  ProjectStackKind,
  VerificationEvidence,
  VerificationEvidenceRow,
  VerificationResultRow
} from "./types.js";

/**
 * Map raw command results into structured Evidence for Reviewer / Artifacts.
 * Uses explicit `passed` (exitCode === 0) — never scrape logs for keywords.
 */
export function toVerificationEvidenceRows(results: VerificationResultRow[]): VerificationEvidenceRow[] {
  return results.map((result) => ({
    command: [...result.command],
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    passed: result.exitCode === 0
  }));
}

export function buildVerificationEvidence(input: {
  results: VerificationResultRow[];
  stackPrimary: ProjectStackKind;
  planVersion?: number;
  manualChecklist?: ManualChecklistItem[];
  recordedAt?: string;
}): VerificationEvidence {
  const results = toVerificationEvidenceRows(input.results);
  const manualChecklist: ManualChecklistEvidence[] = (input.manualChecklist ?? []).map((item) => ({
    id: item.id,
    description: item.description,
    completed: item.completed === true,
    note: undefined
  }));

  const commandPass = results.length === 0 ? true : results.every((row) => row.passed);
  const manualPass = manualChecklist.length === 0 ? true : manualChecklist.every((item) => item.completed);
  // When only manual checklist exists (no commands), allPassed reflects checklist completion.
  // When commands exist, they must all pass; incomplete manual items fail the bundle.
  const allPassed =
    (results.length > 0 ? commandPass : manualChecklist.length > 0 ? manualPass : false)
    && (manualChecklist.length === 0 || manualPass);

  const summary = summarizeVerificationEvidence(results, manualChecklist);

  return {
    kind: "project-verification",
    planVersion: input.planVersion,
    stackPrimary: input.stackPrimary,
    results,
    manualChecklist,
    summary,
    allPassed: results.length === 0 && manualChecklist.length === 0 ? false : allPassed,
    recordedAt: input.recordedAt ?? new Date().toISOString()
  };
}

export function summarizeVerificationEvidence(
  results: VerificationEvidenceRow[],
  manualChecklist: ManualChecklistEvidence[] = []
): string {
  const parts: string[] = [];
  if (results.length > 0) {
    const passed = results.filter((row) => row.passed).length;
    parts.push(`命令验证 ${passed}/${results.length} 通过（exitCode 结构化）`);
  } else {
    parts.push("无自动化验证命令结果");
  }
  if (manualChecklist.length > 0) {
    const done = manualChecklist.filter((item) => item.completed).length;
    parts.push(`手工检查 ${done}/${manualChecklist.length} 完成`);
  }
  return parts.join("；");
}
