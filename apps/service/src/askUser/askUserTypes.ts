/**
 * Structured AskUser / AskApproval / AskReplan cards (Task 19).
 * Persisted on Run state so unanswered prompts survive service restart.
 */

export const askUserKinds = ["ask_user", "ask_approval", "ask_replan"] as const;
export type AskUserKind = (typeof askUserKinds)[number];

export const askUserInputModes = [
  "single_select",
  "multi_select",
  "free_text",
  "single_select_with_text",
  "multi_select_with_text"
] as const;
export type AskUserInputMode = (typeof askUserInputModes)[number];

export const askUserStatuses = ["pending", "queued", "answered", "cancelled", "superseded"] as const;
export type AskUserStatus = (typeof askUserStatuses)[number];

export interface AskUserOption {
  id: string;
  label: string;
}

export interface AskUserSource {
  /** firstmate | secondmate | professional_agent | system | custom */
  agent: string;
  /** Resume key — after answer, orchestration continues from this step. */
  stepKey: string;
  roleId?: string;
  label?: string;
}

export interface AskUserAnswer {
  selectedOptionIds?: string[];
  freeText?: string;
  /** AskApproval: true = approved, false = rejected */
  approved?: boolean;
  /** AskReplan: structured feedback text (mirrors freeText when present) */
  replanFeedback?: string;
}

export interface AskUserRequest {
  id: string;
  kind: AskUserKind;
  status: AskUserStatus;
  prompt: string;
  /** Why the agent needs this answer */
  reason: string;
  recommendedAnswer?: string;
  recommendationRationale?: string;
  inputMode: AskUserInputMode;
  options?: AskUserOption[];
  required: boolean;
  source: AskUserSource;
  /** Request ids merged into this card by Firstmate coordination */
  mergedFrom?: string[];
  createdAt: string;
  answeredAt?: string;
  answer?: AskUserAnswer;
}

export interface CreateAskUserInput {
  kind: AskUserKind;
  prompt: string;
  reason: string;
  recommendedAnswer?: string;
  recommendationRationale?: string;
  inputMode: AskUserInputMode;
  options?: Array<{ id?: string; label: string }>;
  required?: boolean;
  source: AskUserSource;
  /** When true, always queue behind an existing pending card (no merge). */
  forceQueue?: boolean;
}

export interface AnswerAskUserInput {
  selectedOptionIds?: string[];
  freeText?: string;
  approved?: boolean;
  replanFeedback?: string;
}

export interface AskUserAnswerResult {
  request: AskUserRequest;
  /** Next pending card after queue promotion, if any */
  nextPending?: AskUserRequest;
  /** Resume step key for orchestration */
  resumeStepKey: string;
  /** When ask_replan is answered, caller should regenerate plan with this feedback */
  replanFeedback?: string;
}
