import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../model/fakeProvider.js";
import type { SpecExtractResult } from "./courseworkTypes.js";
import {
  buildHeuristicPlan,
  planCoursework,
  toCreateDagFields
} from "./planCoursework.js";

const spec: SpecExtractResult = {
  functionalRequirements: [
    { id: "req-1", text: "User login" },
    { id: "req-2", text: "Course list" }
  ],
  scoringPoints: [
    { id: "sp-1", title: "Login", description: "Login", maxScore: 20, category: "function" },
    { id: "sp-2", title: "Tests", description: "Tests", maxScore: 20, category: "test" }
  ],
  prohibitions: [{ id: "proh-1", text: "No fake UI" }],
  deliveryFormat: { formats: ["zip", "screenshots", "report", "readme"] },
  missingCriticalInfo: [],
  rawSummary: "ok",
  extractedAt: "2026-04-06T12:00:00.000Z"
};

describe("planCoursework", () => {
  it("builds dependent research→dev→test→materials→docs chain", () => {
    const plan = buildHeuristicPlan({
      title: "LMS coursework",
      goal: "Deliver LMS demo",
      spec
    });
    expect(plan.subtasks.length).toBe(5);
    expect(plan.scopePolicy.mode).toBe("greenfield");
    const byId = new Map(plan.subtasks.map((s) => [s.id, s]));
    expect(byId.get("cw-develop")!.dependsOn).toContain("cw-research");
    expect(byId.get("cw-test")!.dependsOn).toContain("cw-develop");
    expect(byId.get("cw-docs")!.dependsOn).toContain("cw-materials");
    expect(byId.get("cw-research")!.accessMode).toBe("read_only");
    expect(byId.get("cw-develop")!.accessMode).toBe("write");
    expect(byId.get("cw-develop")!.acceptanceCriteria!.some((a) => /fake/i.test(a))).toBe(
      true
    );
    expect(byId.get("cw-develop")!.acceptanceCriteria!.some((a) => /No fake UI/.test(a))).toBe(
      true
    );
  });

  it("uses minimal_modify when existing project notes present", () => {
    const plan = buildHeuristicPlan({
      title: "LMS",
      goal: "Extend LMS",
      spec,
      existingProjectNotes: [
        "保留: 现有登录模块",
        "允许修改: src/courses/**"
      ].join("\n")
    });
    expect(plan.scopePolicy.mode).toBe("minimal_modify");
    expect(plan.scopePolicy.retainedFeatures.some((f) => /登录/.test(f))).toBe(true);
    expect(plan.scopePolicy.allowedModificationScope.some((a) => /courses/.test(a))).toBe(
      true
    );
    expect(
      plan.subtasks
        .find((s) => s.id === "cw-develop")!
        .acceptanceCriteria!.some((a) => /Retained|保留|scope/i.test(a))
    ).toBe(true);
  });

  it("merges model plan subtasks and exposes DAG fields", async () => {
    const model = new FakeModelProvider({
      successContent: JSON.stringify({
        subtasks: [
          { id: "r1", title: "Research stack", kind: "research" },
          {
            id: "d1",
            title: "Implement features",
            kind: "development",
            dependsOn: ["r1"],
            acceptanceCriteria: ["Login works"]
          },
          { id: "t1", title: "Test", kind: "testing", dependsOn: ["d1"] }
        ],
        scopePolicy: {
          mode: "minimal_modify",
          retainedFeatures: ["auth"],
          allowedModificationScope: ["src/**"]
        }
      })
    });
    const plan = await planCoursework({
      title: "LMS",
      goal: "Ship",
      spec,
      existingProjectNotes: "legacy",
      model
    });
    expect(plan.subtasks).toHaveLength(3);
    expect(plan.scopePolicy.retainedFeatures).toContain("auth");
    const fields = toCreateDagFields(plan);
    expect(fields.explicitSubtasks).toHaveLength(3);
    expect(fields.allowedScope).toContain("src/**");
    expect(fields.acceptanceCriteria.length).toBeGreaterThan(0);
  });
});
