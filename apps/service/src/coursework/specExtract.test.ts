import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../model/fakeProvider.js";
import {
  allCriticalInfoResolved,
  extractSpec,
  extractSpecHeuristic,
  mergeSpecExtract,
  parseSpecModelOutput,
  resolveMissingInfo,
  SpecExtractError
} from "./specExtract.js";

const SAMPLE_BRIEF = `
综合课程设计任务书

一、功能要求
1. 实现用户登录与注册
2. 实现课程列表与详情
3. 实现作业提交功能

二、评分标准
1. 登录注册功能 20分
2. 课程管理 25分
3. 作业提交 20分
4. 代码规范 15分
5. 测试与文档 20分

三、禁止项
1. 禁止抄袭他人代码
2. 不得使用空壳界面冒充功能完成

四、交付格式
提交可运行项目源码、ZIP压缩包、README运行说明、测试记录与截图、课程报告PDF。
`;

describe("specExtract", () => {
  const now = () => new Date("2026-04-06T12:00:00.000Z");

  it("extracts requirements, scoring points, prohibitions, delivery from heuristic", () => {
    const spec = extractSpecHeuristic(SAMPLE_BRIEF, { now });
    expect(spec.functionalRequirements.length).toBeGreaterThanOrEqual(3);
    expect(spec.scoringPoints.length).toBeGreaterThanOrEqual(4);
    expect(spec.scoringPoints.some((s) => s.maxScore === 20)).toBe(true);
    expect(spec.prohibitions.some((p) => /空壳|抄袭/.test(p.text))).toBe(true);
    expect(spec.deliveryFormat.formats).toEqual(
      expect.arrayContaining(["zip", "source", "readme", "screenshots", "test-records"])
    );
    expect(spec.extractedAt).toBe("2026-04-06T12:00:00.000Z");
  });

  it("flags missing critical info when deadline/stack absent", () => {
    const spec = extractSpecHeuristic("功能：做一个计算器。", { now });
    expect(spec.missingCriticalInfo.length).toBeGreaterThan(0);
    expect(spec.missingCriticalInfo.some((m) => /deadline|截止/i.test(m.question))).toBe(true);
  });

  it("throws on empty brief", () => {
    expect(() => extractSpecHeuristic("  ", { now })).toThrow(SpecExtractError);
  });

  it("merges model enrichment over heuristic base", async () => {
    const model = new FakeModelProvider({
      successContent: JSON.stringify({
        functionalRequirements: [{ text: "Must support offline mode" }],
        scoringPoints: [
          { title: "Offline", description: "Works offline", maxScore: 30, category: "function" }
        ],
        prohibitions: [{ text: "No network-only features" }],
        deliveryFormats: ["zip", "report"],
        missingCriticalInfo: [{ question: "Demo hardware?", reason: "Not stated" }],
        summary: "Model summary"
      })
    });
    const spec = await extractSpec({
      assignmentBrief: SAMPLE_BRIEF,
      model,
      now
    });
    expect(spec.functionalRequirements[0]!.text).toMatch(/offline/i);
    expect(spec.scoringPoints).toHaveLength(1);
    expect(spec.rawSummary).toBe("Model summary");
  });

  it("falls back to heuristic when model returns garbage", async () => {
    const model = new FakeModelProvider({ successContent: "not-json-at-all" });
    const spec = await extractSpec({ assignmentBrief: SAMPLE_BRIEF, model, now });
    expect(spec.scoringPoints.length).toBeGreaterThan(0);
  });

  it("parses model output and resolves missing info", () => {
    const parsed = parseSpecModelOutput(
      'prefix {"functionalRequirements":[{"text":"A"}],"scoringPoints":[]} suffix'
    );
    expect(parsed.functionalRequirements?.[0]?.text).toBe("A");

    const base = extractSpecHeuristic(SAMPLE_BRIEF, { now });
    const merged = mergeSpecExtract(base, parsed, now);
    expect(merged.functionalRequirements[0]!.text).toBe("A");

    const id = base.missingCriticalInfo[0]?.id;
    if (id) {
      const resolved = resolveMissingInfo(base.missingCriticalInfo, id, "2026-06-01");
      expect(resolved.find((m) => m.id === id)!.resolved).toBe(true);
      expect(allCriticalInfoResolved(resolved)).toBe(
        resolved.every((m) => m.resolved)
      );
    }
  });

  it("detects minimal-modify missing scope when project notes exist", () => {
    const spec = extractSpecHeuristic(SAMPLE_BRIEF, {
      existingProjectNotes: "Legacy LMS monorepo with auth module.",
      now
    });
    expect(
      spec.missingCriticalInfo.some((m) => /retain|修改|retained/i.test(m.question))
    ).toBe(true);
  });
});
