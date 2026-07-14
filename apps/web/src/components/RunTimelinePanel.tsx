import { useEffect, useMemo, useState } from "react";
import { createRunClient, reconcileRunSelection, type RunRecord } from "../lib/runs.js";
import type { TodoRecord } from "../lib/todos.js";
import { PlanningApprovalPanel } from "./PlanningApprovalPanel.js";
import { AskUserPanel } from "./AskUserPanel.js";
import { ProfessionalAgentPanel } from "./ProfessionalAgentPanel.js";
import { CodexHarnessPanel } from "./CodexHarnessPanel.js";
import { GitWorktreePanel } from "./GitWorktreePanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { CheckpointRecoveryPanel } from "./CheckpointRecoveryPanel.js";

interface RunTimelinePanelProps {
  serviceUrl: string;
  todo: TodoRecord;
  onClose(): void;
  onTodoChange?(todo: TodoRecord): void;
}

export function RunTimelinePanel({ serviceUrl, todo, onClose, onTodoChange }: RunTimelinePanelProps) {
  const client = createRunClient(serviceUrl);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [compareId, setCompareId] = useState("");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");

  const selected = useMemo(() => runs.find((run) => run.id === selectedId), [runs, selectedId]);
  const compared = useMemo(() => runs.find((run) => run.id === compareId), [runs, compareId]);

  const reload = async () => {
    try {
      const history = await client.list(todo.id);
      setRuns(history);
      const nextSelectedId = reconcileRunSelection(history.map((run) => run.id), selectedId);
      setSelectedId(nextSelectedId);
      setCompareId((current) =>
        current !== nextSelectedId && history.some((run) => run.id === current) ? current : ""
      );
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取 Run 历史");
    }
  };

  useEffect(() => {
    void reload();
  }, [todo.id]);

  useEffect(() => {
    if (selected?.execution.status !== "running" && selected?.status !== "waiting_for_user") return;
    const timer = window.setInterval(() => { void reload(); }, 1000);
    return () => window.clearInterval(timer);
  }, [selected?.id, selected?.execution.status, selected?.status, todo.id]);

  const createRun = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const run = await client.create(todo.id, message);
      setRuns((current) => [run, ...current]);
      setSelectedId(run.id);
      setMessage("");
      setNotice(`第 ${run.attempt} 次 Run 已建立。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法建立 Run");
    }
  };

  const addMessage = async () => {
    if (!selected || !message.trim()) return;
    try {
      const changed = await client.addMessage(selected.id, message);
      setRuns((current) => current.map((run) => (run.id === changed.id ? changed : run)));
      setMessage("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法添加消息");
    }
  };

  const replaceRun = (changed: RunRecord) => {
    setRuns((current) => current.map((run) => run.id === changed.id ? changed : run));
  };

  return (
    <section className="run-panel" aria-labelledby="run-panel-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">RUN HISTORY</p>
          <h3 id="run-panel-title">{todo.title}</h3>
        </div>
        <button type="button" className="quiet-button" onClick={onClose}>关闭</button>
      </div>
      <form className="run-create" onSubmit={createRun}>
        <input aria-label="Run 初始指令" placeholder="输入本次执行指令（留空时 Firstmate 仅询问关键输入）" value={message} onChange={(event) => setMessage(event.target.value)} />
        <button type="submit">新建 Run</button>
        {selected && <button type="button" className="quiet-button" onClick={() => void addMessage()}>追加到当前 Run</button>}
      </form>
      <div className="run-switcher">
        {runs.map((run) => (
          <button key={run.id} type="button" className={selectedId === run.id ? "active-tab" : "quiet-button"} onClick={() => setSelectedId(run.id)}>
            第 {run.attempt} 次 · {run.status}
          </button>
        ))}
      </div>
      {runs.length > 1 && (
        <label className="compare-picker">
          对比历史 Run
          <select value={compareId} onChange={(event) => setCompareId(event.target.value)}>
            <option value="">不对比</option>
            {runs.filter((run) => run.id !== selectedId).map((run) => <option key={run.id} value={run.id}>第 {run.attempt} 次 · {run.status}</option>)}
          </select>
        </label>
      )}
      {notice && <p className="notice" role="status">{notice}</p>}
      <div className={`timeline-grid ${compared ? "compare" : ""}`}>
        {selected && <Timeline run={selected} serviceUrl={serviceUrl} onRunChange={replaceRun} onNotice={setNotice} onTodoChange={onTodoChange} />}
        {compared && <Timeline run={compared} serviceUrl={serviceUrl} onRunChange={replaceRun} onNotice={setNotice} readOnly />}
      </div>
    </section>
  );
}

function Timeline({
  run,
  serviceUrl,
  onRunChange,
  onNotice,
  onTodoChange,
  readOnly = false
}: {
  run: RunRecord;
  serviceUrl: string;
  onRunChange(run: RunRecord): void;
  onNotice(message: string): void;
  onTodoChange?(todo: TodoRecord): void;
  readOnly?: boolean;
}) {
  return (
    <article className="timeline-column">
      <header><strong>第 {run.attempt} 次 Run</strong><span>{run.status}</span></header>
      <dl className="run-indexes">
        <div><dt>计划</dt><dd>{run.planVersions.length}</dd></div>
        <div><dt>日志</dt><dd>{run.logs.length}</dd></div>
        <div><dt>审查</dt><dd>{run.reviews.length}</dd></div>
        <div><dt>成果</dt><dd>{run.artifacts.length}</dd></div>
        <div><dt>检查点</dt><dd>{run.checkpoints?.length ?? 0}</dd></div>
      </dl>
      <AskUserPanel serviceUrl={serviceUrl} run={run} onRunChange={onRunChange} onNotice={onNotice} readOnly={readOnly} />
      <PlanningApprovalPanel serviceUrl={serviceUrl} run={run} onRunChange={onRunChange} onNotice={onNotice} readOnly={readOnly} />
      {!readOnly && run.planning?.approvalStatus === "approved" && <ProfessionalAgentPanel serviceUrl={serviceUrl} run={run} onRunChange={onRunChange} onNotice={onNotice} />}
      {!readOnly && run.planning?.approvalStatus === "approved" && (run.execution.status === "idle" || run.execution.selectedAgent?.harness === "codex-cli") && <CodexHarnessPanel serviceUrl={serviceUrl} run={run} onRunChange={onRunChange} onNotice={onNotice} />}
      {!readOnly && <GitWorktreePanel serviceUrl={serviceUrl} run={run} onNotice={onNotice} />}
      <CheckpointRecoveryPanel serviceUrl={serviceUrl} run={run} onRunChange={onRunChange} onNotice={onNotice} readOnly={readOnly} />
      <ReviewPanel serviceUrl={serviceUrl} run={run} onRunChange={onRunChange} onNotice={onNotice} onTodoChange={onTodoChange} readOnly={readOnly} />
      <ol className="timeline">
        {run.timeline.map((event) => (
          <li key={event.id}><span>{event.kind}</span><p>{event.summary}</p><time>{new Date(event.createdAt).toLocaleString()}</time></li>
        ))}
      </ol>
    </article>
  );
}
