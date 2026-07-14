import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { GitWorktreeService } from "../git/gitWorktreeService.js";
import { registerWorktreeApplyRoutes } from "../git/worktreeRoutes.js";
import { createApp } from "./app.js";

describe("Git worktree HTTP contract", () => {
  it("returns a Run's full diff, records allowed check results, and lets the user discard isolated changes", async () => {
    const get = vi.fn().mockResolvedValue({ runId: "run-1", workspacePath: "C:\\worktrees\\run-1", status: "active" });
    const captureDiff = vi.fn().mockResolvedValue({ changedFiles: ["src/app.ts"], diff: "diff --git a/src/app.ts b/src/app.ts\n" });
    const runApprovedChecks = vi.fn().mockResolvedValue([{ command: ["npm", "test"], exitCode: 0, stdout: "passed", stderr: "" }]);
    const discard = vi.fn().mockResolvedValue({ runId: "run-1", status: "discarded" });
    const worktrees = { get, captureDiff, runApprovedChecks, discard } as unknown as GitWorktreeService;
    const runState = {
      status: "awaiting_review",
      execution: { status: "succeeded", terminationUnconfirmed: false },
      planning: { approvedPlanVersion: 1 },
      planVersions: [{ version: 1, verificationCommands: [["npm", "test"]] }],
      artifacts: [] as unknown[]
    };
    const runs = {
      get: vi.fn().mockResolvedValue(runState),
      reconcileWorktreeArtifactConsistency: vi.fn().mockResolvedValue(runState),
      markWorktreeArtifactsDiscarded: vi.fn().mockResolvedValue(runState)
    };
    const app = createApp({ version: "0.1.0", worktrees, runs: runs as never });

    const worktree = await request(app).get("/api/runs/run-1/worktree").expect(200);
    expect(worktree.body).toMatchObject({
      session: { runId: "run-1", workspacePath: "C:\\worktrees\\run-1", status: "active" },
      changedFiles: ["src/app.ts"],
      diff: "diff --git a/src/app.ts b/src/app.ts\n",
      artifactEvidence: null
    });
    await request(app).post("/api/runs/run-1/worktree/checks").send({ commands: [["npm", "test"]] }).expect(201);
    expect(runApprovedChecks).toHaveBeenCalledWith("run-1", [["npm", "test"]]);
    await request(app).delete("/api/runs/run-1/worktree").expect(200, { runId: "run-1", status: "discarded" });
    expect(discard).toHaveBeenCalledWith("run-1");
    expect(runs.markWorktreeArtifactsDiscarded).toHaveBeenCalledWith("run-1");
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
      }),
      markWorktreeArtifactsDiscarded: vi.fn()
    };
    const app = createApp({ version: "0.1.0", worktrees, runs: runs as never });

    await request(app).post("/api/runs/run-1/worktree/checks").send({ commands: [["npm", "test"]] }).expect(409);
    await request(app).delete("/api/runs/run-1/worktree").expect(409);
  });
});

