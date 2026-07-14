import { describe, expect, it, vi } from "vitest";
import { emergencyStopAll } from "./emergencyStop.js";

describe("tray emergency stop client", () => {
  it("POSTs stop-all to the loopback Agent Service", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:41731/api/runs/stop-all");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        summary: "托盘紧急停止：停止全部任务。"
      });
      return new Response(
        JSON.stringify({
          summary: "托盘紧急停止：停止全部任务。",
          results: [
            {
              runId: "run-1",
              todoId: "todo-1",
              previousStatus: "running",
              outcome: "cancelled",
              processTerminated: true,
              message: "ok"
            }
          ],
          stopped: 1,
          failed: 0,
          skipped: 0
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await emergencyStopAll({
      serviceUrl: "http://127.0.0.1:41731",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.stopped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("surfaces an actionable error when the local service is offline", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      emergencyStopAll({
        serviceUrl: "http://127.0.0.1:41731",
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow(/请先从托盘启动服务/);
  });

  it("propagates API error payloads from stop-all", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Queue service is not ready." }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      })
    );
    await expect(
      emergencyStopAll({
        serviceUrl: "http://127.0.0.1:41731/",
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow(/Queue service is not ready/);
  });
});
