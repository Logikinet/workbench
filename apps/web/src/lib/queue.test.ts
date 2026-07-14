import { describe, expect, it, vi } from "vitest";
import { createQueueClient } from "./queue.js";

describe("queue client", () => {
  it("loads and updates queue config", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ maxWriteParallel: 1, maxReadOnlyParallel: 2, maxRetries: 2 })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ maxWriteParallel: 2, maxReadOnlyParallel: 2, maxRetries: 3 })
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = createQueueClient("http://127.0.0.1:41731");
    await expect(client.getConfig()).resolves.toMatchObject({ maxWriteParallel: 1 });
    await expect(client.updateConfig({ maxWriteParallel: 2, maxRetries: 3 })).resolves.toMatchObject({
      maxWriteParallel: 2,
      maxRetries: 3
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:41731/api/queue/config",
      expect.objectContaining({ method: "PUT" })
    );
    vi.unstubAllGlobals();
  });

  it("posts stop-all and returns terminate results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        summary: "全部停止",
        stopped: 1,
        failed: 0,
        skipped: 0,
        results: [{ runId: "r1", outcome: "cancelled", processTerminated: true, message: "ok" }]
      })
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createQueueClient("http://127.0.0.1:41731");
    await expect(client.stopAll("全部停止")).resolves.toMatchObject({ stopped: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:41731/api/runs/stop-all",
      expect.objectContaining({ method: "POST" })
    );
    vi.unstubAllGlobals();
  });
});
