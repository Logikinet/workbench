import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CourseworkSession } from "./courseworkTypes.js";
import {
  buildDeliveryPackage,
  deliveryCompleteness,
  writeDeliveryPackage
} from "./deliveryPackage.js";

function baseSession(over: Partial<CourseworkSession> = {}): CourseworkSession {
  return {
    id: "cw-1",
    title: "LMS Coursework",
    goal: "Deliver LMS",
    status: "packaging",
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
        targets: [{ kind: "implementation_file", ref: "src/login.ts" }],
        covered: true
      }
    ],
    evidence: [
      {
        id: "e1",
        kind: "implementation",
        title: "Login",
        path: "src/login.ts",
        relatedScoringPointIds: ["sp-1"],
        relatedRequirementIds: [],
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "e2",
        kind: "screenshot",
        title: "Login screen",
        path: "shots/login.png",
        relatedScoringPointIds: ["sp-1"],
        relatedRequirementIds: [],
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "e3",
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
          summary: "命令验证 1/1 通过",
          allPassed: true,
          recordedAt: "2026-01-01T00:00:00.000Z"
        },
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
    },
    ...over
  };
}

describe("deliveryPackage", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("builds ZIP with readme, scoring map, evidence, manifest", () => {
    const { manifest, zipBytes, files } = buildDeliveryPackage({
      session: baseSession(),
      now: () => new Date("2026-04-06T12:00:00.000Z")
    });
    expect(zipBytes.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(manifest.projectRunnable).toBe(true);
    expect(manifest.screenshots.length).toBeGreaterThan(0);
    expect(manifest.testRecords.length).toBeGreaterThan(0);
    expect(files.some((f) => f.path === "README.md")).toBe(true);
    expect(files.some((f) => f.path === "SCORING_MAP.md")).toBe(true);
    expect(files.some((f) => f.path === "MANIFEST.json")).toBe(true);
    expect(manifest.zipContentHash).toMatch(/^[a-f0-9]{32}$/);

    const complete = deliveryCompleteness(baseSession(), manifest);
    expect(complete.ok).toBe(true);
  });

  it("writes package to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paw-cw-pkg-"));
    dirs.push(dir);
    const result = await writeDeliveryPackage({
      session: baseSession(),
      outputDir: dir,
      now: () => new Date("2026-04-06T12:00:00.000Z")
    });
    const readme = await readFile(join(dir, "README.md"), "utf8");
    expect(readme).toMatch(/LMS Coursework/);
    const zip = await readFile(join(dir, "delivery.zip"));
    expect(zip.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(result.manifest.zipPath).toContain("delivery.zip");
  });

  it("reports missing screenshots when required", () => {
    const session = baseSession({
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
      ]
    });
    const { manifest } = buildDeliveryPackage({ session });
    const complete = deliveryCompleteness(session, manifest);
    expect(complete.ok).toBe(false);
    expect(complete.missing).toContain("screenshots");
  });
});
