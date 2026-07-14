import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../http/app.js";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { TodoService } from "./todoService.js";

describe("Todo board contract", () => {
  let root: string;
  let workspace: string;
  let projects: ProjectService;
  let todos: TodoService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-todos-"));
    workspace = join(root, "workspace");
    await mkdir(workspace);
    const authorizer = new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath });
    projects = await ProjectService.open(join(root, "projects.json"), authorizer);
    todos = await TodoService.open(join(root, "todos.json"), projects);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createProject() {
    const grant = await projects.requestWorkspaceAuthorization(workspace);
    return projects.create({ name: "Bound Project", workspacePath: workspace, authorizationGrantId: grant.id });
  }

  it("creates Todos with an optional Project and lists the five work states", async () => {
    const project = await createProject();
    const app = createApp({ version: "0.1.0", projects, todos });
    const attached = await request(app)
      .post("/api/todos")
      .send({ title: "修复登录", description: "保留验证步骤", projectId: project.id })
      .expect(201);
    const inbox = await request(app).post("/api/todos").send({ title: "稍后处理" }).expect(201);

    expect(attached.body).toMatchObject({
      title: "修复登录",
      projectId: project.id,
      status: "pending",
      archived: false
    });
    expect(inbox.body.projectId).toBeUndefined();
    const list = await request(app).get("/api/todos?status=pending").expect(200);
    expect(list.body).toHaveLength(2);
  });

  it("searches, filters, edits, archives and restores a Todo without losing its state", async () => {
    const todo = await todos.create({ title: "生成报告", description: "初稿" });
    const app = createApp({ version: "0.1.0", projects, todos });

    const edited = await request(app)
      .patch(`/api/todos/${todo.id}`)
      .send({ title: "生成最终报告", description: "含引用", status: "awaiting_acceptance" })
      .expect(200);
    expect(edited.body).toMatchObject({ title: "生成最终报告", status: "awaiting_acceptance" });

    const searched = await request(app).get("/api/todos?query=最终&status=awaiting_acceptance").expect(200);
    expect(searched.body).toEqual([expect.objectContaining({ id: todo.id })]);

    await request(app).patch(`/api/todos/${todo.id}`).send({ archived: true }).expect(200);
    await request(app).get("/api/todos").expect(200, []);
    await request(app).patch(`/api/todos/${todo.id}`).send({ archived: false }).expect(200);
    const restored = await request(app).get("/api/todos?status=awaiting_acceptance").expect(200);
    expect(restored.body).toEqual([expect.objectContaining({ id: todo.id })]);
  });

  it("restores Todos and their statuses after the workbench service restarts", async () => {
    const created = await todos.create({ title: "持久化任务" });
    await todos.update(created.id, { status: "running" });

    const restarted = await TodoService.open(join(root, "todos.json"), projects);
    expect(await restarted.get(created.id)).toMatchObject({ id: created.id, status: "running" });
  });
});
