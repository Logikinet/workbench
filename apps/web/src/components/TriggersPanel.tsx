import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createAutomationClient,
  describeAction,
  describeSchedule,
  type AutomationJob
} from "../lib/automation.js";
import { TdsEmpty, TdsGhostButton, TdsPrimaryButton } from "./TdsPage.js";

interface TriggersPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M13 2 4 14h7l-1 8 10-14h-7l0-6Z" />
    </svg>
  );
}

export function TriggersPanel({ serviceUrl, available, dataEpoch = 0 }: TriggersPanelProps) {
  const client = useMemo(() => createAutomationClient(serviceUrl), [serviceUrl]);
  const [jobs, setJobs] = useState<AutomationJob[]>([]);
  const [statusLine, setStatusLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    scheduleKind: "manual" as "manual" | "every" | "cron" | "once",
    everyMinutes: "60",
    cronExpr: "0 9 * * 1-5",
    onceAt: "",
    todoTitle: "",
    todoDescription: "",
    startRun: true
  });

  const reload = async () => {
    if (!available) return;
    try {
      const [list, status] = await Promise.all([
        client.listJobs(true),
        client.status().catch(() => ({} as Record<string, unknown>))
      ]);
      setJobs(list);
      const enabledCount = list.filter((j) => j.enabled).length;
      setStatusLine(
        `调度器 ${status.running === false ? "已停止" : "运行中"} · ${enabledCount}/${list.length} 已启用`
      );
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法加载触发器");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, dataEpoch, serviceUrl]);

  const act = async (msg: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setNotice(msg);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const createJob = async (event: FormEvent) => {
    event.preventDefault();
    const name = draft.name.trim() || draft.todoTitle.trim() || "定时 Todo";
    const title = draft.todoTitle.trim() || name;
    let schedule: AutomationJob["schedule"];
    if (draft.scheduleKind === "manual") {
      schedule = { kind: "manual" };
    } else if (draft.scheduleKind === "every") {
      const mins = Math.max(1, Number(draft.everyMinutes) || 60);
      schedule = { kind: "every", everyMs: mins * 60_000 };
    } else if (draft.scheduleKind === "cron") {
      schedule = { kind: "cron", expr: draft.cronExpr.trim() || "0 9 * * 1-5" };
    } else {
      schedule = {
        kind: "once",
        at: draft.onceAt ? new Date(draft.onceAt).toISOString() : new Date(Date.now() + 3600_000).toISOString()
      };
    }

    setBusy(true);
    try {
      await client.createJob({
        name,
        schedule,
        enabled: true,
        deleteAfterRun: draft.scheduleKind === "once",
        action: {
          type: "create_todo",
          title,
          description: draft.todoDescription.trim() || undefined,
          startRun: draft.startRun
        }
      });
      setNotice(`触发器「${name}」已创建`);
      setShowForm(false);
      setDraft({
        name: "",
        scheduleKind: "manual",
        everyMinutes: "60",
        cronExpr: "0 9 * * 1-5",
        onceAt: "",
        todoTitle: "",
        todoDescription: "",
        startRun: true
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法创建触发器");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tds-providers">
      <div className="tds-filter-row">
        <span className="tds-muted">{statusLine || "本地自动化"}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: "0.35rem" }}>
          <TdsGhostButton disabled={!available || busy} onClick={() => void reload()}>
            刷新
          </TdsGhostButton>
          <TdsPrimaryButton disabled={!available} onClick={() => setShowForm((v) => !v)}>
            {showForm ? "关闭" : "+ 添加触发器"}
          </TdsPrimaryButton>
        </div>
      </div>

      {notice ? <div className="tds-banner ok">{notice}</div> : null}
      {error ? <div className="tds-banner err">{error}</div> : null}

      {showForm ? (
        <form className="tds-add-panel" onSubmit={(e) => void createJob(e)}>
          <p className="tds-muted">
            触发器完全在本地运行，仍会经过计划审批与危险操作确认。
          </p>
          <label className="tds-field">
            <span>名称</span>
            <input
              value={draft.name}
              placeholder="晨会 Todo"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="tds-field">
            <span>计划</span>
            <select
              value={draft.scheduleKind}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  scheduleKind: e.target.value as typeof draft.scheduleKind
                })
              }
            >
              <option value="manual">仅手动</option>
              <option value="every">每 N 分钟</option>
              <option value="cron">Cron 表达式</option>
              <option value="once">单次</option>
            </select>
          </label>
          {draft.scheduleKind === "every" ? (
            <label className="tds-field">
              <span>间隔（分钟）</span>
              <input
                type="number"
                min={1}
                value={draft.everyMinutes}
                onChange={(e) => setDraft({ ...draft, everyMinutes: e.target.value })}
              />
            </label>
          ) : null}
          {draft.scheduleKind === "cron" ? (
            <label className="tds-field">
              <span>Cron（分 时 日 月 周）</span>
              <input
                value={draft.cronExpr}
                onChange={(e) => setDraft({ ...draft, cronExpr: e.target.value })}
              />
            </label>
          ) : null}
          {draft.scheduleKind === "once" ? (
            <label className="tds-field">
              <span>运行时间</span>
              <input
                type="datetime-local"
                value={draft.onceAt}
                onChange={(e) => setDraft({ ...draft, onceAt: e.target.value })}
              />
            </label>
          ) : null}
          <label className="tds-field">
            <span>Todo 标题（动作）</span>
            <input
              required
              value={draft.todoTitle}
              placeholder="要创建什么 Todo？"
              onChange={(e) => setDraft({ ...draft, todoTitle: e.target.value })}
            />
          </label>
          <label className="tds-field">
            <span>Todo 描述</span>
            <input
              value={draft.todoDescription}
              onChange={(e) => setDraft({ ...draft, todoDescription: e.target.value })}
            />
          </label>
          <label className="tds-check">
            <input
              type="checkbox"
              checked={draft.startRun}
              onChange={(e) => setDraft({ ...draft, startRun: e.target.checked })}
            />
            同时启动 Run（仍需计划审批）
          </label>
          <div className="tds-form-actions">
            <TdsPrimaryButton type="submit" disabled={busy || !available}>
              {busy ? "保存中…" : "保存触发器"}
            </TdsPrimaryButton>
          </div>
        </form>
      ) : null}

      {!available ? (
        <TdsEmpty title="服务离线" description="请先启动服务以管理触发器。" />
      ) : jobs.length === 0 ? (
        <TdsEmpty
          icon={<BoltIcon />}
          title="还没有触发器"
          description="调度本地任务以创建 Todo 或 Run，且不绕过安全门禁。"
          action={
            <TdsPrimaryButton onClick={() => setShowForm(true)}>+ 添加触发器</TdsPrimaryButton>
          }
        />
      ) : (
        <div className="tds-provider-list">
          {jobs.map((job) => (
            <article key={job.id} className="tds-provider-row">
              <div className="tds-provider-main">
                <div className="tds-provider-title-row">
                  <h3>{job.name}</h3>
                  <span className={`tds-chip ${job.enabled ? "success" : "default"}`}>
                    {job.enabled ? "已启用" : "已禁用"}
                  </span>
                  {job.state.lastStatus ? (
                    <span
                      className={`tds-chip ${
                        job.state.lastStatus === "ok"
                          ? "success"
                          : job.state.lastStatus === "error"
                            ? "danger"
                            : "warning"
                      }`}
                    >
                      上次：{job.state.lastStatus}
                    </span>
                  ) : null}
                </div>
                <p className="tds-muted">{describeSchedule(job.schedule)}</p>
                <p className="tds-muted">{describeAction(job.action)}</p>
                {job.state.nextRunAt ? (
                  <p className="tds-muted">下次：{new Date(job.state.nextRunAt).toLocaleString()}</p>
                ) : null}
                {job.state.lastError ? (
                  <p className="tds-muted" style={{ color: "#fda4af" }}>
                    {job.state.lastError}
                  </p>
                ) : null}
              </div>
              <div className="tds-provider-actions">
                <TdsGhostButton
                  disabled={busy}
                  onClick={() => void act(`已执行「${job.name}」`, () => client.runNow(job.id))}
                >
                  立即运行
                </TdsGhostButton>
                {job.enabled ? (
                  <TdsGhostButton
                    disabled={busy}
                    onClick={() => void act(`已禁用 “${job.name}”`, () => client.disable(job.id))}
                  >
                    禁用
                  </TdsGhostButton>
                ) : (
                  <TdsGhostButton
                    disabled={busy}
                    onClick={() => void act(`已启用 “${job.name}”`, () => client.enable(job.id))}
                  >
                    启用
                  </TdsGhostButton>
                )}
                <TdsGhostButton
                  danger
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`删除触发器「${job.name}」？`)) return;
                    void act(`已删除「${job.name}」`, () => client.remove(job.id));
                  }}
                >
                  删除
                </TdsGhostButton>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
