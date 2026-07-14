import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { GitWorktreeService } from "../git/gitWorktreeService.js";
import { createApp } from "./app.js";

describe("Git worktree HTTP contract", () => {
  it("returns a Run's full diff, records allowed check results, and lets the user discard isolated changes", async () => {
    const get = vi.fn().mockResolvedValue({ runId: "run-1", workspacePath: "C:\\worktrees\\run-1", status: "active" });
    const captureDiff = vi.fn().mockResolvedValue({ changedFiles: ["src/app.ts"], diff: "diff --git a/src/app.ts b/src/app.ts\n" });
    const runApprovedChecks = vi.fn().mockResolvedValue([{ command: ["npm", "test"], exitCode: 0, stdout: "passed", stderr: "" }]);
    const discard = vi.fn().mockResolvedValue({ runId: "run-1", status: "discarded" });
    const worktrees = { get, captureDiff, runApprovedChecks, discard } as unknown as GitWorktreeService;
    const runs = {
      get: vi.fn().mockResolvedValue({
        status: "awaiting_review",
        execution: { status: "succeeded", terminationUnconfirmed: false },
        planning: { approvedPlanVersion: 1 },
        planVersions: [{ version: 1, verificationCommands: [["npm", "test"]] }]
      })
    };
    const app = createApp({ version: "0.1.0", worktrees, runs: runs as never });

    await request(app).get("/api/runs/run-1/worktree").expect(200, {
      session: { runId: "run-1", workspacePath: "C:\\worktrees\\run-1", status: "active" },
      changedFiles: ["src/app.ts"],
      diff: "diff --git a/src/app.ts b/src/app.ts\n"
    });
    await request(app).post("/api/runs/run-1/worktree/checks").send({ commands: [["npm", "test"]] }).expect(201);
    expect(runApprovedChecks).toHaveBeenCalledWith("run-1", [["npm", "test"]]);
    await request(app).delete("/api/runs/run-1/worktree").expect(200, { runId: "run-1", status: "discarded" });
    expect(discard).toHaveBeenCalledWith("run-1");
  });

  it("never runs checks or removes a Worktree while its Run is active", async () => {
    const worktrees = {
      get: vi.fn(),
      captureDiff: vi.fn(),
      runApprovedChecks: vi.fn(),
      discard: vi.fn()
    } as unknown as GitWorktreeService;
    const runs = {
      get: vi.fn().mockResolvedValue({
        status: "running",
        execution: { status: "running" },
        planning: { approvedPlanVersion: 1 },
        planVersions: [{ version: 1, verificationCommands: [["npm", "test"]] }]
      })
    };
    const app = createApp({ version: "0.1.0", worktrees, runs: runs as never });

    await request(app).delete("/api/runs/run-1/worktree").expect(409);
    expect(worktrees.discard).not.toHaveBeenCalled();
  });

  it("rejects a command that is not byte-for-byte in the approved plan", async () => {
    const worktrees = {
      get: vi.fn(),
      captureDiff: vi.fn(),
      runApprovedChecks: vi.fn(),
      discard: vi.fn()
    } as unknown as GitWorktreeService;
    const runs = {
      get: vi.fn().mockResolvedValue({
        status: "awaiting_review",
        execution: { status: "succeeded" },
        planning: { approvedPlanVersion: 1 },
        planVersions: [{ version: 1, verificationCommands: [["npm", "test"]] }]
      })
    };
    const app = createApp({ version: "0.1.0", worktrees, runs: runs as never });

    await request(app).post("/api/runs/run-1/worktree/checks").send({ commands: [["npm", "test", "--", "--unsafe"]] }).expect(400);
    expect(worktrees.runApprovedChecks).not.toHaveBeenCalled();
  });

  it("maps in-progress verify/discard conflicts to HTTP 409", async () => {
    const worktrees = {
      get: vi.fn(),
      captureDiff: vi.fn(),
      runApprovedChecks: vi.fn().mockRejectedValue(new Error("验证命令正在运行中。")),
      discard: vi.fn().mockRejectedValue(new Error("验证运行中，无法放弃此 Worktree。"))
    } as unknown as GitWorktreeService;
    const runs = {
      get: vi.fn().mockResolvedValue({
        status: "awaiting_review",
        execution: { status: "succeeded", terminationUnconfirmed: false },
        planning: { approvedPlanVersion: 1 },
        planVersions: [{ version: 1, verificationCommands: [["npm", "test"]] }]
      })
    };
    const app = createApp({ version: "0.1.0", worktrees, runs: runs as never });

    await request(app).post("/api/runs/run-1/worktree/checks").send({ commands: [["npm", "test"]] }).expect(409);
    await request(app).delete("/api/runs/run-1/worktree").expect(409);
  });
});
