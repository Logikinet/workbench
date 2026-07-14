import { describe, expect, it } from "vitest";
import type {
  CourseworkEvidenceItem,
  ProjectScopePolicy,
  ScoringPointMapping
} from "./courseworkTypes.js";
import {
  checkConsistency,
  detectFakeUiText
} from "./consistencyGates.js";
import { buildVerificationEvidence } from "../verification/verificationEvidence.js";

describe("consistencyGates", () => {
  const scope: ProjectScopePolicy = {
    mode: "minimal_modify",
    retainedFeatures: ["auth"],
    allowedModificationScope: ["src/**", "tests/**"],
    forbiddenPaths: ["vendor/**"]
  };

  const scoringMap: ScoringPointMapping[] = [
    {
      scoringPointId: "sp-1",
      targets: [{ kind: "implementation_file", ref: "src/login.ts" }],
      covered: true
    }
  ];

  it("detects fake UI phrases", () => {
    const hits = detectFakeUiText("功能开发中 placeholder");
    expect(hits.some((h) => /placeholder/i.test(h))).toBe(true);
    expect(detectFakeUiText("空壳界面")).not.toHaveLength(0);
    expect(detectFakeUiText("Login works with real JWT")).toHaveLength(0);
  });

  it("flags placeholder evidence and uncovered scoring", () => {
    const evidence: CourseworkEvidenceItem[] = [
      {
        id: "e-fake",
        kind: "screenshot",
        title: "Shell only UI",
        path: "shell.png",
        relatedScoringPointIds: ["sp-1"],
        relatedRequirementIds: [],
        isPlaceholder: true,
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ];
    const result = checkConsistency({
      scoringMap: [
        {
          scoringPointId: "sp-1",
          targets: [{ kind: "screenshot", ref: "shell.png" }],
          covered: true
        },
        { scoringPointId: "sp-2", targets: [], covered: false }
      ],
      evidence,
      scopePolicy: scope,
      requireStrongCoverage: true
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.kind === "fake_ui")).toBe(true);
    expect(result.findings.some((f) => f.kind === "scoring_uncovered")).toBe(true);
  });

  it("flags out-of-scope path changes", () => {
    const result = checkConsistency({
      scoringMap,
      evidence: [],
      scopePolicy: scope,
      changedPaths: ["vendor/lib.js", "src/ok.ts"]
    });
    expect(result.findings.some((f) => f.message.includes("vendor"))).toBe(true);
    expect(result.findings.filter((f) => f.refs?.includes("src/ok.ts"))).toHaveLength(0);
  });

  it("requires structured test evidence when tests are expected", () => {
    const result = checkConsistency({
      spec: {
        functionalRequirements: [],
        scoringPoints: [
          { id: "sp-t", title: "Tests", description: "Unit tests", category: "test" }
        ],
        prohibitions: [],
        deliveryFormat: { formats: ["test-records"] },
        missingCriticalInfo: [],
        rawSummary: "",
        extractedAt: "2026-01-01T00:00:00.000Z"
      },
      scoringMap: [
        {
          scoringPointId: "sp-t",
          targets: [{ kind: "test_record", ref: "e-t" }],
          covered: true
        }
      ],
      evidence: [
        {
          id: "e-t",
          kind: "test_record",
          title: "Claimed pass",
          relatedScoringPointIds: ["sp-t"],
          relatedRequirementIds: [],
          metadata: { claimedPass: true },
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      scopePolicy: { mode: "greenfield", retainedFeatures: [], allowedModificationScope: ["**/*"], forbiddenPaths: [] },
      requireStrongCoverage: true
    });
    expect(result.findings.some((f) => f.kind === "test_gap")).toBe(true);
  });

  it("accepts structured verification evidence", () => {
    const verification = buildVerificationEvidence({
      results: [{ command: ["npm", "test"], exitCode: 0, stdout: "ok", stderr: "" }],
      stackPrimary: "nodejs"
    });
    const result = checkConsistency({
      spec: {
        functionalRequirements: [],
        scoringPoints: [
          { id: "sp-t", title: "Tests", description: "Unit tests", category: "test" }
        ],
        prohibitions: [],
        deliveryFormat: { formats: ["test-records"] },
        missingCriticalInfo: [],
        rawSummary: "",
        extractedAt: "2026-01-01T00:00:00.000Z"
      },
      scoringMap: [
        {
          scoringPointId: "sp-t",
          targets: [{ kind: "run_evidence", ref: "e-v" }],
          covered: true
        }
      ],
      evidence: [
        {
          id: "e-v",
          kind: "verification",
          title: "npm test",
          relatedScoringPointIds: ["sp-t"],
          relatedRequirementIds: [],
          verification,
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      scopePolicy: {
        mode: "greenfield",
        retainedFeatures: [],
        allowedModificationScope: ["**/*"],
        forbiddenPaths: []
      },
      requireStrongCoverage: true
    });
    expect(result.findings.filter((f) => f.kind === "test_gap" && f.severity === "error")).toHaveLength(
      0
    );
  });

  it("flags report claims without bound evidence", () => {
    const result = checkConsistency({
      scoringMap,
      evidence: [
        {
          id: "e1",
          kind: "implementation",
          title: "Login",
          path: "src/login.ts",
          relatedScoringPointIds: ["sp-1"],
          relatedRequirementIds: [],
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      scopePolicy: {
        mode: "greenfield",
        retainedFeatures: [],
        allowedModificationScope: ["**/*"],
        forbiddenPaths: []
      },
      reportClaims: [
        {
          id: "c1",
          text: "作业提交已完整实现",
          relatedIds: ["sp-missing"]
        }
      ]
    });
    expect(result.findings.some((f) => f.kind === "report_mismatch")).toBe(true);
  });
});
