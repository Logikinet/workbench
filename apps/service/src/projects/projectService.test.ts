import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../http/app.js";
import { RunService } from "../runs/runService.js";
import { TodoService } from "../todos/todoService.js";
import { ProjectService } from "./projectService.js";
import { AgentWorkspace } from "./agentWorkspace.js";
import { WorkspaceAuthorizer } from "./workspaceAuthorization.js";

describe("Project main-workspace contract", () => {
  let root: string;
  let workspace: string;
  let statePath: string;
  let projects: ProjectService;
  let authorizer: WorkspaceAuthorizer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-projects-"));
    workspace = join(root, "main-workspace");
    statePath = join(root, "state.json");
    await mkdir(workspace);
    authorizer = new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath });
    projects = await ProjectService.open(statePath, authorizer);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates, renames, archives and reopens a Project bound to one explicitly authorized workspace", async () => {
    const app = createApp({ version: "0.1.0", projects });
    const authorization = await request(app)
      .post("/api/workspace-authorizations")
      .send({ workspacePath: workspace })
      .expect(201);
    const created = await request(app)
      .post("/api/projects")
      .send({
        name: "Workbench",
        workspacePath: workspace,
        authorizationGrantId: authorization.body.id,
        summary: "本地 Harness"
      })
      .expect(201);

    expect(created.body).toMatchObject({
      name: "Workbench",
      workspacePath: workspace,
      summary: "本地 Harness",
      status: "active"
    });

    const renamed = await request(app)
      .patch(`/api/projects/${created.body.id}`)
      .send({ name: "Workbench v2" })
      .expect(200);
    expect(renamed.body.name).toBe("Workbench v2");

    await request(app).patch(`/api/projects/${created.body.id}`).send({ status: "archived" }).expect(200);
    await request(app).patch(`/api/projects/${created.body.id}`).send({ status: "active" }).expect(200);
    const listed = await request(app).get("/api/projects").expect(200);
    expect(listed.body).toEqual([expect.objectContaining({ id: created.body.id, status: "active" })]);
  });

  it("persists the workspace association and project summary after a service restart", async () => {
    const created = await projects.create({
      name: "Persistent project",
      workspacePath: workspace,
      authorizationGrantId: (await projects.requestWorkspaceAuthorization(workspace)).id,
      summary: "kept after restart"
    });

    const restarted = await ProjectService.open(statePath, authorizer);
    expect(await restarted.get(created.id)).toMatchObject({
      id: created.id,
      workspacePath: workspace,
      summary: "kept after restart"
    });
  });

  it("rejects an unapproved or inaccessible workspace and denies agent access outside the approved main workspace", async () => {
    await expect(
      projects.create({ name: "No approval", workspacePath: workspace, authorizationGrantId: "not-a-picker-grant" })
    ).rejects.toThrow("explicitly confirm");
    await expect(
      projects.create({
        name: "Missing",
        workspacePath: join(root, "missing"),
        authorizationGrantId: "missing-grant"
      })
    ).rejects.toThrow("not accessible");

    const project = await projects.create({
      name: "Scoped",
      workspacePath: workspace,
      authorizationGrantId: (await projects.requestWorkspaceAuthorization(workspace)).id
    });
    await expect(projects.assertWorkspaceAccess(project.id, join(workspace, "notes.md"))).resolves.toEqual(
      join(workspace, "notes.md")
    );
    await expect(projects.assertWorkspaceAccess(project.id, join(root, "outside.md"))).rejects.toThrow(
      "outside the approved main workspace"
    );
    await expect(access(workspace)).resolves.toBeUndefined();
  });

  it("gives an Agent only a guarded file API rooted in the explicitly approved workspace", async () => {
    const project = await projects.create({
      name: "Guarded Agent",
      workspacePath: workspace,
      authorizationGrantId: (await projects.requestWorkspaceAuthorization(workspace)).id
    });
    const todos = await TodoService.open(join(root, "todos.json"), projects);
    const runs = await RunService.open(join(root, "runs.json"), todos);
    const todo = await todos.create({ title: "写入受保护成果", projectId: project.id });
    const run = await runs.create(todo.id, "在项目工作区写入验证文件。");
    const agentWorkspace = new AgentWorkspace(projects, project.id, run.id, runs);

    await writeFile(join(workspace, "source.txt"), "guarded input");
    await expect(agentWorkspace.readText(join(workspace, "source.txt"))).rejects.toThrow("approved plan");
    await expect(agentWorkspace.writeText(join(workspace, "artifact.txt"), "safe output")).rejects.toThrow("approved plan");
    await runs.decidePlan(run.id, { decision: "approved", summary: "批准写入。" });
    await expect(agentWorkspace.writeText(join(workspace, "artifact.txt"), "safe output")).rejects.toThrow("actively executing");
    await runs.beginProfessionalExecution(run.id, {
      source: "temporary",
      name: "受限文件 Agent",
      responsibility: "写入文件",
      systemInstruction: "仅写入工作区",
      connectionId: "connection-a",
      tools: ["filesystem"]
    });
    await agentWorkspace.writeText(join(workspace, "artifact.txt"), "safe output");
    await expect(readFile(join(workspace, "artifact.txt"), "utf8")).resolves.toBe("safe output");
    await expect(agentWorkspace.readText(join(workspace, "source.txt"))).resolves.toBe("guarded input");
    await expect(agentWorkspace.writeText(join(root, "outside.txt"), "must not write")).rejects.toThrow(
      "outside the approved main workspace"
    );
    await runs.pauseForConnection("connection-a", "模型连接已暂停");
    await expect(agentWorkspace.writeText(join(workspace, "after-pause.txt"), "must not write")).rejects.toThrow("paused");
    await expect(agentWorkspace.readText(join(workspace, "source.txt"))).rejects.toThrow("paused");
  });

  it("requires a one-time workspace grant produced by a user-facing workspace picker", async () => {
    const grant = await projects.requestWorkspaceAuthorization(workspace);
    await projects.create({ name: "Granted", workspacePath: workspace, authorizationGrantId: grant.id });

    await expect(
      projects.create({ name: "Replay", workspacePath: workspace, authorizationGrantId: grant.id })
    ).rejects.toThrow("explicitly confirm");
  });

  it("atomically consumes a workspace grant when concurrent callers race to use it", async () => {
    const grant = await projects.requestWorkspaceAuthorization(workspace);
    const attempts = await Promise.allSettled([
      authorizer.consume(grant.id, workspace),
      authorizer.consume(grant.id, workspace)
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });
});
