import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../http/app.js";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { RunService } from "../runs/runService.js";
import { TodoService } from "../todos/todoService.js";
import { isSubstantialPlanRevision } from "../planning/planDiff.js";

describe("AskUser HTTP + Run persistence (task 19)", () => {
  let root: string;
  let todos: TodoService;
  let runs: RunService;
  let todoId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-ask-user-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const projects = await ProjectService.open(
      join(root, "projects.json"),
      new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath })
    );
    todos = await TodoService.open(join(root, "todos.json"), projects);
    todoId = (await todos.create({ title: "需要澄清的任务" })).id;
    runs = await RunService.open(join(root, "runs.json"), todos);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates waiting_for_user AskUser on missing critical input and resumes after answer", async () => {
    const app = createApp({ version: "0.1.0", todos, runs });
    const created = await request(app).post(`/api/todos/${todoId}/runs`).send({}).expect(201);
    expect(created.body.status).toBe("waiting_for_user");
    expect(created.body.askUserRequests.some((entry: { status: string }) => entry.status === "pending")).toBe(true);

    const listed = await request(app).get(`/api/runs/${created.body.id}/ask-user`).expect(200);
    expect(listed.body.pending).toHaveLength(1);
    const requestId = listed.body.pending[0].id as string;

    // Restart service — unanswered card must still be present.
    const reopened = await RunService.open(join(root, "runs.json"), todos);
    const afterRestart = await reopened.get(created.body.id);
    expect(afterRestart.status).toBe("waiting_for_user");
    expect(afterRestart.askUserRequests.some((entry) => entry.id === requestId && entry.status === "pending")).toBe(true);

    const app2 = createApp({ version: "0.1.0", todos, runs: reopened });
    const answered = await request(app2)
      .post(`/api/runs/${created.body.id}/ask-user/${requestId}/answer`)
      .send({ freeText: "预期成果：可登录的用户会话与回归测试通过。" })
      .expect(200);

    expect(answered.body.status).toBe("awaiting_plan_approval");
    expect(answered.body.planVersions).toHaveLength(1);
    expect(answered.body.timeline.some((event: { kind: string }) => event.kind === "ask_user")).toBe(true);
  });

  it("supports AskApproval and AskReplan semantics via API", async () => {
    const app = createApp({ version: "0.1.0", todos, runs });
    const created = await request(app)
      .post(`/api/todos/${todoId}/runs`)
      .send({ message: "修复登录回归并添加测试。" })
      .expect(201);

    const approval = await request(app)
      .post(`/api/runs/${created.body.id}/ask-user`)
      .send({
        kind: "ask_approval",
        prompt: "是否允许删除临时缓存？",
        reason: "危险操作需确认",
        inputMode: "single_select",
        options: [{ id: "yes", label: "批准" }, { id: "no", label: "拒绝" }],
        source: { agent: "professional_agent", stepKey: "execution.delete_cache" }
      })
      .expect(201);
    expect(approval.body.status).toBe("waiting_for_user");

    const replan = await request(app)
      .post(`/api/runs/${created.body.id}/ask-user`)
      .send({
        kind: "ask_replan",
        prompt: "请说明计划修订要求",
        reason: "用户请求重规划",
        inputMode: "free_text",
        source: { agent: "secondmate", stepKey: "planning.replan" },
        forceQueue: true
      })
      .expect(201);
    const queuedReplan = (replan.body.askUserRequests as Array<{ kind: string; status: string; id: string }>)
      .find((entry) => entry.kind === "ask_replan");
    expect(queuedReplan?.status).toBe("queued");

    // Answer approval first (pending), then replan is promoted.
    const pendingApproval = (replan.body.askUserRequests as Array<{ kind: string; status: string; id: string }>)
      .find((entry) => entry.kind === "ask_approval" && entry.status === "pending");
    expect(pendingApproval).toBeDefined();

    const afterApproval = await request(app)
      .post(`/api/runs/${created.body.id}/ask-user/${pendingApproval!.id}/answer`)
      .send({ approved: true, selectedOptionIds: ["yes"] })
      .expect(200);
    const pendingReplan = (afterApproval.body.askUserRequests as Array<{ kind: string; status: string; id: string }>)
      .find((entry) => entry.kind === "ask_replan" && entry.status === "pending");
    expect(pendingReplan).toBeDefined();

    const afterReplan = await request(app)
      .post(`/api/runs/${created.body.id}/ask-user/${pendingReplan!.id}/answer`)
      .send({ freeText: "增加回归范围并收紧禁止修改的目录" })
      .expect(200);
    expect(afterReplan.body.planVersions.length).toBeGreaterThanOrEqual(2);
    const latest = afterReplan.body.planVersions.at(-1);
    expect(latest.diffFromPrevious).toBeDefined();
    expect(isSubstantialPlanRevision(latest.diffFromPrevious)).toBe(true);
  });

  it("records substantial plan revision diffs when a plan is returned", async () => {
    const run = await runs.create(todoId, "修复登录回归并添加测试。");
    expect(run.planVersions).toHaveLength(1);

    const returned = await runs.decidePlan(run.id, {
      decision: "returned",
      summary: "补充回归场景与会话风险说明，并增加测试步骤。"
    });
    expect(returned.planVersions).toHaveLength(2);
    const next = returned.planVersions[1]!;
    expect(next.revisionNote).toMatch(/回归/);
    expect(next.diffFromPrevious).toBeDefined();
    expect(next.diffFromPrevious!.changedFieldCount).toBeGreaterThan(0);
    expect(isSubstantialPlanRevision(next.diffFromPrevious!)).toBe(true);
  });
});
