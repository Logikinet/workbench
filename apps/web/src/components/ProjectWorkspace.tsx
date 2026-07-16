/**
 * todos 项目工作台
 * 红字重点：任务在项目内；顶栏操控栏；执行后 diff 高亮；便签式详情
 */

import { useEffect, useMemo, useState } from "react";
import { createChatBridge } from "../lib/chatBridge.js";
import { createProjectClient, type ProjectRecord } from "../lib/projects.js";
import { createRoleClient, type AgentRoleRecord } from "../lib/roles.js";
import { createRunClient, formatTokenCount, type RunRecord } from "../lib/runs.js";
import { createTodoClient, type TodoRecord } from "../lib/todos.js";
import { deriveTodosPhase, phaseLabels, type TodosPhase } from "../lib/todosFlow.js";
import { useResizableWidth } from "../lib/useResizable.js";
import { DiffPreview } from "./DiffPreview.js";
import { StartTaskModal, type StartTaskChoice } from "./StartTaskModal.js";
import { TokenUsageModal } from "./TokenUsageModal.js";

interface ProjectWorkspaceProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
  projectId?: string;
  focusTodoId?: string;
  onSelectProject?(projectId: string | undefined): void;
  onSelectTodo?(todoId: string | undefined): void;
}

const stageOf = (phase: TodosPhase): "task" | "plan" | "build" => {
  if (phase === "todo" || phase === "blocked") return "task";
  if (phase === "planning" || phase === "confirm") return "plan";
  return "build";
};

/** todos 顶栏状态文案 */
function controlStatusLabel(phase: TodosPhase): string {
  switch (phase) {
    case "todo":
      return "待办";
    case "planning":
      return "规划中";
    case "confirm":
      return "待确认";
    case "building":
      return "执行中";
    case "review":
      return "待验收";
    case "done":
      return "已完成";
    case "blocked":
      return "需处理";
    case "failed":
      return "出错";
    default:
      return phaseLabels[phase];
  }
}

function statusTone(phase: TodosPhase): string {
  switch (phase) {
    case "planning":
      return "violet";
    case "confirm":
      return "amber";
    case "building":
      return "blue";
    case "review":
      return "amber";
    case "done":
      return "green";
    case "failed":
      return "red";
    case "blocked":
      return "orange";
    default:
      return "muted";
  }
}

