import { randomUUID } from "node:crypto";
import type {
  AnswerAskUserInput,
  AskUserAnswerResult,
  AskUserOption,
  AskUserRequest,
  CreateAskUserInput
} from "./askUserTypes.js";
import { askUserInputModes, askUserKinds } from "./askUserTypes.js";

/**
 * Pure Firstmate-side coordination: merge similar prompts, queue the rest,
 * validate answers, and promote the next queued card after an answer.
 */

export function createAskUserRequest(input: CreateAskUserInput, now: string): AskUserRequest {
  if (!askUserKinds.includes(input.kind)) {
    throw new Error("Ask kind must be ask_user, ask_approval, or ask_replan.");
  }
  if (!askUserInputModes.includes(input.inputMode)) {
    throw new Error("AskUser input mode is invalid.");
  }
  const prompt = input.prompt.trim();
  const reason = input.reason.trim();
  if (!prompt) throw new Error("AskUser prompt is required.");
  if (!reason) throw new Error("AskUser reason is required.");
  if (!input.source?.agent?.trim() || !input.source?.stepKey?.trim()) {
    throw new Error("AskUser source agent and stepKey are required.");
  }

  const options = normalizeOptions(input.options);
  if (requiresOptions(input.inputMode) && options.length === 0) {
    throw new Error("This AskUser mode requires at least one option.");
  }

  return {
    id: randomUUID(),
    kind: input.kind,
    status: "pending",
    prompt,
    reason,
    recommendedAnswer: input.recommendedAnswer?.trim() || undefined,
    recommendationRationale: input.recommendationRationale?.trim() || undefined,
    inputMode: input.inputMode,
    options: options.length > 0 ? options : undefined,
    required: input.required !== false,
    source: {
      agent: input.source.agent.trim(),
      stepKey: input.source.stepKey.trim(),
      roleId: input.source.roleId?.trim() || undefined,
      label: input.source.label?.trim() || undefined
    },
    createdAt: now
  };
}

/**
 * Insert a new ask: merge into an existing pending card when similar,
 * otherwise queue if another interactive card is already pending.
 */
export function enqueueAskUser(
  existing: AskUserRequest[],
  input: CreateAskUserInput,
  now: string
): { requests: AskUserRequest[]; created: AskUserRequest; mergedInto?: AskUserRequest } {
  const draft = createAskUserRequest(input, now);
  const activePending = existing.filter((entry) => entry.status === "pending");

  if (!input.forceQueue) {
    const mergeTarget = activePending.find((entry) => canMerge(entry, draft));
    if (mergeTarget) {
      const merged = mergeRequests(mergeTarget, draft, now);
      const requests = existing.map((entry) => (entry.id === merged.id ? merged : entry));
      return { requests, created: draft, mergedInto: merged };
    }
  }

  // Queue only when another interactive card is already pending (forceQueue skips merge but still waits its turn).
  if (activePending.length > 0) {
    draft.status = "queued";
  }

  return { requests: [...existing, draft], created: draft };
}

export function answerAskUserRequest(
  requests: AskUserRequest[],
  requestId: string,
  input: AnswerAskUserInput,
  now: string
): { requests: AskUserRequest[]; result: AskUserAnswerResult } {
  const target = requests.find((entry) => entry.id === requestId);
  if (!target) throw new Error(`AskUser request ${requestId} was not found.`);
  if (target.status !== "pending") {
    throw new Error("Only a pending AskUser request can be answered.");
  }

  const answer = validateAnswer(target, input);
  const answered: AskUserRequest = {
    ...target,
    status: "answered",
    answeredAt: now,
    answer
  };

  let next = requests.map((entry) => (entry.id === requestId ? answered : entry));
  let nextPending: AskUserRequest | undefined;

  // Promote the oldest queued card to pending (Firstmate queue discipline).
  const queued = next
    .filter((entry) => entry.status === "queued")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (queued[0]) {
    nextPending = { ...queued[0], status: "pending" };
    next = next.map((entry) => (entry.id === nextPending!.id ? nextPending! : entry));
  }

  return {
    requests: next,
    result: {
      request: answered,
      nextPending,
      resumeStepKey: answered.source.stepKey,
      replanFeedback: answered.kind === "ask_replan"
        ? (answer.replanFeedback ?? answer.freeText)
        : undefined
    }
  };
}

export function listActiveAskUser(requests: AskUserRequest[]): AskUserRequest[] {
  return requests.filter((entry) => entry.status === "pending" || entry.status === "queued");
}

export function hasPendingAskUser(requests: AskUserRequest[] | undefined): boolean {
  return Boolean(requests?.some((entry) => entry.status === "pending"));
}

