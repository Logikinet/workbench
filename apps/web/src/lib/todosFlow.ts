/**
 * todos.dev-aligned lifecycle (operation flow clone).
 *
 * Official path:
 *   Todo → Planning → Confirm → Building → Review → Done
 * Board chips:
 *   Task › Plan › Build
 */

import type { TodoRecord } from "./todos.js";
import type { RunRecord } from "./runs.js";

/** User-facing phase (todos product language). */
export type TodosPhase =
  | "todo"
  | "planning"
  | "confirm"
  | "building"
  | "review"
  | "done"
  | "blocked"
  | "failed";

export const phaseLabels: Record<TodosPhase, string> = {
  todo: "待办",
  planning: "规划中",
  confirm: "待确认",
  building: "执行中",
  review: "审查",
  done: "完成",
  blocked: "需处理",
  failed: "出错"
};

/**
 * Derive todos phase from Todo + optional latest Run.
 * Prefer Run when present (more precise than todo.status alone).
 */
export function deriveTodosPhase(todo: TodoRecord, run?: RunRecord | null): TodosPhase {
  if (todo.archived || todo.status === "completed") return "done";
  if (!run) {
    if (todo.status === "pending") return "todo";
    if (todo.status === "awaiting_confirmation") return "confirm";
    if (todo.status === "running") return "building";
    if (todo.status === "awaiting_acceptance") return "review";
    return "todo";
  }

  if (run.status === "cancelled") return "failed";
  if (run.status === "failed") return "failed";
  if (run.status === "completed") return "done";
  if (run.status === "awaiting_acceptance" || run.status === "awaiting_review") return "review";
  if (run.status === "running" || run.execution?.status === "running") return "building";
  if (run.status === "queued") return "building";
  if (run.status === "waiting_for_user") return "blocked";
  if (
    run.status === "awaiting_plan_approval" ||
    run.planning?.approvalStatus === "awaiting_approval"
  ) {
    return "confirm";
  }
  if (run.status === "planning" || run.status === "created") return "planning";
  if (run.planning?.approvalStatus === "awaiting_input") return "blocked";
  if (todo.status === "awaiting_confirmation") return "confirm";
  if (todo.status === "running") return "building";
  if (todo.status === "awaiting_acceptance") return "review";
  return "todo";
}

/** Layer chips: which of Task / Plan / Build is active or done. */
export function layerState(phase: TodosPhase): {
  task: "idle" | "active" | "done";
  plan: "idle" | "active" | "done";
  build: "idle" | "active" | "done";
} {
  switch (phase) {
    case "todo":
      return { task: "active", plan: "idle", build: "idle" };
    case "planning":
      return { task: "done", plan: "active", build: "idle" };
    case "confirm":
    case "blocked":
      return { task: "done", plan: "active", build: "idle" };
    case "building":
      return { task: "done", plan: "done", build: "active" };
    case "review":
    case "done":
      return { task: "done", plan: "done", build: "done" };
    case "failed":
      return { task: "done", plan: "done", build: "active" };
    default:
      return { task: "idle", plan: "idle", build: "idle" };
  }
}

/** Primary CTA for a row (todos operation model). */
export function primaryActionForPhase(phase: TodosPhase): {
  id: "start_plan" | "confirm_build" | "view" | "none";
  label: string;
} {
  switch (phase) {
    case "todo":
      return { id: "start_plan", label: "开始规划" };
    case "planning":
      return { id: "view", label: "规划中…" };
    case "confirm":
      return { id: "confirm_build", label: "确认并构建" };
    case "blocked":
      return { id: "view", label: "需要你处理" };
    case "building":
      return { id: "view", label: "构建中…" };
    case "review":
      return { id: "view", label: "去验收" };
    case "done":
      return { id: "view", label: "查看" };
    case "failed":
      return { id: "start_plan", label: "重新规划" };
    default:
      return { id: "none", label: "" };
  }
}
