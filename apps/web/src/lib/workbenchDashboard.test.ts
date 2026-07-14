import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWorkbenchDashboard } from "./workbenchDashboard.js";

describe("loadWorkbenchDashboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("builds counts and waiting items from todos + attention runs only", async () => {
    const todos = [
      { id: "t-pending", title: "P", status: "pending", archived: false },
      { id: "t-run", title: "R", status: "running", archived: false },
      { id: "t-accept", title: "A", status: "awaiting_acceptance", archived: false }
    ];
    const runForAccept = {
      id: "run-1",
      todoId: "t-accept",
      attempt: 1,
      status: "awaiting_acceptance",
      timeline: [],
      messages: [],
      planVersions: [],
      execution: {
        status: "succeeded",
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
      updatedAt: "2026-01-02T00:00:00.000Z"
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/todos")) {
        return new Response(JSON.stringify(todos), { status: 200 });
      }
      if (url.includes("/api/todos/t-run/runs")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/api/todos/t-accept/runs")) {
        return new Response(JSON.stringify([runForAccept]), { status: 200 });
      }
      if (url.includes("/api/todos/t-pending/runs")) {
        throw new Error("should not scan pending-only todos");
      }
      return new Response(JSON.stringify({ error: url }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await loadWorkbenchDashboard("http://127.0.0.1:41731");
    expect(snapshot.counts.pending).toBe(1);
    expect(snapshot.counts.running).toBe(1);
    expect(snapshot.counts.awaitingAcceptance).toBe(1);
    expect(snapshot.waitingItems.some((item) => item.kind === "acceptance")).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("t-pending/runs"))).toBe(false);
  });
});
