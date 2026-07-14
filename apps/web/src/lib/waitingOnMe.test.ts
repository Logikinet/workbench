import { describe, expect, it } from "vitest";
import type { RunRecord } from "./runs.js";
import type { TodoRecord } from "./todos.js";
import {
  collectWaitingItems,
  computeWorkbenchStatusCounts,
  extractWaitingItemsFromRun,
  reviewFailedTodoIdsFromRuns,
  todosNeedingAttentionScan
} from "./waitingOnMe.js";

function baseRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    todoId: "todo-1",
    attempt: 1,
    status: "running",
    timeline: [],
    messages: [],
    planVersions: [],
    execution: {
      status: "idle",
      completedSteps: [],
      retryable: false,
      failureCounts: {},
      maxConsecutiveFailures: 3
    },
    logs: [],
    reviews: [],
    approvals: [],
    artifacts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides
  };
}

const todo: TodoRecord = {
  id: "todo-1",
  title: "示例任务",
  status: "running",
  archived: false
};

describe("workbench status counts", () => {
  it("buckets active todos and review-failed ids", () => {
    const todos: TodoRecord[] = [
      { id: "a", title: "a", status: "pending", archived: false },
      { id: "b", title: "b", status: "running", archived: false },
      { id: "c", title: "c", status: "awaiting_confirmation", archived: false },
      { id: "d", title: "d", status: "awaiting_acceptance", archived: false },
      { id: "e", title: "e", status: "completed", archived: false },
      { id: "f", title: "f", status: "pending", archived: true }
    ];
    const counts = computeWorkbenchStatusCounts(todos, ["b"]);
    expect(counts).toEqual({
      pending: 1,
      running: 1,
      waitingOnUser: 1,
      reviewFailed: 1,
      awaitingAcceptance: 1,
      completed: 1
    });
  });

  it("selects todos that need run scanning", () => {
    const todos: TodoRecord[] = [
      { id: "a", title: "a", status: "pending", archived: false },
      { id: "b", title: "b", status: "running", archived: false },
      { id: "c", title: "c", status: "awaiting_confirmation", archived: false },
      { id: "d", title: "d", status: "awaiting_acceptance", archived: true }
    ];
    expect(todosNeedingAttentionScan(todos).map((entry) => entry.id)).toEqual(["b", "c"]);
  });
});

describe("waiting-on-me extraction", () => {
  it("extracts plan approval, ask user, danger, acceptance, and review failure", () => {
    const run = baseRun({
      status: "awaiting_acceptance",
      planning: {
        assessment: {
          taskType: "implementation",
          requiredCapabilities: [],
          criticalInputs: [],
          assumptions: [],
          complexity: "low"
        },
        approvalStatus: "awaiting_approval"
      },
      askUserRequests: [
        {
          id: "ask-1",
          kind: "ask_user",
          status: "pending",
          prompt: "用哪个包管理器？",
          reason: "计划缺关键输入",
          inputMode: "free_text",
          required: true,
          source: { agent: "firstmate", stepKey: "plan" },
          createdAt: "2026-01-02T01:00:00.000Z"
        }
      ],
      execution: {
        status: "succeeded",
        completedSteps: [],
        retryable: false,
        failureCounts: {},
        maxConsecutiveFailures: 3,
        pendingApproval: {
          id: "pa-1",
          kind: "delete_file",
          summary: "删除临时文件",
          status: "awaiting_confirmation",
          requestedAt: "2026-01-02T02:00:00.000Z"
        }
      },
      reviews: [
        {
          id: "rev-1",
          kind: "independent",
          status: "changes_requested",
          summary: "缺测试",
          createdAt: "2026-01-02T03:00:00.000Z"
        } as RunRecord["reviews"][number]
      ]
    });

    const items = extractWaitingItemsFromRun(run, todo);
    const kinds = items.map((item) => item.kind);
    expect(kinds).toContain("plan_approval");
    expect(kinds).toContain("ask_user");
    expect(kinds).toContain("dangerous_action");
    expect(kinds).toContain("acceptance");
    expect(kinds).toContain("review_failed");
  });

  it("sorts by priority then recency", () => {
    const items = collectWaitingItems([
      {
        todo,
        runs: [
          baseRun({
            id: "run-a",
            status: "awaiting_acceptance",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }),
          baseRun({
            id: "run-b",
            status: "waiting_for_user",
            updatedAt: "2026-01-03T00:00:00.000Z",
            execution: {
              status: "idle",
              completedSteps: [],
              retryable: false,
              failureCounts: {},
              maxConsecutiveFailures: 3,
              pendingApproval: {
                id: "d1",
                kind: "delete_file",
                summary: "危险删除",
                status: "awaiting_confirmation",
                requestedAt: "2026-01-03T00:00:00.000Z"
              }
            }
          })
        ]
      }
    ]);
    expect(items[0]?.kind).toBe("dangerous_action");
  });

  it("collects review-failed todo ids", () => {
    const ids = reviewFailedTodoIdsFromRuns([
      {
        todoId: "todo-1",
        runs: [
          baseRun({
            reviews: [
              {
                id: "r1",
                kind: "independent",
                status: "changes_requested",
                summary: "no",
                createdAt: "2026-01-01T00:00:00.000Z"
              } as RunRecord["reviews"][number]
            ]
          })
        ]
      }
    ]);
    expect(ids).toEqual(["todo-1"]);
  });
});
