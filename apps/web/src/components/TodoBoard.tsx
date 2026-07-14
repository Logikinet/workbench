import { useEffect, useState } from "react";
import { createProjectClient, type ProjectRecord } from "../lib/projects.js";
import {
  createTodoClient,
  todoStatuses,
  todoVisibleInView,
  type TodoRecord,
  type TodoStatus
} from "../lib/todos.js";
import { RunTimelinePanel } from "./RunTimelinePanel.js";

interface TodoBoardProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
}

const statusLabels: Record<TodoStatus, string> = {
  pending: "待处理",
  running: "运行中",
  awaiting_confirmation: "等待确认",
  awaiting_acceptance: "待验收",
  completed: "已完成"
};

export function TodoBoard({ serviceUrl, available, dataEpoch = 0 }: TodoBoardProps) {
  const todosClient = createTodoClient(serviceUrl);
  const projectsClient = createProjectClient(serviceUrl);
  const [todos, setTodos] = useState<TodoRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [status, setStatus] = useState<TodoStatus>("pending");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState({ title: "", description: "", projectId: "" });
  const [editing, setEditing] = useState<TodoRecord | null>(null);
  const [editDraft, setEditDraft] = useState({ title: "", description: "", projectId: "" });
  const [runTodo, setRunTodo] = useState<TodoRecord | null>(null);
  const [notice, setNotice] = useState("");

  const reload = async () => {
    if (!available) return;
    try {
      const [nextTodos, nextProjects] = await Promise.all([
        todosClient.list(showArchived ? { archived: true } : { status, query }),
        projectsClient.list()
      ]);
      setTodos(nextTodos);
      setProjects(nextProjects.filter((project) => project.status === "active"));
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取 Todo");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, status, query, showArchived, dataEpoch]);

  const createTodo = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const todo = await todosClient.create({
        title: draft.title,
        description: draft.description,
        projectId: draft.projectId || undefined
      });
      setDraft({ title: "", description: "", projectId: "" });
      if (!showArchived && todo.status === status) setTodos((current) => [todo, ...current]);
      setNotice("Todo 已创建。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法创建 Todo");
    }
  };

  const updateTodo = async (todo: TodoRecord, update: Parameters<typeof todosClient.update>[1]) => {
    try {
      const changed = await todosClient.update(todo.id, update);
      setTodos((current) => {
        if (!todoVisibleInView(changed, { status, showArchived, query })) {
          return current.filter((entry) => entry.id !== changed.id);
        }
        return current.map((entry) => (entry.id === changed.id ? changed : entry));
      });
      setNotice("Todo 已更新。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法更新 Todo");
    }
  };

  const edit = (todo: TodoRecord) => {
    setEditing(todo);
    setEditDraft({ title: todo.title, description: todo.description ?? "", projectId: todo.projectId ?? "" });
  };

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    await updateTodo(editing, {
      title: editDraft.title,
      description: editDraft.description,
      projectId: editDraft.projectId || null
    });
    setEditing(null);
  };

  return (
    <section className="workspace-panel" aria-labelledby="todos-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">TODOS</p>
          <h2 id="todos-title">任务看板</h2>
        </div>
        <button type="button" className="quiet-button" onClick={() => void reload()} disabled={!available}>刷新</button>
      </div>
      <form className="todo-form" onSubmit={createTodo}>
        <input required aria-label="Todo 标题" placeholder="快速创建 Todo" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        <input aria-label="Todo 描述" placeholder="可选描述" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
        <select aria-label="归属 Project" value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}>
          <option value="">暂不归属 Project</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <button type="submit" disabled={!available}>创建 Todo</button>
      </form>
      <div className="todo-toolbar">
        <div className="status-tabs" role="tablist" aria-label="Todo 状态">
          {todoStatuses.map((entry) => (
            <button key={entry} type="button" className={status === entry && !showArchived ? "active-tab" : "quiet-button"} onClick={() => { setShowArchived(false); setStatus(entry); }}>
              {statusLabels[entry]}
            </button>
          ))}
          <button type="button" className={showArchived ? "active-tab" : "quiet-button"} onClick={() => setShowArchived(true)}>已归档</button>
        </div>
        <input aria-label="搜索 Todo" placeholder="搜索" value={query} onChange={(event) => setQuery(event.target.value)} disabled={showArchived} />
      </div>
      {editing && (
        <form className="todo-edit-panel" onSubmit={saveEdit}>
          <strong>编辑 Todo</strong>
          <input required aria-label="编辑标题" value={editDraft.title} onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })} />
          <input aria-label="编辑描述" value={editDraft.description} onChange={(event) => setEditDraft({ ...editDraft, description: event.target.value })} />
          <select aria-label="编辑归属 Project" value={editDraft.projectId} onChange={(event) => setEditDraft({ ...editDraft, projectId: event.target.value })}>
            <option value="">暂不归属 Project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <div className="project-actions">
            <button type="submit">保存</button>
            <button type="button" className="quiet-button" onClick={() => setEditing(null)}>取消</button>
          </div>
        </form>
      )}
      {notice && <p className="notice" role="status">{notice}</p>}
      {runTodo && (
        <RunTimelinePanel
          serviceUrl={serviceUrl}
          todo={runTodo}
          onClose={() => setRunTodo(null)}
          onTodoChange={(changed) => {
            setRunTodo(changed);
            setTodos((current) => {
              if (!todoVisibleInView(changed, { status, showArchived, query })) {
                return current.filter((entry) => entry.id !== changed.id);
              }
              return current.some((entry) => entry.id === changed.id)
                ? current.map((entry) => (entry.id === changed.id ? changed : entry))
                : [changed, ...current];
            });
          }}
        />
      )}
      <ul className="todo-list">
        {todos.map((todo) => (
          <li key={todo.id}>
            <div>
              <strong>{todo.title}</strong>
              {todo.description && <small>{todo.description}</small>}
              <span>{showArchived ? "已归档" : statusLabels[todo.status]}</span>
            </div>
            <div className="project-actions">
              {!showArchived && (
                <select
                  aria-label={`${todo.title} 状态`}
                  value={todo.status}
                  onChange={(event) => void updateTodo(todo, { status: event.target.value as TodoStatus })}
                >
                  {todoStatuses
                    .filter((entry) => entry !== "completed" || todo.status === "completed")
                    .map((entry) => (
                      <option key={entry} value={entry} disabled={entry === "completed"}>
                        {statusLabels[entry]}{entry === "completed" ? "（需审查验收）" : ""}
                      </option>
                    ))}
                </select>
              )}
              <button type="button" className="quiet-button" onClick={() => setRunTodo(todo)}>Runs</button>
              <button type="button" className="quiet-button" onClick={() => edit(todo)}>编辑</button>
              <button type="button" className="quiet-button" onClick={() => void updateTodo(todo, { archived: !todo.archived })}>{todo.archived ? "恢复" : "归档"}</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
