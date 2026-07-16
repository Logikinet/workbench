/**
 * todos.dev Todos board:
 * list + Task › Plan › Build + primary CTA (开始规划 / 确认并构建)
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createChatBridge } from "../lib/chatBridge.js";
import { createProjectClient, type ProjectRecord } from "../lib/projects.js";
import { createRunClient, type RunRecord } from "../lib/runs.js";
import {
  createTodoClient,
  type TodoRecord
} from "../lib/todos.js";
import {
  deriveTodosPhase,
  layerState,
  phaseLabels,
  primaryActionForPhase,
  type TodosPhase
} from "../lib/todosFlow.js";
import { RunTimelinePanel } from "./RunTimelinePanel.js";
import {
  ListIcon,
  TdsEmpty,
  TdsGhostButton,
  TdsPage,
  TdsPrimaryButton
} from "./TdsPage.js";

interface TodoBoardProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
  focusTodoId?: string;
  onFocusTodo?(todoId: string | undefined): void;
}

type BoardFilter = "all" | TodosPhase | "archived";

const filterLabels: Record<BoardFilter, string> = {
  all: "全部",
  todo: "To Do",
  planning: "Planning",
  confirm: "Plan ready",
  building: "Building",
  review: "Review",
  done: "Done",
  blocked: "Need you",
  failed: "Failed",
  archived: "已归档"
};

function LayerTrack({ phase }: { phase: TodosPhase }) {
  const layers = layerState(phase);
  const cls = (s: "idle" | "active" | "done") =>
    `tds-layer-chip${s === "done" ? " is-done" : ""}${s === "active" ? " is-active" : ""}`;
  return (
    <div className="tds-layer-track" aria-label="Task Plan Build">
      <span className={cls(layers.task)}>Task</span>
      <span className="tds-layer-sep">›</span>
      <span className={cls(layers.plan)}>Plan</span>
      <span className="tds-layer-sep">›</span>
      <span className={cls(layers.build)}>Build</span>
    </div>
  );
}

export function TodoBoard({
  serviceUrl,
  available,
  dataEpoch = 0,
  focusTodoId,
  onFocusTodo
}: TodoBoardProps) {
  const todosClient = createTodoClient(serviceUrl);
  const runsClient = createRunClient(serviceUrl);
  const projectsClient = createProjectClient(serviceUrl);
  const bridge = useMemo(() => createChatBridge(serviceUrl), [serviceUrl]);

  const [todos, setTodos] = useState<TodoRecord[]>([]);
  const [runsByTodo, setRunsByTodo] = useState<Record<string, RunRecord | undefined>>({});
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState({ title: "", description: "", projectId: "" });
  const [runTodo, setRunTodo] = useState<TodoRecord | null>(null);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  const reload = async () => {
    if (!available) return;
    try {
      const [nextTodos, nextProjects] = await Promise.all([
        todosClient.list(filter === "archived" ? { archived: true } : {}),
        projectsClient.list()
      ]);
      setTodos(nextTodos);
      setProjects(nextProjects.filter((p) => p.status === "active"));

      // Latest run per todo (capped concurrency)
      const map: Record<string, RunRecord | undefined> = {};
      const batchSize = 6;
      for (let i = 0; i < nextTodos.length; i += batchSize) {
        const batch = nextTodos.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (todo) => {
            try {
              const history = await runsClient.list(todo.id);
              map[todo.id] = history[0];
            } catch {
              map[todo.id] = undefined;
            }
          })
        );
      }
      setRunsByTodo(map);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取 Todos");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, filter, dataEpoch]);

  useEffect(() => {
    if (!available || !focusTodoId) {
      if (!focusTodoId) setRunTodo(null);
      return;
    }
    const found = todos.find((t) => t.id === focusTodoId);
    if (found) setRunTodo(found);
  }, [available, focusTodoId, todos]);

  const rows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return todos
      .map((todo) => {
        const run = runsByTodo[todo.id];
        const phase = deriveTodosPhase(todo, run);
        return { todo, run, phase };
      })
      .filter(({ todo, phase }) => {
        if (filter === "archived") return todo.archived;
        if (todo.archived) return false;
        if (filter !== "all" && phase !== filter) return false;
        if (!q) return true;
        return `${todo.title}\n${todo.description ?? ""}`.toLocaleLowerCase().includes(q);
      });
  }, [todos, runsByTodo, filter, query]);

  const planReadyIds = useMemo(
    () =>
      rows
        .filter((r) => r.phase === "confirm" && r.run)
        .map((r) => r.run!.id),
    [rows]
  );

  const createTodo = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const todo = await todosClient.create({
        title: draft.title,
        description: draft.description,
        projectId: draft.projectId || undefined
      });
      setDraft({ title: "", description: "", projectId: "" });
      setComposerOpen(false);
      // todos: immediately start planning
      const planned = await bridge.startTodoPlan(
        todo.id,
        [todo.title, todo.description].filter(Boolean).join("\n")
      );
      setTodos((c) => [todo, ...c.filter((t) => t.id !== todo.id)]);
      setRunsByTodo((c) => ({ ...c, [todo.id]: planned.run }));
      setNotice(planned.notice);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法创建");
    }
  };

  const runPrimary = async (todo: TodoRecord, phase: TodosPhase, run?: RunRecord) => {
    if (busyId) return;
    setBusyId(todo.id);
    try {
      const action = primaryActionForPhase(phase);
      if (action.id === "confirm_build" && run) {
        const result = await bridge.confirmToBuild(run.id);
        setRunsByTodo((c) => ({ ...c, [todo.id]: result.run }));
        setNotice(result.notice);
        setRunTodo(todo);
        onFocusTodo?.(todo.id);
      } else if (action.id === "start_plan") {
        const result = await bridge.startTodoPlan(
          todo.id,
          [todo.title, todo.description].filter(Boolean).join("\n") || "请规划此任务"
        );
        setRunsByTodo((c) => ({ ...c, [todo.id]: result.run }));
        setNotice(result.notice);
        if (result.phase === "confirm") {
          setRunTodo(todo);
        }
      } else {
        setRunTodo(todo);
        onFocusTodo?.(todo.id);
      }
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const runAllReady = async () => {
    if (!planReadyIds.length || busyId) return;
    setBusyId("__batch__");
    try {
      const result = await bridge.confirmMany(planReadyIds);
      setNotice(`已确认 ${result.ok} 个构建${result.fail ? `，失败 ${result.fail}` : ""}`);
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "批量确认失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <TdsPage
      kicker="Board"
      title="Todos"
      description="Task › Plan › Build。规划完成后点「确认并构建」——和 todos.dev 同一操作。"
      action={
        <div className="tds-inline-actions">
          {planReadyIds.length > 0 ? (
            <TdsPrimaryButton
              onClick={() => void runAllReady()}
              disabled={!available || !!busyId}
            >
              Run {planReadyIds.length}
            </TdsPrimaryButton>
          ) : null}
          <TdsGhostButton onClick={() => void reload()} disabled={!available}>
            刷新
          </TdsGhostButton>
          <TdsPrimaryButton onClick={() => setComposerOpen((v) => !v)} disabled={!available}>
            + 新建
          </TdsPrimaryButton>
        </div>
      }
    >
      {composerOpen ? (
        <form className="tds-form tds-form-wide" onSubmit={(e) => void createTodo(e)}>
          <label className="tds-field">
            <span>任务</span>
            <input
              required
              autoFocus
              placeholder="希望 Agent 做什么？"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="tds-field">
            <span>说明</span>
            <input
              placeholder="可选"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <label className="tds-field">
            <span>项目</span>
            <select
              value={draft.projectId}
              onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}
            >
              <option value="">默认工作区</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="tds-form-actions">
            <TdsPrimaryButton type="submit">创建并开始规划</TdsPrimaryButton>
            <TdsGhostButton onClick={() => setComposerOpen(false)}>取消</TdsGhostButton>
          </div>
        </form>
      ) : null}

      <div className="tds-filter-row">
        {(
          ["all", "todo", "planning", "confirm", "building", "review", "done", "blocked", "archived"] as BoardFilter[]
        ).map((entry) => (
          <button
            key={entry}
            type="button"
            className={filter === entry ? "tds-filter-chip active" : "tds-filter-chip"}
            onClick={() => setFilter(entry)}
          >
            {filterLabels[entry]}
          </button>
        ))}
        <input
          className="tds-inline-search"
          placeholder="搜索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {notice ? <div className="tds-banner ok">{notice}</div> : null}

      {runTodo ? (
        <RunTimelinePanel
          serviceUrl={serviceUrl}
          todo={runTodo}
          onClose={() => {
            setRunTodo(null);
            onFocusTodo?.(undefined);
            void reload();
          }}
          onTodoChange={(changed) => {
            setRunTodo(changed);
            setTodos((c) => c.map((t) => (t.id === changed.id ? changed : t)));
          }}
        />
      ) : null}

      {rows.length === 0 ? (
        <TdsEmpty
          icon={<ListIcon />}
          title="还没有 Todo"
          description="在 Chief 说话，或点「+ 新建」。规划完成后确认并构建。"
          action={
            <TdsPrimaryButton onClick={() => setComposerOpen(true)}>+ 新建 Todo</TdsPrimaryButton>
          }
        />
      ) : (
        <div className="tds-todo-list">
          {rows.map(({ todo, run, phase }) => {
            const busy = busyId === todo.id;
            const action = primaryActionForPhase(phase);
            return (
              <article
                key={todo.id}
                className={`tds-todo-row${runTodo?.id === todo.id ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  className="tds-todo-main"
                  onClick={() => {
                    setRunTodo(todo);
                    onFocusTodo?.(todo.id);
                  }}
                >
                  <div className="tds-todo-title-row">
                    <h3>{todo.title}</h3>
                    <span
                      className={`tds-chip ${
                        phase === "building"
                          ? "success"
                          : phase === "confirm" || phase === "blocked"
                            ? "warn"
                            : "default"
                      }`}
                    >
                      {phaseLabels[phase]}
                    </span>
                  </div>
                  {todo.description ? (
                    <p className="tds-muted tds-todo-desc">{todo.description}</p>
                  ) : null}
                  <LayerTrack phase={phase} />
                </button>
                <div className="tds-todo-actions">
                  {action.id !== "none" ? (
                    <TdsPrimaryButton
                      disabled={!available || busy || (action.id === "view" && phase === "planning")}
                      onClick={() => void runPrimary(todo, phase, run)}
                    >
                      {busy ? "…" : action.label}
                    </TdsPrimaryButton>
                  ) : null}
                  <TdsGhostButton
                    onClick={() => {
                      setRunTodo(todo);
                      onFocusTodo?.(todo.id);
                    }}
                  >
                    打开
                  </TdsGhostButton>
                  <TdsGhostButton
                    onClick={() =>
                      void todosClient
                        .update(todo.id, { archived: !todo.archived })
                        .then(() => reload())
                    }
                  >
                    {todo.archived ? "恢复" : "归档"}
                  </TdsGhostButton>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </TdsPage>
  );
}
