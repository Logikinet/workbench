import { describe, expect, it } from "vitest";
import type { CourseworkSession } from "./courseworkTypes.js";
import {
  mayArchiveComplete,
  reviewCourseworkRules,
  reviewMayAwaitUserAccept
} from "./noMistakesReview.js";
import { buildDeliveryPackage } from "./deliveryPackage.js";

function goodSession(): CourseworkSession {
  const session: CourseworkSession = {
    id: "cw-1",
    title: "LMS",
    goal: "Ship LMS",
    status: "reviewing",
    assignmentBrief: "brief",
    scopePolicy: {
      mode: "greenfield",
      retainedFeatures: [],
      allowedModificationScope: ["**/*"],
      forbiddenPaths: []
    },
    planSubtasks: [],
    planApproved: true,
    scoringMap: [
      {
        scoringPointId: "sp-1",
        targets: [
          { kind: "implementation_file", ref: "src/login.ts" },
          { kind: "run_evidence", ref: "e-v" }
        ],
        covered: true
      }
    ],
    evidence: [
      {
        id: "e-i",
        kind: "implementation",
        title: "Login",
        path: "src/login.ts",
        relatedScoringPointIds: ["sp-1"],
        relatedRequirementIds: [],
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "e-v",
        kind: "verification",
        title: "npm test",
        relatedScoringPointIds: ["sp-1"],
        relatedRequirementIds: [],
        verification: {
          kind: "project-verification",
          stackPrimary: "nodejs",
          results: [
            {
              command: ["npm", "test"],
              exitCode: 0,
              stdout: "ok",
              stderr: "",
              passed: true
            }
          ],
          manualChecklist: [],
          summary: "1/1",
          allPassed: true,
          recordedAt: "2026-01-01T00:00:00.000Z"
        },
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "e-s",
        kind: "screenshot",
        title: "Login UI",
        path: "shots/login.png",
        relatedScoringPointIds: ["sp-1"],
        relatedRequirementIds: [],
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    consistencyFindings: [],
    researchEvidence: [],
    userAccepted: false,
    artifacts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    spec: {
      functionalRequirements: [{ id: "req-1", text: "Login" }],
      scoringPoints: [
        { id: "sp-1", title: "Login", description: "Login", category: "function" }
      ],
      prohibitions: [],
      deliveryFormat: {
        formats: ["zip", "readme", "screenshots", "test-records", "runnable-project"]
      },
      missingCriticalInfo: [],
      rawSummary: "ok",
      extractedAt: "2026-01-01T00:00:00.000Z"
    }
  };
  const { manifest } = buildDeliveryPackage({ session });
  session.delivery = manifest;
  return session;
}

describe("noMistakesReview", () => {
  it("passes when scoring, authenticity, and delivery are solid", () => {
    const session = goodSession();
    const review = reviewCourseworkRules({ session, manifest: session.delivery });
    expect(review.scoringCoverageOk).toBe(true);
    expect(review.dataAuthenticityOk).toBe(true);
    expect(review.deliveryCompletenessOk).toBe(true);
    expect(review.featureRegressionOk).toBe(true);
    expect(review.conclusion).toBe("passed");
    expect(reviewMayAwaitUserAccept(review)).toBe(true);
    expect(mayArchiveComplete(session)).toBe(false); // no user accept yet
  });

  it("fails on placeholder / fake UI evidence", () => {
    const session = goodSession();
    session.evidence.push({
      id: "e-fake",
      kind: "screenshot",
      title: "Coming soon shell",
      path: "fake.png",
      relatedScoringPointIds: ["sp-1"],
      relatedRequirementIds: [],
      isPlaceholder: true,
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const review = reviewCourseworkRules({ session, manifest: session.delivery });
    expect(review.conclusion).toBe("changes_requested");
    expect(review.dataAuthenticityOk).toBe(false);
  });

  it("fails when scoring points lack strong coverage", () => {
    const session = goodSession();
    session.scoringMap = [
      {
        scoringPointId: "sp-1",
        targets: [{ kind: "report_chapter", ref: "ch1" }],
        covered: true
      }
    ];
    const review = reviewCourseworkRules({ session, manifest: session.delivery });
    expect(review.scoringCoverageOk).toBe(false);
    expect(review.conclusion).toBe("changes_requested");
  });

  it("allows archive only after user accept + passed review", () => {
    const session = goodSession();
    const review = reviewCourseworkRules({ session, manifest: session.delivery });
    session.review = review;
    session.userAccepted = true;
    session.userAcceptedAt = "2026-04-06T12:00:00.000Z";
    expect(mayArchiveComplete(session)).toBe(true);
  });

  it("requires retained features for minimal_modify", () => {
    const session = goodSession();
    session.scopePolicy = {
      mode: "minimal_modify",
      retainedFeatures: [],
      allowedModificationScope: ["src/**"],
      forbiddenPaths: []
    };
    const review = reviewCourseworkRules({ session, manifest: session.delivery });
    expect(review.featureRegressionOk).toBe(false);
    expect(review.conclusion).toBe("changes_requested");
  });
});
