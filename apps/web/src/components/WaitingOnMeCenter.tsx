import {
  waitingKindLabel,
  type WaitingItem,
  type WaitingItemKind
} from "../lib/waitingOnMe.js";
import type { WorkbenchRoute } from "../lib/workbenchRoutes.js";
import { useState } from "react";

interface WaitingOnMeCenterProps {
  available: boolean;
  items: WaitingItem[];
  loading: boolean;
  error: string;
  onRefresh(): void;
  onNavigate(route: WorkbenchRoute): void;
}

const filterKinds: Array<{ id: "all" | WaitingItemKind; label: string }> = [
  { id: "all", label: "全部" },
  { id: "plan_approval", label: "计划审批" },
  { id: "ask_user", label: "AskUser" },
  { id: "dangerous_action", label: "危险操作" },
  { id: "acceptance", label: "最终验收" },
  { id: "review_failed", label: "审查失败" },
  { id: "recovery", label: "中断恢复" }
];

export function WaitingOnMeCenter({
  items,
  loading,
  error,
  available,
  onRefresh,
  onNavigate
}: WaitingOnMeCenterProps) {
  const [filter, setFilter] = useState<"all" | WaitingItemKind>("all");
  const visible = filter === "all" ? items : items.filter((item) => item.kind === filter);

  return (
    <section className="workspace-panel waiting-center" aria-labelledby="waiting-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">WAITING ON ME</p>
          <h2 id="waiting-title">等待我处理</h2>
          <p className="panel-lead">
            集中处理计划审批、AskUser、危险操作确认与最终验收。移动端优先完成这些操作。
          </p>
        </div>
        <button type="button" className="quiet-button" onClick={onRefresh} disabled={!available || loading}>
          {loading ? "扫描中…" : "刷新"}
        </button>
      </div>

      <div className="status-tabs waiting-filters" role="tablist" aria-label="等待事项类型">
        {filterKinds.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={filter === entry.id}
            className={filter === entry.id ? "active-tab" : "quiet-button"}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
            {entry.id !== "all" && (
              <span className="filter-count">{items.filter((item) => item.kind === entry.id).length}</span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="muted-copy" role="status">
          {loading ? "正在扫描 Runs…" : "没有匹配的待处理事项。"}
        </p>
      ) : (
        <ul className="waiting-list">
          {visible.map((item) => (
            <li key={item.id} className={`waiting-card kind-${item.kind}`}>
              <div>
                <span className={`tag waiting-kind-${item.kind}`}>{waitingKindLabel(item.kind)}</span>
                <strong>{item.title}</strong>
                <small>{item.todoTitle}</small>
                <span>{item.detail}</span>
              </div>
              <div className="project-actions">
                <button type="button" onClick={() => onNavigate({ section: "todos", todoId: item.todoId })}>
                  打开 Todo / Run
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