describe("Worktree apply HTTP routes (Ticket 27 — mount via registerWorktreeApplyRoutes)", () => {
  function mountApplyApp(worktrees: unknown, runs?: unknown) {
    const app = express();
    app.use(express.json());
    registerWorktreeApplyRoutes(app, {
      worktrees: worktrees as never,
      runs: runs as never
    });
    return app;
  }

  it("previews apply with Chinese draft and applies successfully without push", async () => {
    const previewApply = vi.fn().mockResolvedValue({
      runId: "run-1",
      ok: true,
      status: "ready",
      changedFiles: ["src/app.ts"],
      commitMessageDraft: "应用 Run run-1 的隔离 Worktree 修改：src/app.ts（1 个文件）。",
      dirtyFiles: [],
      conflictFiles: [],
      externalChangeDetected: false,
      applied: false,
      pushed: false,
      canCompleteDevRun: false
    });
    const applyToMain = vi.fn().mockResolvedValue({
      status: "applied",
      runId: "run-1",
      commitSha: "deadbeef",
      commitMessage: "应用 Run run-1 的隔离 Worktree 修改：src/app.ts（1 个文件）。",
      pushed: false,
      sessionStatus: "applied",
      canCompleteDevRun: true
    });
    const keepPending = vi.fn();
    const markWorktreeArtifactsApplied = vi.fn().mockResolvedValue({});
    const app = mountApplyApp(
      { previewApply, applyToMain, keepPending, get: vi.fn() },
      {
        get: vi.fn().mockResolvedValue({ status: "awaiting_acceptance", execution: { status: "succeeded" } }),
        markWorktreeArtifactsApplied
      }
    );

    const preview = await request(app).get("/api/runs/run-1/worktree/apply/preview").expect(200);
    expect(preview.body.commitMessageDraft).toMatch(/应用/);
    expect(preview.body.pushed).toBe(false);

    const applied = await request(app)
      .post("/api/runs/run-1/worktree/apply")
      .send({ commitMessage: "应用 Run run-1 的隔离 Worktree 修改：src/app.ts（1 个文件）。" })
      .expect(200);
    expect(applied.body).toMatchObject({ status: "applied", pushed: false, canCompleteDevRun: true, commitSha: "deadbeef" });
    expect(applyToMain).toHaveBeenCalledWith("run-1", {
      commitMessage: "应用 Run run-1 的隔离 Worktree 修改：src/app.ts（1 个文件）。"
    });
    expect(markWorktreeArtifactsApplied).toHaveBeenCalledWith("run-1", {
      commitSha: "deadbeef",
      commitMessage: "应用 Run run-1 的隔离 Worktree 修改：src/app.ts（1 个文件）。"
    });
  });

  it("returns structured blocked/conflict bodies and 409 for busy double-click", async () => {
    const applyBlocked = vi.fn().mockResolvedValue({
      status: "blocked",
      runId: "run-1",
      reason: "主工作区存在未提交修改",
      dirtyFiles: ["wip.ts"],
      pushed: false,
      sessionStatus: "active",
      canCompleteDevRun: false
    });
    const applyConflict = vi.fn().mockResolvedValue({
      status: "conflict",
      runId: "run-2",
      conflictFiles: ["README.md"],
      pushed: false,
      sessionStatus: "active",
      canCompleteDevRun: false
    });
    const applyBusy = vi.fn().mockRejectedValue(new Error("正在应用此 Worktree 修改。"));
    const runs = {
      get: vi.fn().mockResolvedValue({ status: "awaiting_acceptance", execution: { status: "succeeded" } })
    };

    await request(mountApplyApp({ previewApply: vi.fn(), applyToMain: applyBlocked, keepPending: vi.fn(), get: vi.fn() }, runs))
      .post("/api/runs/run-1/worktree/apply")
      .send({})
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe("blocked");
        expect(body.dirtyFiles).toContain("wip.ts");
      });

    await request(mountApplyApp({ previewApply: vi.fn(), applyToMain: applyConflict, keepPending: vi.fn(), get: vi.fn() }, runs))
      .post("/api/runs/run-2/worktree/apply")
      .send({})
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe("conflict");
        expect(body.conflictFiles).toContain("README.md");
      });

    await request(mountApplyApp({ previewApply: vi.fn(), applyToMain: applyBusy, keepPending: vi.fn(), get: vi.fn() }, runs))
      .post("/api/runs/run-3/worktree/apply")
      .send({})
      .expect(409);
  });

  it("records keep-pending without mutating main and blocks completion gate", async () => {
    const keepPending = vi.fn().mockResolvedValue({
      runId: "run-1",
      status: "keep_pending",
      sessionStatus: "active",
      canCompleteDevRun: false,
      pushed: false,
      applyRecord: { decision: "keep_pending", pushed: false }
    });
    const app = mountApplyApp(
      { previewApply: vi.fn(), applyToMain: vi.fn(), keepPending, get: vi.fn() },
      { get: vi.fn().mockResolvedValue({ status: "awaiting_acceptance", execution: { status: "succeeded" } }) }
    );

    const response = await request(app).post("/api/runs/run-1/worktree/keep-pending").expect(200);
    expect(response.body).toMatchObject({ status: "keep_pending", canCompleteDevRun: false, pushed: false });
    expect(keepPending).toHaveBeenCalledWith("run-1");
  });

  it("rejects apply while Run execution is still active", async () => {
    const applyToMain = vi.fn();
    const app = mountApplyApp(
      { previewApply: vi.fn(), applyToMain, keepPending: vi.fn(), get: vi.fn() },
      { get: vi.fn().mockResolvedValue({ status: "running", execution: { status: "running" } }) }
    );
    await request(app).post("/api/runs/run-1/worktree/apply").send({}).expect(409);
    expect(applyToMain).not.toHaveBeenCalled();
  });
});
