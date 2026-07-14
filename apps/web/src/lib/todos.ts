export const todoStatuses = [
  "pending",
  "running",
  "awaiting_confirmation",
  "awaiting_acceptance",
  "completed"
] as const;

export type TodoStatus = (typeof todoStatuses)[number];

export interface TodoRecord {
  id: string;
  title: string;
  description?: string;
  projectId?: string;
  status: TodoStatus;
  archived: boolean;
}

export interface UpdateTodoPayload {
  title?: string;
  description?: string;
  projectId?: string | null;
  status?: TodoStatus;
  archived?: boolean;
}

export interface TodoClient {
  list(filter?: { status?: TodoStatus; query?: string; archived?: boolean }): Promise<TodoRecord[]>;
  create(payload: { title: string; description?: string; projectId?: string }): Promise<TodoRecord>;
  update(id: string, payload: UpdateTodoPayload): Promise<TodoRecord>;
}

export interface TodoView {
  status: TodoStatus;
  showArchived: boolean;
  query?: string;
}

export function todoVisibleInView(todo: TodoRecord, view: TodoView): boolean {
  if (view.showArchived) return todo.archived;
  if (todo.archived || todo.status !== view.status) return false;
  const query = view.query?.trim().toLocaleLowerCase();
  return query ? `${todo.title}\n${todo.description ?? ""}`.toLocaleLowerCase().includes(query) : true;
}

export function createTodoClient(serviceUrl: string): TodoClient {
  const requestJson = createJsonRequest(serviceUrl);

  return {
    list: (filter = {}) => {
      const query = new URLSearchParams();
      if (filter.status) query.set("status", filter.status);
      if (filter.query) query.set("query", filter.query);
      if (filter.archived) query.set("archived", "true");
      const suffix = query.size > 0 ? `?${query}` : "";
      return requestJson<TodoRecord[]>(`/api/todos${suffix}`);
    },
    create: (payload) => requestJson<TodoRecord>("/api/todos", { method: "POST", body: JSON.stringify(payload) }),
    update: (id, payload) =>
      requestJson<TodoRecord>(`/api/todos/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      })
  };
}
import { createJsonRequest } from "./apiClient.js";
