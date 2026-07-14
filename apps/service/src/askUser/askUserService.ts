/**
 * Run-scoped AskUser orchestration helpers used by RunService.
 * Coordination pure logic lives in askUserCoordination.ts.
 */

export {
  answerAskUserRequest,
  createAskUserRequest,
  enqueueAskUser,
  hasPendingAskUser,
  listActiveAskUser
} from "./askUserCoordination.js";

export type {
  AnswerAskUserInput,
  AskUserAnswer,
  AskUserAnswerResult,
  AskUserInputMode,
  AskUserKind,
  AskUserOption,
  AskUserRequest,
  AskUserSource,
  AskUserStatus,
  CreateAskUserInput
} from "./askUserTypes.js";

export { askUserInputModes, askUserKinds, askUserStatuses } from "./askUserTypes.js";

/** Build a free-text critical-input card from Firstmate criticalInputs. */
export function criticalInputsToAskUser(criticalInputs: string[]): {
  prompt: string;
  reason: string;
  recommendedAnswer?: string;
  recommendationRationale?: string;
} {
  const items = criticalInputs.map((item) => item.trim()).filter(Boolean);
  return {
    prompt: items.length === 1
      ? items[0]!
      : `请补充以下关键输入：\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    reason: "Firstmate 在继续规划前需要这些关键输入；缺少它们无法生成可信计划。",
    recommendedAnswer: items.length === 1 ? undefined : "请逐项说明预期成果、范围与可验证标准。",
    recommendationRationale: "完整说明可减少后续退回与重规划。"
  };
}
