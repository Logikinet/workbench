import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtaskDagService } from "../subtasks/subtaskDagService.js";
import type { Run } from "../runs/runService.js";
import { orchestrateAfterPlanApproval } from "./postPlanOrchestrator.js";

describe("post-plan orchestrator (auto-start after plan approve)", () => {
  let root: string;
  let subtasks: SubtaskDagService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-orch-"));
    subtasks = await SubtaskDagService.open(join(root, "subtasks.json"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function approvedRun(overrides: Partial<Run> = {}): Run {
    return {
      id: "run-1",
      todoId: "todo-1",
      attempt: 1,
      status: "queued",
      messages: [],
      planVersions: [
        {
          version: 1,
          summary: "实现功能",
          steps: ["调研现有代码", "实现并自测"],
          risks: [],
          prohibitions: [],
          verificationCommands: [["npm", "test"]],
          createdAt: new Date().toISOString()
        }
      ],
      planning: {
        assessment: {
          taskType: "implementation",
          requiredCapabilities: ["implement", "filesystem"],
          criticalInputs: [],
          assumptions: [],
          complexity: "medium"
        },
        approvalStatus: "approved",
        approvedPlanVersion: 1,
        verificationCommands: [["npm", "test"]]
      },
      logs: [],
      reviews: [],
      artifacts: [],
      approvals: [],
      timeline: [],
      execution: { status: "idle" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides
    } as Run;
  }

  it("creates DAG, schedules frontier, and starts one executor", async () => {
    const professionalAgents = {
      start: vi.fn().mockResolvedValue({ id: "run-1" })
    };
    const codexCli = {
      start: vi.fn().mockResolvedValue({ id: "run-1" })
    };

    const result = await orchestrateAfterPlanApproval(approvedRun(), {
      subtasks,
      professionalAgents,
      codexCli
    });

    expect(result.dagCreated).toBe(true);
    expect(result.scheduled.length).toBeGreaterThan(0);
    // First frontier step is research-like → may start api; implementation steps may prefer codex
    expect(result.startedAgents.length + result.errors.length).toBeGreaterThan(0);
    expect(professionalAgents.start.mock.calls.length + codexCli.start.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("does not undo plan approval when agent start fails", async () => {
    const result = await orchestrateAfterPlanApproval(approvedRun(), {
      subtasks,
      professionalAgents: {
        start: vi.fn().mockRejectedValue(new Error("no role"))
      },
      codexCli: {
        start: vi.fn().mockRejectedValue(new Error("codex missing"))
      }
    });

    expect(result.dagCreated).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
