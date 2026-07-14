import { describe, expect, it } from "vitest";
import {
  answerAskUserRequest,
  criticalInputsToAskUser,
  enqueueAskUser,
  hasPendingAskUser,
  listActiveAskUser
} from "./askUserService.js";
import type { CreateAskUserInput } from "./askUserTypes.js";

const baseSource = { agent: "firstmate", stepKey: "planning.critical_input" };

function freeTextAsk(overrides: Partial<CreateAskUserInput> = {}): CreateAskUserInput {
  return {
    kind: "ask_user",
    prompt: "预期正式成果是什么？",
    reason: "缺少关键成果描述",
    inputMode: "free_text",
    required: true,
    source: baseSource,
    ...overrides
  };
}

describe("AskUser coordination (task 19)", () => {
  it("supports AskUser, AskApproval, and AskReplan as independent kinds", () => {
    const now = new Date().toISOString();
    let requests: ReturnType<typeof enqueueAskUser>["requests"] = [];

    const user = enqueueAskUser(requests, freeTextAsk(), now);
    requests = user.requests;
    expect(user.created.kind).toBe("ask_user");
    expect(user.created.status).toBe("pending");

    const approval = enqueueAskUser(requests, {
      kind: "ask_approval",
      prompt: "是否批准删除临时缓存？",
      reason: "危险操作需确认",
      inputMode: "single_select",
      options: [{ id: "yes", label: "批准" }, { id: "no", label: "拒绝" }],
      source: { agent: "professional_agent", stepKey: "execution.delete_cache" }
    }, now);
    requests = approval.requests;
    expect(approval.created.kind).toBe("ask_approval");
    expect(approval.created.status).toBe("queued");

    const replan = enqueueAskUser(requests, {
      kind: "ask_replan",
      prompt: "请说明计划需要如何修改",
      reason: "用户退回了计划",
      inputMode: "free_text",
      source: { agent: "secondmate", stepKey: "planning.replan" },
      forceQueue: true
    }, now);
    requests = replan.requests;
    expect(replan.created.kind).toBe("ask_replan");
    expect(replan.created.status).toBe("queued");
    expect(listActiveAskUser(requests)).toHaveLength(3);
  });

  it("validates free text, single select, multi select, and required fields", () => {
    const now = new Date().toISOString();
    const { requests, created } = enqueueAskUser([], {
      kind: "ask_user",
      prompt: "选择目标环境",
      reason: "部署目标未知",
      inputMode: "multi_select_with_text",
      options: [{ id: "dev", label: "开发" }, { id: "prod", label: "生产" }],
      required: true,
      recommendedAnswer: "dev",
      recommendationRationale: "默认先验证开发环境",
      source: baseSource
    }, now);

    expect(created.recommendedAnswer).toBe("dev");
    expect(() => answerAskUserRequest(requests, created.id, {}, now)).toThrow(/option|free-text|required/i);

    const answered = answerAskUserRequest(requests, created.id, {
      selectedOptionIds: ["dev"],
      freeText: "仅开发环境"
    }, now);
    expect(answered.result.request.status).toBe("answered");
    expect(answered.result.request.answer).toMatchObject({
      selectedOptionIds: ["dev"],
      freeText: "仅开发环境"
    });
    expect(answered.result.resumeStepKey).toBe("planning.critical_input");
  });

  it("merges similar Firstmate questions and queues the rest to avoid duplicate disturbance", () => {
    const now = new Date().toISOString();
    const first = enqueueAskUser([], freeTextAsk({ prompt: "请说明预期正式成果" }), now);
    const second = enqueueAskUser(first.requests, freeTextAsk({
      prompt: "请说明预期正式成果或可验证结果",
      reason: "专业代理也缺少成果描述",
      source: { agent: "professional_agent", stepKey: "planning.critical_input" }
    }), now);

    expect(second.mergedInto).toBeDefined();
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]?.mergedFrom).toContain(second.created.id);
    expect(second.requests[0]?.reason).toMatch(/关键|成果/);

    const different = enqueueAskUser(second.requests, freeTextAsk({
      prompt: "允许修改的目录范围是什么？",
      reason: "范围未确认",
      source: { agent: "secondmate", stepKey: "planning.scope" }
    }), now);
    expect(different.created.status).toBe("queued");
    expect(different.requests).toHaveLength(2);
  });

  it("promotes the next queued card after an answer", () => {
    const now = new Date().toISOString();
    const a = enqueueAskUser([], freeTextAsk({ prompt: "问题 A" }), now);
    const b = enqueueAskUser(a.requests, freeTextAsk({
      prompt: "问题 B",
      source: { agent: "firstmate", stepKey: "planning.other" },
      forceQueue: true
    }), now);

    const after = answerAskUserRequest(b.requests, a.created.id, { freeText: "回答 A" }, now);
    expect(after.result.request.status).toBe("answered");
    expect(after.result.nextPending?.id).toBe(b.created.id);
    expect(after.result.nextPending?.status).toBe("pending");
    expect(hasPendingAskUser(after.requests)).toBe(true);
  });

  it("returns replanFeedback for AskReplan answers", () => {
    const now = new Date().toISOString();
    const { requests, created } = enqueueAskUser([], {
      kind: "ask_replan",
      prompt: "如何修订计划？",
      reason: "用户退回",
      inputMode: "free_text",
      source: { agent: "secondmate", stepKey: "planning.replan" }
    }, now);

    const answered = answerAskUserRequest(requests, created.id, {
      freeText: "增加回归测试范围并收紧禁止项"
    }, now);
    expect(answered.result.replanFeedback).toContain("回归测试");
  });

  it("builds critical-input prompts from Firstmate gaps", () => {
    const card = criticalInputsToAskUser(["请说明预期正式成果。", "确认允许修改的路径。"]);
    expect(card.prompt).toMatch(/预期正式成果/);
    expect(card.reason).toMatch(/Firstmate/);
  });
});
