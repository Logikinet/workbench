/**
 * 本地 todos ultra 主界面：会话聊天 + 任务桥接（复用 Session / Todo / Run / 审批面板）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createChatBridge, statusZh } from "../lib/chatBridge.js";
import { createConnectionClient, type ProviderRecord } from "../lib/connections.js";
import { createProjectClient, type ProjectRecord } from "../lib/projects.js";
import { createRoleClient, type AgentRoleRecord } from "../lib/roles.js";
import type { RunRecord } from "../lib/runs.js";
import type { AgentSessionRecord, SessionCardRecord } from "../lib/sessions.js";
import type { TodoRecord } from "../lib/todos.js";
import { useResizableWidth } from "../lib/useResizable.js";
import { AskUserPanel } from "./AskUserPanel.js";
import { PlanningApprovalPanel } from "./PlanningApprovalPanel.js";
import { ToolCards } from "./ToolCards.js";

interface ChatWorkspaceProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
  onOpenTodos?: (todoId?: string) => void;
}

export function ChatWorkspace({
  serviceUrl,
  available,
  dataEpoch = 0,
  onOpenTodos
}: ChatWorkspaceProps) {
  const bridge = useMemo(() => createChatBridge(serviceUrl), [serviceUrl]);
  const providersClient = useMemo(() => createConnectionClient(serviceUrl), [serviceUrl]);
  const projectsClient = useMemo(() => createProjectClient(serviceUrl), [serviceUrl]);
  const rolesClient = useMemo(() => createRoleClient(serviceUrl), [serviceUrl]);

  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [cards, setCards] = useState<SessionCardRecord[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [roles, setRoles] = useState<AgentRoleRecord[]>([]);
  const [modelId, setModelId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [run, setRun] = useState<RunRecord | null>(null);
  const [todo, setTodo] = useState<TodoRecord | null>(null);
  const [readyHint, setReadyHint] = useState("");

  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId]
  );

  const reloadSessions = useCallback(async () => {
    if (!available) return;
    try {
      const list = await bridge.sessions.list();
      setSessions(list);
      if (selectedId && !list.some((s) => s.id === selectedId)) {
        setSelectedId(list[0]?.id ?? "");
      } else if (!selectedId && list[0]) {
        setSelectedId(list[0].id);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "无法加载会话");
    }
  }, [available, bridge, selectedId]);

  const reloadCards = useCallback(
    async (sessionId: string) => {
      if (!sessionId) {
        setCards([]);
        return;
      }
      try {
        const page = await bridge.sessions.cards(sessionId, { limit: 80, compact: true });
        setCards(page.cards);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "无法加载消息");
      }
    },
    [bridge]
  );

  const reloadMeta = useCallback(async () => {
    if (!available) return;
    try {
      const [plist, proj, rlist] = await Promise.all([
        providersClient.listProviders().catch(() => [] as ProviderRecord[]),
        projectsClient.list().catch(() => [] as ProjectRecord[]),
        rolesClient.list().catch(() => [] as AgentRoleRecord[])
      ]);
      setProviders(plist);
      setProjects(proj.filter((p) => p.status === "active"));
      setRoles(rlist.filter((r) => r.enabled));
    } catch {
      /* optional */
    }
  }, [available, providersClient, projectsClient, rolesClient]);

  const reloadRunSide = useCallback(
    async (session: AgentSessionRecord | null) => {
      if (!session?.todoId) {
        setTodo(null);
        setRun(null);
        return;
      }
      try {
        const todos = await bridge.todos.list({});
        const t = todos.find((x) => x.id === session.todoId) ?? null;
        setTodo(t);
        if (session.runId) {
          const history = await bridge.runs.list(session.todoId);
          setRun(history.find((r) => r.id === session.runId) ?? history[0] ?? null);
        } else if (session.todoId) {
          const history = await bridge.runs.list(session.todoId);
          setRun(history[0] ?? null);
        }
      } catch {
        setTodo(null);
        setRun(null);
      }
    },
    [bridge]
  );

  useEffect(() => {
    void reloadSessions();
    void reloadMeta();
    if (!available) {
      setReadyHint("服务离线。请打开 http://127.0.0.1:41731 并确认服务已启动。");
      return;
    }
    void bridge.preflight().then((r) => {
      setReadyHint(r.ok ? "" : r.message);
    });
  }, [available, dataEpoch, reloadSessions, reloadMeta, bridge]);

  useEffect(() => {
    if (!selectedId) {
      setCards([]);
      setRun(null);
      setTodo(null);
      return;
    }
    void reloadCards(selectedId);
    const s = sessions.find((x) => x.id === selectedId) ?? null;
    void reloadRunSide(s);
    if (s?.preferredModelId) setModelId(s.preferredModelId);
    if (s?.projectId) setProjectId(s.projectId);
    if (s?.agentRoleId) setRoleId(s.agentRoleId);
  }, [selectedId, sessions, reloadCards, reloadRunSide]);

  // Poll while run is active
  useEffect(() => {
    if (!selected || !run) return;
    const active = [
      "planning",
      "waiting_for_user",
      "awaiting_plan_approval",
      "queued",
      "running",
      "paused",
      "awaiting_review",
      "awaiting_acceptance"
    ].includes(run.status);
    if (!active) return;
    const timer = window.setInterval(() => {
      void reloadRunSide(selected);
      void reloadCards(selected.id);
      void reloadSessions();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [selected, run?.id, run?.status, reloadRunSide, reloadCards, reloadSessions]);

  const createChat = async () => {
    if (!available) return;
    setBusy(true);
    try {
      const created = await bridge.sessions.create({
        title: "新会话",
        projectId: projectId || undefined,
        agentRoleId: roleId || undefined,
        preferredModelId: modelId || undefined
      });
      setSessions((c) => [created, ...c]);
      setSelectedId(created.id);
      setCards(created.cards ?? []);
      setNotice("已创建新会话，直接输入任务即可。");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "无法创建会话");
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!available || !draft.trim()) return;
    setBusy(true);
    try {
      let session = selected;
      if (!session) {
        session = await bridge.sessions.create({
          title: draft.trim().slice(0, 48),
          projectId: projectId || undefined,
          agentRoleId: roleId || undefined,
          preferredModelId: modelId || undefined,
          initialMessage: undefined
        });
        setSessions((c) => [session!, ...c]);
        setSelectedId(session.id);
      }
      const result = await bridge.sendAndDispatch(session, draft, {
        projectId: projectId || undefined,
        preferredModelId: modelId || undefined
        // todos default: plan only; user confirms build
      });
      setSessions((c) => c.map((s) => (s.id === result.session.id ? result.session : s)));
      setCards(result.session.cards ?? (await bridge.sessions.cards(result.session.id)).cards);
      setRun(result.run ?? null);
      setDraft("");
      setNotice(
        result.needsConfirm
          ? `${result.notice} → 点下方「确认并构建」继续`
          : result.notice
      );
      await reloadRunSide(result.session);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "发送失败");
    } finally {
      setBusy(false);
    }
  };

  const onAnswerCard = async (
    card: SessionCardRecord,
    payload: {
      selectedOptionIds?: string[];
      freeText?: string;
      approved?: boolean;
      decisionNote?: string;
    }
  ) => {
    if (!selected) return;
    setBusy(true);
    try {
      const updated = await bridge.sessions.answer(selected.id, card.id, payload);
      setSessions((c) => c.map((s) => (s.id === updated.id ? updated : s)));
      setCards(updated.cards);
      setNotice("已提交回答。");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "无法回答");
    } finally {
      setBusy(false);
    }
  };

  const modelOptions = useMemo(() => {
    const opts: Array<{ id: string; label: string }> = [];
    for (const p of providers) {
      const models = p.models ?? [];
      if (models.length) {
        for (const m of models) {
          opts.push({
            id: m.remoteModelId,
            label: `${p.name} / ${m.displayName || m.remoteModelId}`
          });
        }
      } else if (p.defaultModelId) {
        opts.push({ id: p.defaultModelId, label: `${p.name} / ${p.defaultModelId}` });
      }
    }
    return opts;
  }, [providers]);

  const sessionsCol = useResizableWidth("chief-sessions", { initial: 220, min: 160, max: 420 });
  const sideCol = useResizableWidth("chief-side", { initial: 300, min: 220, max: 560 });

  return (
    <div className="chat-ultra">
      {/* 左：会话列表 — todos Chief threads（可拖宽） */}
      <aside className="chat-ultra-sessions" style={{ width: sessionsCol.width, minWidth: sessionsCol.width }}>
        <div className="chat-ultra-sessions-head">
          <strong>总管</strong>
          <button type="button" className="tds-btn-primary" disabled={!available || busy} onClick={() => void createChat()}>
            + 新对话
          </button>
        </div>
        <div className="chat-ultra-session-list">
          {sessions.length === 0 ? (
            <p className="tds-muted" style={{ padding: "0.75rem" }}>
              还没有对话。直接在中间输入任务即可。
            </p>
          ) : (
            sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                className={s.id === selectedId ? "chat-session-item active" : "chat-session-item"}
                onClick={() => setSelectedId(s.id)}
              >
                <span className="chat-session-title">{s.title || "未命名"}</span>
                <span className="chat-session-meta">
                  {statusZh(s.status)}
                  {s.todoId ? " · Todo" : ""}
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <div
        className="tds-col-resizer"
        role="separator"
        aria-label="拖动调整会话栏宽度"
        onMouseDown={sessionsCol.onResizeStart("right")}
      />

      {/* 中：Chief 聊天 */}
      <section className="chat-ultra-main">
        <header className="chat-ultra-main-head">
          <div>
            <h1>{selected?.title || "总管"}</h1>
            <p className="tds-muted">
              说任务 → Planning → Plan ready → 确认并构建（照搬 todos）· 栏宽可拖
            </p>
          </div>
        </header>

        {readyHint ? <div className="tds-banner warn">{readyHint}</div> : null}
        {notice ? <div className="tds-banner ok">{notice}</div> : null}

        <div className="chat-ultra-timeline">
          {!available ? (
            <div className="tds-empty-card">
              <p className="tds-empty-title">服务离线</p>
              <p className="tds-empty-desc">请用浏览器打开 http://127.0.0.1:41731</p>
            </div>
          ) : cards.length === 0 ? (
            <div className="tds-empty-card">
              <p className="tds-empty-title">给总管派活</p>
              <p className="tds-empty-desc">
                例如：「加一个登录页并补测试」——会建 Todo 并出计划，再由你「确认并构建」。
                {readyHint ? " 请先按上方黄色提示完成配置。" : ""}
              </p>
            </div>
          ) : (
            <ToolCards
              cards={cards}
              onAnswer={(card, payload) => void onAnswerCard(card, payload)}
              onToggleCollapse={(card) => {
                if (!selected) return;
                void bridge.sessions
                  .collapseCard(selected.id, card.id, !card.collapsed)
                  .then((updated) => {
                    setCards(updated.cards);
                  })
                  .catch(() => undefined);
              }}
            />
          )}
        </div>

        <footer className="chat-ultra-composer">
          <div className="chat-ultra-composer-tools">
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              aria-label="模型"
              title="会话首选模型"
            >
              <option value="">默认模型</option>
              {modelOptions.map((m) => (
                <option key={m.id + m.label} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              aria-label="项目"
            >
              <option value="">不绑定项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)} aria-label="角色">
              <option value="">默认 Builder</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="描述任务… Enter 开始规划，Shift+Enter 换行"
            rows={3}
            disabled={!available || busy}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="chat-ultra-composer-actions">
            <button
              type="button"
              className="tds-btn-primary"
              disabled={!available || busy || !draft.trim()}
              onClick={() => void send()}
            >
              {busy ? "规划中…" : "发送（开始规划）"}
            </button>
          </div>
        </footer>
      </section>

      <div
        className="tds-col-resizer"
        role="separator"
        aria-label="拖动调整侧栏宽度"
        onMouseDown={sideCol.onResizeStart("left")}
      />

      {/* 右：当前 Todo 侧栏（可拖宽） */}
      <aside className="chat-ultra-side" style={{ width: sideCol.width, minWidth: sideCol.width }}>
        <div className="tds-section-label">当前 Todo</div>
        {!todo ? (
          <p className="tds-muted">发送后自动创建 Todo，并走 Task › Plan › Build。</p>
        ) : (
          <div className="chat-side-card">
            <strong>{todo.title}</strong>
            <p className="tds-muted">Todo：{todo.status}</p>
            {run ? (
              <p className="tds-muted">
                Build：{statusZh(run.status)} · 第 {run.attempt ?? "?"} 次
              </p>
            ) : null}
            <div className="tds-inline-actions" style={{ marginTop: "0.5rem" }}>
              {run &&
              (run.status === "awaiting_plan_approval" ||
                run.planning?.approvalStatus === "awaiting_approval") ? (
                <button
                  type="button"
                  className="tds-btn-primary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void bridge
                      .confirmToBuild(run.id)
                      .then((r) => {
                        setRun(r.run);
                        setNotice(r.notice);
                      })
                      .catch((e) => setNotice(e instanceof Error ? e.message : "无法确认"))
                      .finally(() => setBusy(false));
                  }}
                >
                  确认并构建
                </button>
              ) : null}
              {todo && !run ? (
                <button
                  type="button"
                  className="tds-btn-primary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void bridge
                      .startTodoPlan(
                        todo.id,
                        [todo.title, todo.description].filter(Boolean).join("\n") || "请规划此任务"
                      )
                      .then((r) => {
                        setRun(r.run);
                        setNotice(r.notice);
                      })
                      .catch((e) => setNotice(e instanceof Error ? e.message : "无法规划"))
                      .finally(() => setBusy(false));
                  }}
                >
                  开始规划
                </button>
              ) : null}
              <button
                type="button"
                className="tds-btn-ghost"
                onClick={() => onOpenTodos?.(todo.id)}
              >
                打开 Todos
              </button>
            </div>
          </div>
        )}

        {run && todo ? (
          <div className="chat-side-panels">
            <div className="tds-section-label">需要你时</div>
            <AskUserPanel
              serviceUrl={serviceUrl}
              run={run}
              onRunChange={(next) => setRun(next)}
              onNotice={setNotice}
            />
            <details className="chat-side-advanced">
              <summary className="tds-muted" style={{ cursor: "pointer", fontSize: "0.8rem" }}>
                高级：手动批计划
              </summary>
              <PlanningApprovalPanel
                serviceUrl={serviceUrl}
                run={run}
                onRunChange={(next) => setRun(next)}
                onNotice={setNotice}
              />
            </details>
          </div>
        ) : (
          <div className="tds-section-label" style={{ marginTop: "1rem" }}>
            提示
            <p className="tds-muted" style={{ marginTop: "0.35rem", textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
              模型 / MCP / 技能在左侧「资源」；Agents 在「团队」。日常只在这里对话即可。
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