export function ProjectWorkspace({
  serviceUrl,
  available,
  dataEpoch = 0,
  projectId,
  focusTodoId,
  onSelectProject,
  onSelectTodo
}: ProjectWorkspaceProps) {
  const todosApi = useMemo(() => createTodoClient(serviceUrl), [serviceUrl]);
  const runsApi = useMemo(() => createRunClient(serviceUrl), [serviceUrl]);
  const projectsApi = useMemo(() => createProjectClient(serviceUrl), [serviceUrl]);
  const rolesApi = useMemo(() => createRoleClient(serviceUrl), [serviceUrl]);
  const bridge = useMemo(() => createChatBridge(serviceUrl), [serviceUrl]);

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [todos, setTodos] = useState<TodoRecord[]>([]);
  const [runsByTodo, setRunsByTodo] = useState<Record<string, RunRecord | undefined>>({});
  const [roles, setRoles] = useState<AgentRoleRecord[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>(focusTodoId);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [showNew, setShowNew] = useState(false);
  const detailCol = useResizableWidth("project-detail", { initial: 420, min: 280, max: 720 });

  const activeProjectId = projectId || projects[0]?.id;
  const project = projects.find((p) => p.id === activeProjectId);

  const reload = async () => {
    if (!available) return;
    try {
      const [plist, tlist, rlist] = await Promise.all([
        projectsApi.list(),
        todosApi.list({}),
        rolesApi.list()
      ]);
      setProjects(plist.filter((p) => p.status === "active"));
      setRoles(rlist.filter((r) => r.enabled));
      const pid = projectId || plist.find((p) => p.status === "active")?.id;
      const filtered = tlist.filter((t) => !t.archived && (!pid || t.projectId === pid || !t.projectId));
      setTodos(filtered);

      const map: Record<string, RunRecord | undefined> = {};
      await Promise.all(
        filtered.slice(0, 40).map(async (t) => {
          try {
            const hist = await runsApi.list(t.id);
            map[t.id] = hist[0];
          } catch {
            map[t.id] = undefined;
          }
        })
      );
      setRunsByTodo(map);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "加载失败");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, dataEpoch, projectId]);

  useEffect(() => {
    if (focusTodoId) setSelectedId(focusTodoId);
  }, [focusTodoId]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return todos
      .map((todo) => {
        const run = runsByTodo[todo.id];
        const phase = deriveTodosPhase(todo, run);
        return { todo, run, phase };
      })
      .filter(({ todo }) => !q || todo.title.toLowerCase().includes(q));
  }, [todos, runsByTodo, query]);

  const selected = rows.find((r) => r.todo.id === selectedId) ?? null;

  const selectTodo = (id: string | undefined) => {
    setSelectedId(id);
    onSelectTodo?.(id);
  };

  const createTodo = async () => {
    const title = draftTitle.trim();
    if (!title) return;
    if (!activeProjectId) {
      setNotice("请先在侧栏「+ 新建」创建项目，任务建在项目里");
      return;
    }
    setBusy(true);
    try {
      const todo = await todosApi.create({
        title,
        description: title,
        projectId: activeProjectId
      });
      setDraftTitle("");
      setShowNew(false);
      setNotice("任务已创建");
      await reload();
      selectTodo(todo.id);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const onStartConfirm = async (choice: StartTaskChoice) => {
    if (!selected) return;
    setBusy(true);
    try {
      const planned = await bridge.startTodoPlan(
        selected.todo.id,
        [selected.todo.title, selected.todo.description].filter(Boolean).join("\n") ||
          "请规划此任务"
      );
      setRunsByTodo((c) => ({ ...c, [selected.todo.id]: planned.run }));
      setStartOpen(false);
      setNotice(
        planned.phase === "confirm"
          ? `规划完成 · 点「确认方案」开始执行（执行：${
              roles.find((r) => r.id === choice.execRoleId)?.name || "默认"
            }）`
          : planned.notice
      );
      sessionStorage.setItem(`paw-exec-role:${selected.todo.id}`, choice.execRoleId);
      sessionStorage.setItem(`paw-plan-role:${selected.todo.id}`, choice.planRoleId);
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "启动规划失败");
    } finally {
      setBusy(false);
    }
  };

  const confirmBuild = async () => {
    if (!selected?.run) return;
    setBusy(true);
    try {
      const result = await bridge.confirmToBuild(selected.run.id);
      setRunsByTodo((c) => ({ ...c, [selected.todo.id]: result.run }));
      setNotice(result.notice);
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "确认构建失败");
    } finally {
      setBusy(false);
    }
  };

  const completeTask = async () => {
    if (!selected?.run) return;
    setBusy(true);
    try {
      await runsApi.decideAcceptance(selected.run.id, {
        decision: "accepted",
        summary: "用户验收完成"
      });
      setNotice("已标记完成");
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "验收失败");
    } finally {
      setBusy(false);
    }
  };

  const stage = selected ? stageOf(selected.phase) : "task";
  const showDiff =
    selected?.run &&
    (selected.phase === "building" ||
      selected.phase === "review" ||
      selected.phase === "done" ||
      selected.phase === "failed");

  const primaryAction =
    selected?.phase === "todo" || selected?.phase === "failed" ? (
      <button
        type="button"
        className="tds-btn-primary tds-btn-sm"
        disabled={busy}
        onClick={() => setStartOpen(true)}
      >
        开始
      </button>
    ) : selected?.phase === "confirm" ? (
      <button
        type="button"
        className="tds-btn-primary tds-btn-sm"
        disabled={busy}
        onClick={() => void confirmBuild()}
      >
        确认方案
      </button>
    ) : selected?.phase === "review" ? (
      <button
        type="button"
        className="tds-btn-primary tds-btn-sm"
        disabled={busy}
        onClick={() => void completeTask()}
      >
        完成
      </button>
    ) : null;

  /** 方案/执行阶段：加宽中栏内容感，详情为主 */
  const focusMode =
    selected &&
    (selected.phase === "confirm" ||
      selected.phase === "planning" ||
      selected.phase === "building" ||
      selected.phase === "review" ||
      selected.phase === "done");

  return (
    <div className={`tds-board${focusMode ? " tds-board-focus" : ""}`}>
      {/* 中栏：项目内任务列表 */}
      <section className={`tds-board-list${focusMode ? " collapsed" : ""}`}>
        <header className="tds-board-head">
          <div className="tds-board-head-title">
            <h1>{project?.name || "选择项目"}</h1>
            {project?.github?.fullName ? (
              <a
                className="tds-board-repo tds-board-repo-link"
                href={project.github.htmlUrl}
                target="_blank"
                rel="noreferrer"
                title={project.workspacePath}
              >
                {project.github.fullName} ↗
              </a>
            ) : project?.workspacePath ? (
              <small className="tds-board-repo" title={project.workspacePath}>
                {project.workspacePath}
              </small>
            ) : null}
          </div>
          <div className="tds-board-head-actions">
            <button type="button" className="tds-ico-ghost" title="刷新" onClick={() => void reload()}>
              ↻
            </button>
            <button
              type="button"
              className="tds-btn-primary tds-btn-sm"
              disabled={!available || busy || !activeProjectId}
              onClick={() => setShowNew(true)}
              title="在当前项目中新建任务"
            >
              + 新建任务
            </button>
          </div>
        </header>

        <div className="tds-board-toolbar">
          <input
            className="tds-board-search"
            placeholder="搜索任务…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="tds-board-tool">筛选</span>
          <span className="tds-board-tool">排序</span>
        </div>

        {notice ? <div className="tds-banner ok tds-board-banner">{notice}</div> : null}

        {!activeProjectId ? (
          <div className="tds-board-empty">
            还没有项目。请用左侧栏「+ 新建」创建项目（不是任务），再在项目里加任务。
          </div>
        ) : null}

        {showNew ? (
          <div className="tds-board-new">
            <input
              autoFocus
              placeholder="任务标题…"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createTodo();
                if (e.key === "Escape") setShowNew(false);
              }}
            />
            <button type="button" className="tds-btn-primary tds-btn-sm" disabled={busy} onClick={() => void createTodo()}>
              创建
            </button>
            <button type="button" className="tds-btn-ghost tds-btn-sm" onClick={() => setShowNew(false)}>
              取消
            </button>
          </div>
        ) : null}

        <div className="tds-task-list">
          {activeProjectId && rows.length === 0 ? (
            <div className="tds-board-empty">项目内还没有任务。点「+ 新建任务」或从总管派活。</div>
          ) : (
            rows.map(({ todo, phase }) => (
              <button
                key={todo.id}
                type="button"
                className={`tds-task-row${selectedId === todo.id ? " selected" : ""}`}
                onClick={() => selectTodo(todo.id)}
              >
                <span className="tds-task-check" aria-hidden="true" />
                <span className="tds-task-title">{todo.title}</span>
                <span className="tds-task-phase">{phaseLabels[phase]}</span>
              </button>
            ))
          )}
        </div>
      </section>

      <div
        className="tds-col-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整详情栏宽度"
        onMouseDown={detailCol.onResizeStart("left")}
      />

      {/* 右栏：操控栏 + 便签/方案/diff */}
      <aside className="tds-board-detail" style={{ width: detailCol.width, minWidth: detailCol.width }}>
        {!selected ? (
          <div className="tds-board-detail-empty">选择左侧任务查看详情</div>
        ) : (
          <>
            {/* 红字：操控栏学抄 todos */}
            <div className="tds-control-bar">
              <div className="tds-control-left">
                <span className="tds-control-hash">#{selected.run?.attempt ?? selected.todo.id.slice(0, 4)}</span>
                <span className={`tds-control-status ${statusTone(selected.phase)}`}>
                  {controlStatusLabel(selected.phase)}
                </span>
              </div>
              <div className="tds-control-mid">
                <span className={stage === "task" ? "on" : "done"}>任务</span>
                <span className="sep">›</span>
                <span className={stage === "plan" ? "on" : stage === "build" ? "done" : ""}>规划</span>
                <span className="sep">›</span>
                <span className={stage === "build" ? "on" : ""}>执行</span>
              </div>
              <div className="tds-control-right">
                {selected.run ? (
                  <button
                    type="button"
                    className="tds-usage-chip"
                    title="Token 用量"
                    onClick={() => setUsageOpen(true)}
                  >
                    <span className="tds-usage-chip-ico" aria-hidden="true">
                      ◇
                    </span>
                    {formatTokenCount(selected.run.usage?.totalTokens ?? 0)}
                  </button>
                ) : null}
                {primaryAction}
                <button type="button" className="tds-ico-ghost" onClick={() => selectTodo(undefined)} title="关闭">
                  ×
                </button>
              </div>
            </div>

            <div className="tds-detail-body">
              {/* 红字：便签式详情（待办阶段） */}
              {selected.phase === "todo" || selected.phase === "failed" ? (
                <div className="tds-sticky-note">
                  <div className="tds-sticky-kicker">任务</div>
                  <h2>{selected.todo.title}</h2>
                  {selected.todo.description && selected.todo.description !== selected.todo.title ? (
                    <p className="tds-detail-desc">{selected.todo.description}</p>
                  ) : (
                    <p className="tds-detail-desc muted">暂无描述</p>
                  )}
                  <div className="tds-sticky-meta">
                    <span>{project?.name || "项目"}</span>
                    <span>创建于任务板</span>
                  </div>
                </div>
              ) : null}

              {/* 方案确认：Context / Changes 风格 */}
              {selected.phase === "confirm" || selected.phase === "planning" ? (
                <div className="tds-plan-doc">
                  <h2>{selected.todo.title}</h2>
                  {selected.run?.planVersions?.length ? (
                    <>
                      <h3>Context</h3>
                      <p className="tds-detail-desc">
                        {selected.run.planVersions.at(-1)?.summary || "已生成计划，请确认后执行。"}
                      </p>
                      <h3>Changes</h3>
                      <ol>
                        {(selected.run.planVersions.at(-1)?.steps ?? []).map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                      {(selected.run.planVersions.at(-1)?.acceptanceCriteria?.length ?? 0) > 0 ? (
                        <>
                          <h3>验收</h3>
                          <ul>
                            {(selected.run.planVersions.at(-1)?.acceptanceCriteria ?? []).map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <p className="tds-detail-desc muted">规划中…</p>
                  )}
                </div>
              ) : null}

              {/* 红字：文件 diff 预览高亮 */}
              {showDiff && selected.run ? (
                <DiffPreview serviceUrl={serviceUrl} runId={selected.run.id} />
              ) : null}

              {selected.run?.timeline?.length && selected.phase !== "todo" ? (
                <div className="tds-log-box">
                  <h3>动态</h3>
                  <ul>
                    {selected.run.timeline.slice(-10).map((ev) => (
                      <li key={ev.id}>
                        <code>{ev.kind}</code> {ev.summary}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {(selected.phase === "building" ||
              selected.phase === "planning" ||
              selected.phase === "review") &&
            selected.run ? (
              <footer className="tds-detail-composer">
                <input
                  placeholder={
                    selected.phase === "review"
                      ? "请求修改…"
                      : "向 Agent 补充说明，执行中即可送达"
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.currentTarget.value.trim() && selected.run) {
                      const v = e.currentTarget.value.trim();
                      e.currentTarget.value = "";
                      void runsApi.addMessage(selected.run.id, v).then((run) => {
                        setRunsByTodo((c) => ({ ...c, [selected.todo.id]: run }));
                        setNotice("说明已送达");
                      });
                    }
                  }}
                />
              </footer>
            ) : null}
          </>
        )}
      </aside>

      <StartTaskModal
        open={startOpen}
        roles={roles}
        busy={busy}
        onClose={() => setStartOpen(false)}
        onConfirm={(c) => void onStartConfirm(c)}
      />

      <TokenUsageModal
        open={usageOpen}
        serviceUrl={serviceUrl}
        runId={selected?.run?.id}
        seed={selected?.run?.usage}
        onClose={() => setUsageOpen(false)}
      />
    </div>
  );
}
