import type { TodoRecord, TodoStatus } from "./todos.js";
import type { RunRecord } from "./runs.js";

/** Dashboard counters shown on the home workbench. */
export interface WorkbenchStatusCounts {
  pending: number;
  running: number;
  waitingOnUser: number;
  reviewFailed: number;
  awaitingAcceptance: number;
  completed: number;
}

export type WaitingItemKind =
  | "plan_approval"
  | "ask_user"
  | "dangerous_action"
  | "acceptance"
  | "review_failed"
  | "recovery";

export interface WaitingItem {
  id: string;
  kind: WaitingItemKind;
  title: string;
  detail: string;
  todoId: string;
  todoTitle: string;
  runId: string;
  /** ISO timestamp for stable sort (newest first). */
  sortAt: string;
  priority: number;
}

const kindPriority: Record<WaitingItemKind, number> = {
  dangerous_action: 0,
  plan_approval: 1,
  ask_user: 2,
  acceptance: 3,
  review_failed: 4,
  recovery: 5
};

const kindLabels: Record<WaitingItemKind, string> = {
  plan_approval: "计划审批",
  ask_user: "AskUser",
  dangerous_action: "危险操作",
  acceptance: "最终验收",
  review_failed: "审查失败",
  recovery: "中断恢复"
};

export function waitingKindLabel(kind: WaitingItemKind): string {
  return kindLabels[kind];
}

/**
 * Count Todos by workbench home buckets.
 * `reviewFailedTodoIds` are active todos whose latest independent review requested changes.
 */
