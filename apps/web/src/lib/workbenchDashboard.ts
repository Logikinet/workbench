import { createRunClient, type RunRecord } from "./runs.js";
import { createTodoClient, type TodoRecord } from "./todos.js";
import {
  collectWaitingItems,
  computeWorkbenchStatusCounts,
  reviewFailedTodoIdsFromRuns,
  todosNeedingAttentionScan,
  type WaitingItem,
  type WorkbenchStatusCounts
} from "./waitingOnMe.js";

export interface WorkbenchDashboardSnapshot {
  todos: TodoRecord[];
  counts: WorkbenchStatusCounts;
  waitingItems: WaitingItem[];
  reviewFailedTodoIds: string[];
}

/**
 * Load home/waiting snapshot using existing list APIs only (no new service routes).
 * Scans runs only for todos that need attention; concurrency-capped.
 */
export async function loadWorkbenchDashboard(
  serviceUrl: string,
  options: { concurrency?: number } = {}
): Promise<WorkbenchDashboardSnapshot> {
  const concurrency = options.concurrency ?? 4;
  const todosClient = createTodoClient(serviceUrl);
  const runsClient = createRunClient(serviceUrl);
  const todos = await todosClient.list();
  const scanTodos = todosNeedingAttentionScan(todos);
  const pairs: Array<{ todo: TodoRecord; runs: RunRecord[] }> = [];

  for (let index = 0; index < scanTodos.length; index += concurrency) {
    const batch = scanTodos.slice(index, index + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (todo) => {
        try {
          const runs = await runsClient.list(todo.id);
          return { todo, runs };
        } catch {
          return { todo, runs: [] as RunRecord[] };
        }
      })
    );
    pairs.push(...batchResults);
  }

  const waitingItems = collectWaitingItems(pairs);
  const reviewFailedTodoIds = reviewFailedTodoIdsFromRuns(
    pairs.map(({ todo, runs }) => ({ todoId: todo.id, runs }))
  );
  const counts = computeWorkbenchStatusCounts(todos, reviewFailedTodoIds);

  return { todos, counts, waitingItems, reviewFailedTodoIds };
}
