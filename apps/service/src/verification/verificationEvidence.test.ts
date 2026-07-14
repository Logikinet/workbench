import { describe, expect, it } from "vitest";
import { buildVerificationEvidence, summarizeVerificationEvidence, toVerificationEvidenceRows } from "./verificationEvidence.js";

describe("verification evidence", () => {
  it("structures command results with explicit passed flags from exitCode", () => {
    const rows = toVerificationEvidenceRows([
      { command: ["pytest"], exitCode: 0, stdout: "ok", stderr: "" },
      { command: ["npm", "test"], exitCode: 1, stdout: "", stderr: "fail" }
    ]);
    expect(rows).toEqual([
      { command: ["pytest"], exitCode: 0, stdout: "ok", stderr: "", passed: true },
      { command: ["npm", "test"], exitCode: 1, stdout: "", stderr: "fail", passed: false }
    ]);
  });

  it("builds Reviewer-ready evidence bundles", () => {
    const evidence = buildVerificationEvidence({
      stackPrimary: "python",
      planVersion: 3,
      results: [{ command: ["pytest"], exitCode: 0, stdout: "1 passed", stderr: "" }],
      manualChecklist: [{ id: "m1", description: "核对报告", source: "hypothesis", rationale: "x", completed: true }],
      recordedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(evidence.kind).toBe("project-verification");
    expect(evidence.planVersion).toBe(3);
    expect(evidence.stackPrimary).toBe("python");
    expect(evidence.results[0]?.passed).toBe(true);
    expect(evidence.allPassed).toBe(true);
    expect(evidence.summary).toMatch(/1\/1/);
    expect(evidence.recordedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("fails the bundle when any command exitCode is non-zero", () => {
    const evidence = buildVerificationEvidence({
      stackPrimary: "nodejs",
      results: [
        { command: ["npm", "test"], exitCode: 0, stdout: "ok", stderr: "" },
        { command: ["npm", "run", "typecheck"], exitCode: 2, stdout: "", stderr: "err" }
      ]
    });
    expect(evidence.allPassed).toBe(false);
    expect(evidence.results.filter((row) => row.passed)).toHaveLength(1);
  });

  it("summarizes empty results without claiming pass keywords", () => {
    expect(summarizeVerificationEvidence([])).toMatch(/无自动化/);
  });
});
