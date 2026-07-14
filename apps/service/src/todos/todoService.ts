import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProjectService } from "../projects/projectService.js";

export const todoStatuses = [
  "pending",
  "running",
  "awaiting_confirmation",
  "awaiting_acceptance",
  "completed"
] as const;

export type TodoStatus = (typeof todoStatuses)[number];

export interface Todo {
  id: string;
  title: string;
  description?: string;
  projectId?: string;
  status: TodoStatus;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTodoInput {
  title: string;
  description?: string;
  projectId?: string;
}

export interface UpdateTodoInput {
  title?: string;
  description?: string;
  projectId?: string | null;
  status?: TodoStatus;
  archived?: boolean;
  /** Internal: only formal review acceptance may mark a Todo completed. */
  formalAcceptance?: boolean;
}

export interface TodoFilter {
  status?: TodoStatus;
  query?: string;
  archived?: boolean;
}

interface TodoState {
  schemaVersion: 1;
  todos: Todo[];
}

export interface TodoStateSnapshot {
  schemaVersion: 1;
  todos: Todo[];
}

function emptyState(): TodoState {
  return { schemaVersion: 1, todos: [] };
}

export class TodoService {
  private constructor(
    private readonly statePath: string,
    private state: TodoState,
    private readonly projects: ProjectService
  ) {}

  static async open(statePath: string, projects: ProjectService): Promise<TodoService> {
    try {
      const decoded = JSON.parse(await readFile(statePath, "utf8")) as Partial<TodoState>;
      if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.todos)) {
        throw new Error("Todo state is not compatible with this service version.");
      }
      return new TodoService(statePath, decoded as TodoState, projects);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return new TodoService(statePath, emptyState(), projects);
      }
      throw error;
    }
  }

  async list(filter: TodoFilter = {}): Promise<Todo[]> {
    const query = filter.query?.trim().toLocaleLowerCase();
    return this.state.todos
      .filter((todo) => (filter.archived === true ? todo.archived : !todo.archived))
      .filter((todo) => (filter.status ? todo.status === filter.status : true))
      .filter((todo) =>
        query ? `${todo.title}\n${todo.description ?? ""}`.toLocaleLowerCase().includes(query) : true
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(todoId: string): Promise<Todo> {
    const todo = this.state.todos.find((entry) => entry.id === todoId);
    if (!todo) throw new Error(`Todo ${todoId} was not found.`);
    return todo;
  }

  /** Full durable snapshot for backup export (including archived Todos). */
  async exportSnapshot(): Promise<TodoStateSnapshot> {
    return {
      schemaVersion: 1,
      todos: structuredClone(this.state.todos)
    };
  }

  /** Replace all Todos from a validated backup snapshot. */
  async importSnapshot(snapshot: TodoStateSnapshot): Promise<void> {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.todos)) {
      throw new Error("Todo backup snapshot is not compatible with this service version.");
    }
    this.state = {
      schemaVersion: 1,
      todos: structuredClone(snapshot.todos)
    };
    await this.persist();
  }

  async create(input: CreateTodoInput): Promise<Todo> {
    const title = input.title.trim();
    if (!title) throw new Error("A Todo title is required.");
    if (input.projectId) await this.projects.get(input.projectId);

    const now = new Date().toISOString();
    const todo: Todo = {
      id: randomUUID(),
      title,
      description: input.description?.trim() || undefined,
      projectId: input.projectId || undefined,
      status: "pending",
      archived: false,
      createdAt: now,
      updatedAt: now
    };
    this.state.todos.push(todo);
    await this.persist();
    return todo;
  }

  async update(todoId: string, input: UpdateTodoInput): Promise<Todo> {
    const todo = await this.get(todoId);
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new Error("A Todo title is required.");
      todo.title = title;
    }
    if (input.description !== undefined) todo.description = input.description.trim() || undefined;
    if (input.projectId !== undefined) {
      if (input.projectId) await this.projects.get(input.projectId);
      todo.projectId = input.projectId || undefined;
    }
    if (input.status !== undefined) {
      if (!todoStatuses.includes(input.status)) throw new Error("Todo status is invalid.");
      if (input.status === "completed" && input.formalAcceptance !== true) {
        throw new Error("Todo completion requires formal acceptance after a passed independent review.");
      }
      todo.status = input.status;
    }
    if (input.archived !== undefined) todo.archived = input.archived;
    todo.updatedAt = new Date().toISOString();
    await this.persist();
    return todo;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: constants.S_IRUSR | constants.S_IWUSR
    });
    await rename(temporaryPath, this.statePath);
  }
}
