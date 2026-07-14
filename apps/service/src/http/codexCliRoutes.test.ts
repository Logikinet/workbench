import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { CodexCliService } from "../codex/codexCliService.js";
import { createApp } from "./app.js";

describe("Codex CLI HTTP contract", () => {
  it("exposes non-secret readiness and starts a selected Role only through the Run endpoint", async () => {
    const status = vi.fn().mockResolvedValue({ installed: true, authenticated: true, version: "codex 0.1.0" });
    const start = vi.fn().mockResolvedValue({ id: "run-1", status: "running" });
    const codexCli = { status, start } as unknown as CodexCliService;
    const app = createApp({ version: "0.1.0", codexCli });

    await request(app)
      .get("/api/codex-cli/status")
      .expect(200, { installed: true, authenticated: true, version: "codex 0.1.0" });
    await request(app)
      .post("/api/runs/run-1/codex-cli/execute")
      .send({ roleId: "role-1" })
      .expect(202, { id: "run-1", status: "running" });

    expect(status).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith("run-1", { roleId: "role-1" });
  });
});
