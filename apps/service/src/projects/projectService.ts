import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceAuthorization, WorkspaceAuthorizer, WorkspaceGrant } from "./workspaceAuthorization.js";

export type ProjectStatus = "active" | "archived";

/** Whether the bound main workspace directory is present on this machine after restore. */
export type WorkspaceLinkStatus = "linked" | "needs_repair";

/** todos-style GitHub repo binding on a Project. */
export interface ProjectGithubBinding {
  accountId: string;
  fullName: string;
  htmlUrl: string;
  private?: boolean;
  defaultBranch?: string;
  cloneUrl?: string;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string;
  summary?: string;
  authorization: WorkspaceAuthorization;
  status: ProjectStatus;
  /** Present after backup restore when the path may be missing on this PC. Defaults to linked. */
  workspaceLinkStatus?: WorkspaceLinkStatus;
  workspaceRepairNote?: string;
  /** When set, project is bound like todos GitHub-linked workspace. */
  github?: ProjectGithubBinding;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectStateSnapshot {
  schemaVersion: 1;
  projects: Project[];
}

export interface CreateProjectInput {
  name: string;
  workspacePath: string;
  summary?: string;
  authorizationGrantId: string;
  github?: ProjectGithubBinding;
}

export interface UpdateProjectInput {
  name?: string;
  summary?: string;
  status?: ProjectStatus;
}

interface ProjectState {
  schemaVersion: 1;
  projects: Project[];
}

function emptyState(): ProjectState {
  return { schemaVersion: 1, projects: [] };
}

function isInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

export class ProjectService {
  private constructor(
    private readonly statePath: string,
    private state: ProjectState,
    private readonly authorizer: WorkspaceAuthorizer
  ) {}

  static async open(statePath: string, authorizer: WorkspaceAuthorizer): Promise<ProjectService> {
    try {
      const decoded = JSON.parse(await readFile(statePath, "utf8")) as Partial<ProjectState>;
      if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.projects)) {
        throw new Error("Project state is not compatible with this service version.");
      }
      return new ProjectService(statePath, decoded as ProjectState, authorizer);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return new ProjectService(statePath, emptyState(), authorizer);
      }
      throw error;
    }
  }

  async list(): Promise<Project[]> {
    return [...this.state.projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(projectId: string): Promise<Project> {
    const project = this.state.projects.find((entry) => entry.id === projectId);
    if (!project) throw new Error(`Project ${projectId} was not found.`);
    return project;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const name = input.name.trim();
    if (!name) throw new Error("A Project name is required.");

    const workspacePath = await this.validateWorkspace(input.workspacePath);
    const authorization = await this.authorizer.consume(input.authorizationGrantId, workspacePath);
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name,
      workspacePath,
      summary: input.summary?.trim() || undefined,
      authorization,
      status: "active",
      workspaceLinkStatus: "linked",
      github: input.github,
      createdAt: now,
      updatedAt: now
    };
    this.state.projects.push(project);
    await this.persist();
    return project;
  }

  /**
   * Create project with internal authorization (GitHub clone / trusted local path).
   * Used by todos-style GitHub binding — no Windows folder picker grant required.
   */
  async createLinked(input: {
    name: string;
    workspacePath: string;
    summary?: string;
    github?: ProjectGithubBinding;
  }): Promise<Project> {
    const name = input.name.trim();
    if (!name) throw new Error("A Project name is required.");
    const workspacePath = await this.validateWorkspace(input.workspacePath);
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name,
      workspacePath,
      summary: input.summary?.trim() || undefined,
      authorization: { workspacePath, confirmedAt: now },
      status: "active",
      workspaceLinkStatus: "linked",
      github: input.github,
      createdAt: now,
      updatedAt: now
    };
    this.state.projects.push(project);
    await this.persist();
    return project;
  }

  /**
   * Local todos bootstrap: if no active project exists, create a sandboxed default
   * workspace under the service data directory so multi-agent runs can execute
   * without requiring a Windows folder picker first.
   */
  async ensureDefaultLocalProject(dataDirectory: string): Promise<Project> {
    const active = this.state.projects
      .filter((entry) => entry.status === "active")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (active[0]) return active[0];

    const workspacePath = resolve(dataDirectory, "default-workspace");
    await mkdir(workspacePath, { recursive: true });
    const validated = await this.validateWorkspace(workspacePath);
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name: "本机默认工作区",
      workspacePath: validated,
      summary: "本地自动创建：任务执行与多 Agent 编排的默认项目目录",
      authorization: { workspacePath: validated, confirmedAt: now },
      status: "active",
      workspaceLinkStatus: "linked",
      createdAt: now,
      updatedAt: now
    };
    this.state.projects.push(project);
    await this.persist();
    return project;
  }

  /** Full durable snapshot for backup export (index only — no project file contents). */
  async exportSnapshot(): Promise<ProjectStateSnapshot> {
    return {
      schemaVersion: 1,
      projects: structuredClone(this.state.projects)
    };
  }

  /** Replace project index from a validated backup snapshot. */
  async importSnapshot(snapshot: ProjectStateSnapshot): Promise<void> {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.projects)) {
      throw new Error("Project backup snapshot is not compatible with this service version.");
    }
    this.state = {
      schemaVersion: 1,
      projects: structuredClone(snapshot.projects)
    };
    await this.persist();
  }

  async update(projectId: string, input: UpdateProjectInput): Promise<Project> {
    const project = await this.get(projectId);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new Error("A Project name is required.");
      project.name = name;
    }
    if (input.summary !== undefined) project.summary = input.summary.trim() || undefined;
    if (input.status !== undefined) project.status = input.status;
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return project;
  }

  async assertWorkspaceAccess(projectId: string, targetPath: string): Promise<string> {
    const project = await this.get(projectId);
    const root = await realpath(project.workspacePath);
    const target = resolve(targetPath);
    if (!isInside(root, target)) throw new Error("Target is outside the approved main workspace.");

    const existingAncestor = await this.findExistingAncestor(target);
    if (!isInside(root, await realpath(existingAncestor))) {
      throw new Error("Target is outside the approved main workspace.");
    }
    return target;
  }

  async requestWorkspaceAuthorization(workspacePath: string): Promise<WorkspaceGrant> {
    return this.authorizer.request(workspacePath);
  }

  private async validateWorkspace(path: string): Promise<string> {
    try {
      await access(path, constants.R_OK | constants.W_OK);
      const info = await stat(path);
      if (!info.isDirectory()) throw new Error("not a directory");
      return await realpath(path);
    } catch {
      throw new Error("The selected main workspace is not accessible.");
    }
  }

  private async findExistingAncestor(target: string): Promise<string> {
    let candidate = target;
    while (true) {
      try {
        await stat(candidate);
        return candidate;
      } catch {
        const parent = dirname(candidate);
        if (parent === candidate) throw new Error("Target is outside the approved main workspace.");
        candidate = parent;
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }
}
