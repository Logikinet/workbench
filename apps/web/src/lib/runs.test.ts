import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunClient, reconcileRunSelection, type TimelineEvent } from "./runs.js";

describe("Run selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("selects the newest Run when a Todo switch leaves an old Run ID behind", () => {
    expect(reconcileRunSelection(["newest", "older"], "run-from-another-todo")).toBe("newest");
  });

  it("keeps a selected Run when it still belongs to the active Todo", () => {
    expect(reconcileRunSelection(["newest", "older"], "older")).toBe("older");
  });

  it("models correction events returned by the execution timeline", () => {
    const event: TimelineEvent = { id: "event-1", kind: "correction", summary: "用户纠偏", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(event.kind).toBe("correction");
  });

  it("sends user corrections and plan decisions to the structured planning endpoints", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = createRunClient("http://127.0.0.1:41731");

    await client.updatePlanning("run-1", { taskType: "research", requiredCapabilities: ["documents"] });
    await client.decidePlan("run-1", { decision: "approved", summary: "范围明确。" });

    expect(fetch).toHaveBeenNthCalledWith(1, "http://127.0.0.1:41731/api/runs/run-1/planning", expect.objectContaining({ method: "PATCH" }));
    expect(fetch).toHaveBeenNthCalledWith(2, "http://127.0.0.1:41731/api/runs/run-1/plan-decisions", expect.objectContaining({ method: "POST" }));
  });

  it("starts a selected Professional Agent through the approved Run endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "run-1", status: "running" }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);

    await createRunClient("http://127.0.0.1:41731").executeProfessionalAgent("run-1", { roleId: "role-1" });

    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:41731/api/runs/run-1/professional-agent/execute", expect.objectContaining({ method: "POST" }));
  });

  it("checks Codex CLI readiness and starts a selected Codex Role through its controlled Run endpoint", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ installed: true, authenticated: true, version: "codex 0.1.0" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-1", status: "running" }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);

    const client = createRunClient("http://127.0.0.1:41731");
    await expect(client.codexCliStatus()).resolves.toMatchObject({ installed: true, authenticated: true });
    await client.executeCodexCli("run-1", { roleId: "codex-role-1" });

    expect(fetch).toHaveBeenNthCalledWith(1, "http://127.0.0.1:41731/api/codex-cli/status", expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, "http://127.0.0.1:41731/api/runs/run-1/codex-cli/execute", expect.objectContaining({ method: "POST" }));
  });

  it("sends stop, correction, and dangerous-action decisions through controlled Run endpoints", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-1" }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = createRunClient("http://127.0.0.1:41731");

    await client.stop("run-1", "用户停止此 Run");
    await client.correctAndContinue("run-1", { instruction: "仅更正输出文件名。", changeKind: "minor" });
    await client.decideExecutionApproval("run-1", { decision: "rejected", summary: "不要删除文件。" });

    expect(fetch).toHaveBeenNthCalledWith(1, "http://127.0.0.1:41731/api/runs/run-1/stop", expect.objectContaining({ method: "POST" }));
    expect(fetch).toHaveBeenNthCalledWith(2, "http://127.0.0.1:41731/api/runs/run-1/corrections", expect.objectContaining({ method: "POST" }));
    expect(fetch).toHaveBeenNthCalledWith(3, "http://127.0.0.1:41731/api/runs/run-1/execution-approvals", expect.objectContaining({ method: "POST" }));
  });

  it("performs independent review, fix dispatch and user acceptance through controlled endpoints", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ originalGoal: { title: "t" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: { id: "run-1" }, review: { status: "passed" }, fixDispatched: false }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: { id: "run-1" }, continued: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: { id: "run-1", status: "completed" }, todo: { id: "todo-1", status: "completed" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = createRunClient("http://127.0.0.1:41731");

    await client.reviewContext("run-1");
    await client.performReview("run-1", { autoDispatchFix: true });
    await client.dispatchReviewFix("run-1");
    await client.decideAcceptance("run-1", { decision: "accepted", summary: "验收通过。" });

    expect(fetch).toHaveBeenNthCalledWith(1, "http://127.0.0.1:41731/api/runs/run-1/review/context", expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, "http://127.0.0.1:41731/api/runs/run-1/review/perform", expect.objectContaining({ method: "POST" }));
    expect(fetch).toHaveBeenNthCalledWith(3, "http://127.0.0.1:41731/api/runs/run-1/review/fix", expect.objectContaining({ method: "POST" }));
    expect(fetch).toHaveBeenNthCalledWith(4, "http://127.0.0.1:41731/api/runs/run-1/acceptance", expect.objectContaining({ method: "POST" }));
  });

  it("lists interrupted runs and resumes from checkpoints through controlled endpoints", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ runId: "run-1", status: "interrupted" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ runId: "run-1", checkpoints: [], recoveryNote: "不会恢复原模型内部会话" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ canContinue: true, run: { id: "run-1", status: "queued" } }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const client = createRunClient("http://127.0.0.1:41731");

    await client.listInterruptedRuns();
    await client.listCheckpoints("run-1");
    await client.resumeFromCheckpoint("run-1", { approveDangerousReplay: true });

    expect(fetch).toHaveBeenNthCalledWith(1, "http://127.0.0.1:41731/api/interrupted-runs", expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, "http://127.0.0.1:41731/api/runs/run-1/checkpoints", expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(3, "http://127.0.0.1:41731/api/runs/run-1/checkpoint-resume", expect.objectContaining({ method: "POST" }));
  });

  it("surfaces structured 409 conflict and 403 dangerous re-approval checkpoint resume bodies", async () => {
    const conflictRun = {
      id: "run-1",
      status: "paused",
      checkpointRecovery: { status: "conflict", conflictReason: "外部修改", requiresDangerousReapproval: false, recoveryNote: "note" }
    };
    const dangerousRun = {
      id: "run-1",
      status: "paused",
      execution: { pendingApproval: { status: "awaiting_confirmation", kind: "delete_file" } },
      checkpointRecovery: { status: "awaiting_dangerous_reapproval", requiresDangerousReapproval: true, recoveryNote: "note" }
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        canContinue: false,
        conflict: true,
        requiresDangerousReapproval: false,
        reason: "工作区在中断后被外部修改",
        error: "工作区在中断后被外部修改",
        run: conflictRun
      }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        canContinue: false,
        conflict: false,
        requiresDangerousReapproval: true,
        reason: "危险操作不会自动重放",
        error: "危险操作不会自动重放",
        run: dangerousRun
      }), { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    const client = createRunClient("http://127.0.0.1:41731");

    const conflict = await client.resumeFromCheckpoint("run-1");
    expect(conflict.canContinue).toBe(false);
    expect(conflict.conflict).toBe(true);
    expect(conflict.run.status).toBe("paused");
    expect(conflict.reason).toContain("外部修改");

    const dangerous = await client.resumeFromCheckpoint("run-1", { approveDangerousReplay: false });
    expect(dangerous.canContinue).toBe(false);
    expect(dangerous.requiresDangerousReapproval).toBe(true);
    expect(dangerous.run.checkpointRecovery?.status).toBe("awaiting_dangerous_reapproval");
  });
});
