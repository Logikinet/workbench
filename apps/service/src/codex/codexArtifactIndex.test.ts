import { describe, expect, it } from "vitest";
import {
  assessWorktreeArtifactConsistency,
  buildWorktreeEvidence,
  findCodexWorktreeEvidence,
  toVerificationEvidence
} from "./codexArtifactIndex.js";
import {
  CODEX_WORKTREE_EVIDENCE_KIND,
  type Run,
  type WorktreeArtifactEvidence
} from "../runs/runService.js";

function sampleEvidence(overrides: Partial<WorktreeArtifactEvidence> = {}): WorktreeArtifactEvidence {
  return {
    source: "codex-worktree",
    worktreeRunId: "run-1",
    worktreePath: "C:\\wt\\run-1",
    baselineCommit: "abc",
    sessionStatus: "active",
    changeStatus: "modified",
    discarded: false,
    changedFiles: ["src/a.ts"],
    diff: "diff --git a/src/a.ts b/src/a.ts\n",
    verificationResults: [{ command: ["npm", "test"], exitCode: 0, stdout: "ok", stderr: "", passed: true }],
    summary: "Codex Worktree 索引",
    consistency: "ok",
    ...overrides
  };
}

function sampleRun(evidence: WorktreeArtifactEvidence): Run {
  return {
    id: "run-1",
    todoId: "todo-1",
    attempt: 1,
    status: "awaiting_review",
    messages: [],
    planVersions: [],
    execution: { status: "succeeded", completedSteps: [], retryable: false, failureCounts: {}, maxConsecutiveFailures: 2 },
    logs: [],
    reviews: [],
    approvals: [],
    artifacts: [{
      id: "art-1",
      path: "worktree/run-1",
      kind: CODEX_WORKTREE_EVIDENCE_KIND,
      createdAt: "2026-01-01T00:00:00.000Z",
      evidence
    }],
    checkpoints: [],
    askUserRequests: [],
    timeline: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("codexArtifactIndex", () => {
  it("builds structured verification with passed flags from exit codes", () => {
    expect(toVerificationEvidence([
      { command: ["npm", "test"], exitCode: 0, stdout: "ok", stderr: "" },
      { command: ["npm", "run", "build"], exitCode: 1, stdout: "", stderr: "fail" }
    ])).toEqual([
      { command: ["npm", "test"], exitCode: 0, stdout: "ok", stderr: "", passed: true },
      { command: ["npm", "run", "build"], exitCode: 1, stdout: "", stderr: "fail", passed: false }
    ]);
  });

  it("marks no_modification without inventing changed files", () => {
    const evidence = buildWorktreeEvidence({
      runId: "run-1",
      sessionStatus: "active",
      changedFiles: [],
      diff: "",
      verificationResults: [],
      outcome: "success"
    });
    expect(evidence.changeStatus).toBe("no_modification");
    expect(evidence.changedFiles).toEqual([]);
    expect(evidence.diff).toBe("");
    expect(evidence.summary).toContain("无实际修改");
  });

  it("detects missing worktree after restart vs retained evidence", () => {
    const run = sampleRun(sampleEvidence());
    const missing = assessWorktreeArtifactConsistency(run, null);
    expect(missing).toMatchObject({
      needsUpdate: true,
      sessionStatus: "missing",
      consistency: "missing_worktree"
    });
    expect(missing.consistencyNote).toMatch(/缺失|恢复/);

    const ok = assessWorktreeArtifactConsistency(run, { status: "active" });
    expect(ok.needsUpdate).toBe(false);

    const discarded = assessWorktreeArtifactConsistency(run, { status: "discarded" });
    expect(discarded).toMatchObject({ needsUpdate: true, sessionStatus: "discarded" });
  });

  it("finds the normalized evidence bundle on a Run", () => {
    const evidence = sampleEvidence();
    expect(findCodexWorktreeEvidence(sampleRun(evidence))).toEqual(evidence);
  });
});
