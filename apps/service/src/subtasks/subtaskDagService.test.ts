import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canStartNow,
  computeFrontierIds,
  inferAccessMode,
  SubtaskDagService
} from "./subtaskDagService.js";
import type { Subtask, SubtaskDag } from "./subtaskTypes.js";

describe("Subtask DAG orchestration (Task 21)", () => {
  let root: string;
  let statePath: string;
  let service: SubtaskDagService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-subtasks-"));
    statePath = join(root, "subtasks.json");
    service = await SubtaskDagService.open(statePath);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lands plan steps as independent subtasks with capabilities, I/O, deps, permissions, and acceptance", async () => {
    const dag = await service.createFromApprovedPlan({
      runId: "run-1",
      planVersion: 1,
      planApproved: true,
      autoSchedule: false,
      taskType: "implementation",
      requiredCapabilities: ["workspace", "filesystem", "shell", "tests"],
      acceptanceCriteria: ["功能可用", "测试通过"],
      expectedArtifacts: ["src/feature.ts"],
      allowedScope: ["src/**"],
      steps: [
        "确认目标、范围、假设与禁止项。",
        "检查现有实现并在批准范围内完成最小功能改动。",
        "按验收标准运行最小必要验证并记录结果。"
      ]
    });

    expect(dag.subtasks).toHaveLength(3);
    for (const sub of dag.subtasks) {
      expect(sub.requiredCapabilities).toEqual(
        expect.arrayContaining(["workspace", "filesystem", "shell", "tests"])
      );
      expect(sub.inputs.length).toBeGreaterThan(0);
      expect(sub.outputs.length).toBeGreaterThan(0);
      expect(sub.permissions.workspace).toMatch(/project_only|read_only/);
      expect(sub.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(sub.planVersion).toBe(1);
      expect(sub.runId).toBe("run-1");
    }
    // Linear deps for write-oriented plan
    expect(dag.subtasks[0]!.dependsOn).toEqual([]);
    expect(dag.subtasks[1]!.dependsOn).toEqual([dag.subtasks[0]!.id]);
    expect(dag.subtasks[2]!.dependsOn).toEqual([dag.subtasks[1]!.id]);
    // Final step inherits plan acceptance criteria
    expect(dag.subtasks[2]!.acceptanceCriteria).toEqual(
      expect.arrayContaining(["功能可用", "测试通过"])
    );
  });

  it("only completed-deps subtasks enter the execution frontier; fail/block stop downstream", async () => {
    const dag = await service.createFromApprovedPlan({
      runId: "run-frontier",
      planVersion: 1,
      planApproved: true,
      autoSchedule: false,
      steps: ["步骤 A 写入", "步骤 B 写入", "步骤 C 写入"]
    });

    expect(service.getFrontier("run-frontier")).toEqual([dag.subtasks[0]!.id]);
    expect(dag.subtasks[1]!.status).toBe("pending");
    expect(dag.subtasks[2]!.status).toBe("pending");

    await service.schedule("run-frontier");
    await service.completeSubtask("run-frontier", dag.subtasks[0]!.id, { artifacts: ["a.txt"] });

    const afterA = service.getByRunId("run-frontier");
    expect(afterA.subtasks[0]!.status).toBe("completed");
    expect(afterA.subtasks[0]!.artifacts).toContain("a.txt");
    expect(service.getFrontier("run-frontier")).toEqual([dag.subtasks[1]!.id]);

    // Fail B → C blocked
    await service.schedule("run-frontier");
    await service.failSubtask("run-frontier", dag.subtasks[1]!.id, { error: "编译失败" });
    const afterFail = service.getByRunId("run-frontier");
    expect(afterFail.subtasks[1]!.status).toBe("failed");
    expect(afterFail.subtasks[1]!.error).toBe("编译失败");
    expect(afterFail.subtasks[2]!.status).toBe("blocked");
    expect(afterFail.subtasks[2]!.blockedReason).toMatch(/阻止下游/);
    expect(service.getFrontier("run-frontier")).toEqual([]);
  });

  it("pause on fail blocks downstream without clearing completed work", async () => {
    const created = await service.createFromApprovedPlan({
      runId: "run-pause",
      planVersion: 1,
      planApproved: true,
      autoSchedule: false,
      steps: ["写模块", "集成", "发布"]
    });
    await service.schedule("run-pause");
    await service.completeSubtask("run-pause", created.subtasks[0]!.id);
    await service.schedule("run-pause");
    await service.failSubtask("run-pause", created.subtasks[1]!.id, {
      error: "需要用户确认 API 密钥",
      pause: true
    });

    const dag = service.getByRunId("run-pause");
    expect(dag.subtasks[0]!.status).toBe("completed");
    expect(dag.subtasks[1]!.status).toBe("paused");
    expect(dag.subtasks[2]!.status).toBe("blocked");
    expect(dag.status).toBe("paused");
  });

  it("serializes write subtasks and allows controlled parallel for read-only tasks", async () => {
    const dag = await service.createFromApprovedPlan({
      runId: "run-parallel",
      planVersion: 1,
      planApproved: true,
      autoSchedule: false,
      taskType: "research",
      explicitSubtasks: [
        {
          id: "gather-a",
          title: "调研模块 A 证据",
          accessMode: "read_only",
          dependsOn: []
        },
        {
          id: "gather-b",
          title: "调研模块 B 证据",
          accessMode: "read_only",
          dependsOn: []
        },
        {
          id: "write-report",
          title: "撰写调研结论",
          accessMode: "write",
          dependsOn: ["gather-a", "gather-b"]
        }
      ]
    });

    expect(dag.subtasks.filter((s) => s.accessMode === "read_only")).toHaveLength(2);
    const scheduled = await service.schedule("run-parallel");
    // Both read-only ready tasks should start together
    expect(scheduled.started.sort()).toEqual(["gather-a", "gather-b"].sort());
    const running = service.getByRunId("run-parallel");
    expect(running.subtasks.find((s) => s.id === "gather-a")!.status).toBe("running");
    expect(running.subtasks.find((s) => s.id === "gather-b")!.status).toBe("running");
    expect(running.subtasks.find((s) => s.id === "write-report")!.status).toBe("pending");

    await service.completeSubtask("run-parallel", "gather-a");
    await service.completeSubtask("run-parallel", "gather-b");
    // autoSchedule is off — write task is ready after both deps complete
    expect(service.getByRunId("run-parallel").subtasks.find((s) => s.id === "write-report")!.status).toBe("ready");
    await service.schedule("run-parallel");
    const afterReads = service.getByRunId("run-parallel");
    expect(afterReads.subtasks.find((s) => s.id === "write-report")!.status).toBe("running");
  });

  it("keeps default write tasks serial (max one running write)", async () => {
    const dag = await service.createFromApprovedPlan({
      runId: "run-serial-write",
      planVersion: 1,
      planApproved: true,
      autoSchedule: false,
      explicitSubtasks: [
        { id: "w1", title: "实现功能 A", accessMode: "write", dependsOn: [] },
        { id: "w2", title: "实现功能 B", accessMode: "write", dependsOn: [] }
      ]
    });

    const first = await service.schedule("run-serial-write");
    expect(first.started).toHaveLength(1);
    const runningWrites = service
      .getByRunId("run-serial-write")
      .subtasks.filter((s) => s.status === "running" && s.accessMode === "write");
    expect(runningWrites).toHaveLength(1);

    // Pure helper also enforces serial write
    const snap = service.getByRunId("run-serial-write");
    const other = snap.subtasks.find((s) => s.status === "ready")!;
    expect(canStartNow(snap, other)).toBe(false);

    void dag;
  });

  it("allows controlled parallel write only for independent worktree subtasks", async () => {
    await service.createFromApprovedPlan({
      runId: "run-wt",
      planVersion: 1,
      planApproved: true,
      autoSchedule: false,
      maxParallelIndependentWrite: 2,
      explicitSubtasks: [
        {
          id: "wt-a",
          title: "在独立 Worktree 实现 A",
          accessMode: "write",
          independentWorktree: true,
          dependsOn: []
        },
        {
          id: "wt-b",
          title: "在独立 Worktree 实现 B",
          accessMode: "write",
          independentWorktree: true,
          dependsOn: []
        }
      ]
    });

    const scheduled = await service.schedule("run-wt");
    expect(scheduled.started.sort()).toEqual(["wt-a", "wt-b"].sort());
  });

  it("auto-schedules after plan approve without manual continue per step", async () => {
    const dag = await service.createFromApprovedPlan({
      runId: "run-auto",
      planVersion: 2,
      planApproved: true,
      autoSchedule: true,
      steps: ["确认目标与范围", "实现最小改动", "运行验证"]
    });

    // First frontier task already running after create
    expect(dag.subtasks[0]!.status).toBe("running");
    expect(dag.autoSchedule).toBe(true);

    await service.completeSubtask("run-auto", dag.subtasks[0]!.id);
    const mid = service.getByRunId("run-auto");
    // Completing auto-advances next step without a separate schedule call from user
    expect(mid.subtasks[1]!.status).toBe("running");

    await service.completeSubtask("run-auto", dag.subtasks[1]!.id);
    await service.completeSubtask("run-auto", dag.subtasks[2]!.id);
    const done = service.getByRunId("run-auto");
    expect(done.status).toBe("completed");
    expect(done.subtasks.every((s) => s.status === "completed")).toBe(true);
  });

  it("tracks agent instance, start/end times, artifacts, and errors for PWA visibility", async () => {
    const dag = await service.createFromApprovedPlan({
      runId: "run-vis",
      planVersion: 1,
      planApproved: true,
      autoSchedule: true,
      routingSelections: [
        {
          instanceId: "step-1",
          roleId: "role-impl",
          name: "实现者",
          harness: "api",
          modelId: "gpt-5",
          source: "role",
          skills: ["implement"],
          tools: ["filesystem"]
        }
      ],
      steps: ["实现功能", "验证"]
    });

    expect(dag.subtasks[0]!.agentInstance?.name).toBe("实现者");
    expect(dag.subtasks[0]!.agentInstance?.modelId).toBe("gpt-5");
    expect(dag.subtasks[0]!.startedAt).toBeTruthy();

    await service.completeSubtask("run-vis", dag.subtasks[0]!.id, {
      artifacts: ["src/a.ts"],
      summary: "完成实现"
    });
    const mid = service.getByRunId("run-vis");
    expect(mid.subtasks[0]!.completedAt).toBeTruthy();
    expect(mid.subtasks[0]!.artifacts).toContain("src/a.ts");

    await service.failSubtask("run-vis", dag.subtasks[1]!.id, { error: "测试失败" });
    const failed = service.getSubtask("run-vis", dag.subtasks[1]!.id);
    expect(failed.error).toBe("测试失败");
    expect(failed.status).toBe("failed");
  });

  it("scopes minor correction to related unfinished subtasks only", async () => {
    const created = await service.createFromApprovedPlan({
      runId: "run-corr",
      planVersion: 1,
      planApproved: true,
      autoSchedule: false,
      steps: ["步骤1 写入", "步骤2 写入", "步骤3 写入"]
    });
    await service.schedule("run-corr");
    await service.completeSubtask("run-corr", created.subtasks[0]!.id);

    const result = await service.applyCorrection("run-corr", {
      note: "调整第2步输出格式",
      major: false,
      relatedSubtaskIds: [created.subtasks[1]!.id]
    });

    expect(result.needsAskReplan).toBe(false);
    expect(result.affectedSubtaskIds).toEqual([created.subtasks[1]!.id]);
    const dag = service.getByRunId("run-corr");
    expect(dag.subtasks[0]!.status).toBe("completed"); // untouched
    expect(dag.subtasks[1]!.correctionNotes).toContain("调整第2步输出格式");
    // step3 not in related list — should not get correction notes
    expect(dag.subtasks[2]!.correctionNotes).toEqual([]);
  });

  it("major correction triggers AskReplan signal and pauses related unfinished work", async () => {
    const created = await service.createFromApprovedPlan({
      runId: "run-replan",
      planVersion: 1,
      planApproved: true,
      autoSchedule: true,
      steps: ["A", "B", "C"]
    });

    const result = await service.applyCorrection("run-replan", {
      note: "整体改用另一架构",
      major: true
    });

    expect(result.needsAskReplan).toBe(true);
    expect(result.replanFeedback).toBe("整体改用另一架构");
    const dag = service.getByRunId("run-replan");
    expect(dag.status).toBe("awaiting_replan");
    expect(dag.needsAskReplan).toBe(true);
    // Schedule must not advance while awaiting replan
    const tick = await service.schedule("run-replan");
    expect(tick.started).toEqual([]);
    void created;
  });

  it("checkpoint resume rebuilds DAG state and continues from current frontier", async () => {
    const created = await service.createFromApprovedPlan({
      runId: "run-ckpt",
      planVersion: 1,
      planApproved: true,
      autoSchedule: false,
      steps: ["准备", "实现", "验证"]
    });
    await service.schedule("run-ckpt");
    await service.completeSubtask("run-ckpt", created.subtasks[0]!.id);
    await service.schedule("run-ckpt");
    // Simulate mid-flight interruption on step 2
    expect(service.getByRunId("run-ckpt").subtasks[1]!.status).toBe("running");

    await service.saveCheckpoint("run-ckpt", "service restart");

    // Re-open from disk (simulates process restart)
    const reopened = await SubtaskDagService.open(statePath);
    const resume = await reopened.resumeFromCheckpoint("run-ckpt");
    expect(resume.resumed).toBe(true);
    expect(resume.frontier).toContain(created.subtasks[1]!.id);
    // Interrupted running step returned to frontier and re-started
    expect(resume.dag.subtasks[0]!.status).toBe("completed");
    expect(resume.dag.subtasks[1]!.status).toBe("running");
    expect(resume.dag.subtasks[2]!.status).toBe("pending");
  });

  it("persists DAG to subtasks.json keyed by runId across reopen", async () => {
    await service.createFromApprovedPlan({
      runId: "run-persist",
      planVersion: 3,
      planApproved: true,
      autoSchedule: false,
      steps: ["一步"]
    });

    const raw = JSON.parse(await readFile(statePath, "utf8")) as {
      schemaVersion: number;
      dags: Array<{ runId: string; planVersion: number }>;
    };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.dags).toHaveLength(1);
    expect(raw.dags[0]!.runId).toBe("run-persist");
    expect(raw.dags[0]!.planVersion).toBe(3);

    const reopened = await SubtaskDagService.open(statePath);
    expect(reopened.getByRunId("run-persist").planVersion).toBe(3);
  });

  it("rejects create without plan approval", async () => {
    await expect(
      service.createFromApprovedPlan({
        runId: "run-x",
        planVersion: 1,
        planApproved: false,
        steps: ["x"]
      })
    ).rejects.toThrow(/approved plan/i);
  });

  it("inferAccessMode classifies research vs write steps", () => {
    expect(inferAccessMode("调研现有模块证据", "research")).toBe("read_only");
    expect(inferAccessMode("实现最小功能改动", "implementation")).toBe("write");
    expect(inferAccessMode("分析依赖关系", "analysis")).toBe("read_only");
  });

  it("computeFrontierIds only includes tasks with all deps completed", () => {
    const subtasks: Subtask[] = [
      stubSubtask({ id: "a", status: "completed", dependsOn: [] }),
      stubSubtask({ id: "b", status: "pending", dependsOn: ["a"] }),
      stubSubtask({ id: "c", status: "pending", dependsOn: ["b"] })
    ];
    expect(computeFrontierIds(subtasks)).toEqual(["b"]);
    subtasks[1]!.status = "failed";
    // failed tasks are not frontier; c not ready either
    expect(computeFrontierIds(subtasks)).toEqual([]);
  });
});

function stubSubtask(overrides: Partial<Subtask> & Pick<Subtask, "id" | "status" | "dependsOn">): Subtask {
  return {
    runId: "r",
    planVersion: 1,
    stepIndex: 0,
    title: overrides.id,
    requiredCapabilities: [],
    inputs: [],
    outputs: [],
    permissions: { workspace: "project_only", network: false, shell: false, externalSend: false },
    acceptanceCriteria: [],
    accessMode: "write",
    independentWorktree: false,
    artifacts: [],
    correctionNotes: [],
    ...overrides
  };
}

// silence unused type import lint if any
void (null as unknown as SubtaskDag);