function canMerge(existing: AskUserRequest, incoming: AskUserRequest): boolean {
  if (existing.kind !== incoming.kind) return false;
  if (existing.source.stepKey !== incoming.source.stepKey) return false;
  // Same kind + step: merge when prompts are equal or one contains the other (avoid duplicate disturbance).
  const a = existing.prompt.toLocaleLowerCase();
  const b = incoming.prompt.toLocaleLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

function mergeRequests(target: AskUserRequest, incoming: AskUserRequest, now: string): AskUserRequest {
  const optionMap = new Map<string, AskUserOption>();
  for (const option of target.options ?? []) optionMap.set(option.id, option);
  for (const option of incoming.options ?? []) {
    if (![...optionMap.values()].some((entry) => entry.label === option.label)) {
      optionMap.set(option.id, option);
    }
  }
  const reasons = unique([target.reason, incoming.reason]);
  const prompts = unique([target.prompt, incoming.prompt]);
  return {
    ...target,
    prompt: prompts.join(" / "),
    reason: reasons.join("；"),
    options: optionMap.size > 0 ? [...optionMap.values()] : target.options,
    recommendedAnswer: target.recommendedAnswer ?? incoming.recommendedAnswer,
    recommendationRationale: target.recommendationRationale ?? incoming.recommendationRationale,
    mergedFrom: unique([...(target.mergedFrom ?? []), incoming.id]),
    // Keep original createdAt; surface update via timeline elsewhere.
    createdAt: target.createdAt
  };
}

function validateAnswer(request: AskUserRequest, input: AnswerAskUserInput): NonNullable<AskUserRequest["answer"]> {
  const selectedOptionIds = unique(input.selectedOptionIds ?? []);
  const freeText = input.freeText?.trim() || undefined;
  const replanFeedback = input.replanFeedback?.trim() || freeText;
  const optionIds = new Set((request.options ?? []).map((option) => option.id));

  for (const id of selectedOptionIds) {
    if (!optionIds.has(id)) throw new Error(`Unknown option id: ${id}`);
  }

  switch (request.inputMode) {
    case "single_select": {
      if (selectedOptionIds.length !== 1) throw new Error("Single-select requires exactly one option.");
      break;
    }
    case "multi_select": {
      if (selectedOptionIds.length === 0 && request.required) {
        throw new Error("Multi-select requires at least one option.");
      }
      break;
    }
    case "free_text": {
      if (!freeText && request.required) throw new Error("Free-text answer is required.");
      break;
    }
    case "single_select_with_text": {
      if (selectedOptionIds.length !== 1) throw new Error("Single-select requires exactly one option.");
      if (!freeText && request.required) throw new Error("Additional free-text is required.");
      break;
    }
    case "multi_select_with_text": {
      if (selectedOptionIds.length === 0 && request.required) {
        throw new Error("Multi-select requires at least one option.");
      }
      if (!freeText && request.required) throw new Error("Additional free-text is required.");
      break;
    }
    default:
      throw new Error("AskUser input mode is invalid.");
  }

  if (request.kind === "ask_approval") {
    if (typeof input.approved !== "boolean" && selectedOptionIds.length === 0) {
      throw new Error("AskApproval requires approved true/false or a selected option.");
    }
  }

  if (request.kind === "ask_replan") {
    const feedback = replanFeedback;
    if (!feedback && request.required) throw new Error("AskReplan feedback is required.");
  }

  let approved = input.approved;
  if (approved === undefined && request.kind === "ask_approval" && selectedOptionIds.length === 1) {
    const label = (request.options ?? []).find((option) => option.id === selectedOptionIds[0])?.label ?? "";
    if (/approve|批准|同意|yes|是/i.test(label)) approved = true;
    if (/reject|拒绝|否|no|驳回/i.test(label)) approved = false;
  }

  return {
    selectedOptionIds: selectedOptionIds.length > 0 ? selectedOptionIds : undefined,
    freeText,
    approved,
    replanFeedback: request.kind === "ask_replan" ? replanFeedback : undefined
  };
}

function requiresOptions(mode: CreateAskUserInput["inputMode"]): boolean {
  return mode === "single_select"
    || mode === "multi_select"
    || mode === "single_select_with_text"
    || mode === "multi_select_with_text";
}

function normalizeOptions(options: CreateAskUserInput["options"]): AskUserOption[] {
  if (!options) return [];
  return options
    .map((option) => ({
      id: option.id?.trim() || randomUUID(),
      label: option.label.trim()
    }))
    .filter((option) => option.label.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
