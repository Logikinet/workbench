/**
 * todos.dev right drawer: panel=todo:id
 * Hosts RunTimeline (plan / confirm / build) for any page.
 */

import { useEffect, useState } from "react";
import { createTodoClient, type TodoRecord } from "../lib/todos.js";
import { RunTimelinePanel } from "./RunTimelinePanel.js";

interface TodoSidePanelProps {
  serviceUrl: string;
  available: boolean;
  todoId: string;
  onClose(): void;
  onTodoChange?(todo: TodoRecord): void;
}

export function TodoSidePanel({
  serviceUrl,
  available,
  todoId,
  onClose,
  onTodoChange
}: TodoSidePanelProps) {
  const [todo, setTodo] = useState<TodoRecord | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!available || !todoId) {
      setTodo(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await createTodoClient(serviceUrl).list({});
        const found = list.find((t) => t.id === todoId) ?? null;
        if (!cancelled) {
          setTodo(found);
          setError(found ? "" : "未找到该 Todo");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "无法加载 Todo");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [available, serviceUrl, todoId]);

  return (
    <aside className="tds-todo-drawer" aria-label="Todo 详情">
      <div className="tds-todo-drawer-head">
        <strong>Todo</strong>
        <button type="button" className="tds-btn-ghost" onClick={onClose}>
          关闭
        </button>
      </div>
      {error ? <div className="tds-banner err">{error}</div> : null}
      {todo ? (
        <div className="tds-todo-drawer-body">
          <RunTimelinePanel
            serviceUrl={serviceUrl}
            todo={todo}
            onClose={onClose}
            onTodoChange={(t) => {
              setTodo(t);
              onTodoChange?.(t);
            }}
          />
        </div>
      ) : !error ? (
        <p className="tds-muted" style={{ padding: "1rem" }}>
          加载中…
        </p>
      ) : null}
    </aside>
  );
}
