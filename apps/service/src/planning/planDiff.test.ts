import { describe, expect, it } from "vitest";
import { computePlanVersionDiff, isSubstantialPlanRevision } from "./planDiff.js";

describe("plan version diffs (task 19)", () => {
  it("records structural differences between plan versions", () => {
    const diff = computePlanVersionDiff(
      {
        version: 1,
        summary: "修复登录",
        steps: ["复现", "修复", "验证"],
        acceptanceCriteria: ["登录成功"],
        risks: ["会话风险"],
        expectedArtifacts: ["login fix"]
      },
      {
        version: 2,
        summary: "修复登录并补回归测试",
        steps: ["复现", "最小修复", "加测试", "验证"],
        acceptanceCriteria: ["登录成功", "回归测试通过"],
        risks: ["会话风险"],
        expectedArtifacts: ["login fix", "regression test"]
      }
    );

    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
    expect(diff.summaryChanged).toBe(true);
    expect(diff.stepsAdded).toEqual(expect.arrayContaining(["最小修复", "加测试"]));
    expect(diff.stepsRemoved).toContain("修复");
    expect(diff.acceptanceAdded).toContain("回归测试通过");
    expect(diff.expectedArtifactsAdded).toContain("regression test");
    expect(diff.changedFieldCount).toBeGreaterThan(0);
    expect(isSubstantialPlanRevision(diff)).toBe(true);
  });

  it("treats note-only identical plans as non-substantial", () => {
    const diff = computePlanVersionDiff(
      { version: 1, summary: "same", steps: ["a"], acceptanceCriteria: ["b"] },
      { version: 2, summary: "same", steps: ["a"], acceptanceCriteria: ["b"] }
    );
    expect(diff.changedFieldCount).toBe(0);
    expect(isSubstantialPlanRevision(diff)).toBe(false);
  });
});
