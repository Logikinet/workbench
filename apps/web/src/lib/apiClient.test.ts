import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonRequest } from "./apiClient.js";

describe("JSON API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats a successful no-content response as a successful void request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(createJsonRequest("http://127.0.0.1:41731")<void>("/api/connections/id", { method: "DELETE" })).resolves.toBeUndefined();
  });
});