export function computeWorkbenchStatusCounts(
  todos: TodoRecord[],
  reviewFailedTodoIds: Iterable<string> = []
): WorkbenchStatusCounts {
  const failed = new Set(reviewFailedTodoIds);
  const active = todos.filter((todo) => !todo.archived);
  const counts: WorkbenchStatusCounts = {
    pending: 0,
    running: 0,
    waitingOnUser: 0,
    reviewFailed: 0,
    awaitingAcceptance: 0,
    completed: 0
  };

  for (const todo of active) {
    if (failed.has(todo.id)) counts.reviewFailed += 1;
    switch (todo.status as TodoStatus) {
      case "pending":
        counts.pending += 1;
        break;
      case "running":
        counts.running += 1;
        break;
      case "awaiting_confirmation":
        counts.waitingOnUser += 1;
        break;
      case "awaiting_acceptance":
        counts.awaitingAcceptance += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}

/** Todos that may hold user-blocking Run work. */
export function todosNeedingAttentionScan(todos: TodoRecord[]): TodoRecord[] {
  return todos.filter(
    (todo) =>
      !todo.archived &&
      (todo.status === "running" ||
        todo.status === "awaiting_confirmation" ||
        todo.status === "awaiting_acceptance")
  );
}

/**
 * Pure extraction of “waiting on me” cards from a Run (+ optional Todo title).
 * Does not call the network.
 */
export function extractWaitingItemsFromRun(
  run: RunRecord,
  todo: Pick<TodoRecord, "id" | "title">
): WaitingItem[] {
  const items: WaitingItem[] = [];
  const todoTitle = todo.title;
  const todoId = todo.id;
  const sortAt = run.updatedAt || run.createdAt;

  if (
    run.planning?.approvalStatus === "awaiting_approval" ||
    run.status === "awaiting_plan_approval"
  ) {
    items.push({
      id: `${run.id}:plan`,
      kind: "plan_approval",
      title: "计划待批准",
      detail: `Run #${run.attempt} 的执行计划等待确认。`,
      todoId,
      todoTitle,
      runId: run.id,
      sortAt,
      priority: kindPriority.plan_approval
    });
  }

  const pendingAsks = (run.askUserRequests ?? []).filter((entry) => entry.status === "pending");
  for (const ask of pendingAsks) {
    items.push({
      id: `${run.id}:ask:${ask.id}`,
      kind: "ask_user",
      title: ask.prompt.slice(0, 120) || "需要回答 AskUser",
      detail: ask.reason || `来源 ${ask.source.agent} · ${ask.kind}`,
      todoId,
      todoTitle,
      runId: run.id,
      sortAt: ask.createdAt || sortAt,
      priority: kindPriority.ask_user
    });
  }

  const pendingExec = run.execution.pendingApproval;
  if (pendingExec?.status === "awaiting_confirmation") {
    items.push({
      id: `${run.id}:danger:${pendingExec.id}`,
      kind: "dangerous_action",
      title: pendingExec.summary || "危险操作待确认",
      detail: `类型 ${pendingExec.kind} · 需明确批准后继续。`,
      todoId,
      todoTitle,
      runId: run.id,
      sortAt: pendingExec.requestedAt || sortAt,
      priority: kindPriority.dangerous_action
    });
  }

  if (
    run.checkpointRecovery?.requiresDangerousReapproval ||
    run.checkpointRecovery?.status === "awaiting_dangerous_reapproval"
  ) {
    items.push({
      id: `${run.id}:recovery-danger`,
      kind: "dangerous_action",
      title: "恢复需重新批准危险步骤",
      detail: run.checkpointRecovery.recoveryNote || "中断恢复涉及危险操作，需用户再次确认。",
      todoId,
      todoTitle,
      runId: run.id,
      sortAt,
      priority: kindPriority.dangerous_action
    });
  }

  if (run.status === "awaiting_acceptance") {
    items.push({
      id: `${run.id}:accept`,
      kind: "acceptance",
      title: "成果待最终验收",
      detail: `Run #${run.attempt} 已通过独立审查门槛，等待用户验收。`,
      todoId,
      todoTitle,
      runId: run.id,
      sortAt,
      priority: kindPriority.acceptance
    });
  }

  const latestIndependent = [...(run.reviews ?? [])]
    .filter((review) => review.kind === "independent")
    .at(-1);
  if (
    latestIndependent?.status === "changes_requested" &&
    run.status !== "completed" &&
    run.status !== "cancelled"
  ) {
    items.push({
      id: `${run.id}:review-failed`,
      kind: "review_failed",
      title: "独立审查未通过",
      detail: latestIndependent.summary || "需修复后复审，或由用户决定后续动作。",
      todoId,
      todoTitle,
      runId: run.id,
      sortAt: latestIndependent.createdAt || sortAt,
      priority: kindPriority.review_failed
    });
  }

  if (run.status === "interrupted" || run.status === "paused") {
    items.push({
      id: `${run.id}:recovery`,
      kind: "recovery",
      title: run.status === "interrupted" ? "Run 已中断" : "Run 已暂停",
      detail: "可从检查点恢复、批准或停止。",
      todoId,
      todoTitle,
      runId: run.id,
      sortAt,
      priority: kindPriority.recovery
    });
  }

  return items;
}

export function collectWaitingItems(
  pairs: Array<{ todo: Pick<TodoRecord, "id" | "title">; runs: RunRecord[] }>
): WaitingItem[] {
  const items = pairs.flatMap(({ todo, runs }) =>
    runs.flatMap((run) => extractWaitingItemsFromRun(run, todo))
  );
  return items.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    return right.sortAt.localeCompare(left.sortAt);
  });
}

/** Todo ids whose latest independent review requested changes (across provided runs). */
export function reviewFailedTodoIdsFromRuns(
  pairs: Array<{ todoId: string; runs: RunRecord[] }>
): string[] {
  const failed = new Set<string>();
  for (const { todoId, runs } of pairs) {
    for (const run of runs) {
      if (run.status === "completed" || run.status === "cancelled") continue;
      const latest = [...(run.reviews ?? [])]
        .filter((review) => review.kind === "independent")
        .at(-1);
      if (latest?.status === "changes_requested") failed.add(todoId);
    }
  }
  return [...failed];
}
