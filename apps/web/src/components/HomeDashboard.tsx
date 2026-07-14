import {
  type WorkbenchStatusCounts
} from "../lib/waitingOnMe.js";
import type { WorkbenchRoute } from "../lib/workbenchRoutes.js";
import type { WaitingItem } from "../lib/waitingOnMe.js";
import { waitingKindLabel } from "../lib/waitingOnMe.js";

interface HomeDashboardProps {
  counts: WorkbenchStatusCounts;
  waitingPreview: WaitingItem[];
  loading: boolean;
  error: string;
  onNavigate(route: WorkbenchRoute): void;
  onRefresh(): void;
}

const countCards: Array<{
  key: keyof WorkbenchStatusCounts;
  label: string;
  section: WorkbenchRoute["section"];
  tone: string;
}> = [
  { key: "pending", label: "待处理", section: "todos", tone: "tone-pending" },
  { key: "running", label: "运行中", section: "todos", tone: "tone-running" },
  { key: "waitingOnUser", label: "等待用户", section: "waiting", tone: "tone-wait" },
  { key: "reviewFailed", label: "审查失败", section: "waiting", tone: "tone-danger" },
  { key: "awaitingAcceptance", label: "待验收", section: "waiting", tone: "tone-accept" },
  { key: "completed", label: "已完成", section: "todos", tone: "tone-done" }
];

export function HomeDashboard({
  counts,
  waitingPreview,
  loading,
  error,
  onNavigate,
  onRefresh
}: HomeDashboardProps) {
  return (
    <section className="workspace-panel home-dashboard" aria-labelledby="home-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">HOME</p>
          <h2 id="home-title">工作台首页</h2>
          <p className="panel-lead">围绕 Todo → Run → 审查 → 验收的聚焦操作，而不是纵向管理后台。</p>
        </div>
        <button type="button" className="quiet-button" onClick={onRefresh} disabled={loading}>
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <div className="status-count-grid" role="list" aria-label="任务状态概览">
        {countCards.map((card) => (
          <button
            key={card.key}
            type="button"
            role="listitem"
            className={`status-count-card ${card.tone}`}
            onClick={() =>
              onNavigate(
                card.section === "todos"
                  ? { section: "todos" }
                  : { section: card.section }
              )
            }
          >
            <span className="status-count-value">{counts[card.key]}</span>
            <span className="status-count-label">{card.label}</span>
          </button>
        ))}
      </div>

      <div className="home-waiting-preview">
        <div className="section-heading">
          <div>
            <p className="eyebrow">WAITING ON ME</p>
            <h3>等待我处理</h3>
          </div>
          <button type="button" className="quiet-button" onClick={() => onNavigate({ section: "waiting" })}>
            打开中心
          </button>
        </div>
        {waitingPreview.length === 0 ? (
          <p className="muted-copy">{loading ? "正在扫描待办…" : "当前没有需要你处理的事项。"}</p>
        ) : (
          <ul className="waiting-list compact">
            {waitingPreview.slice(0, 5).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="waiting-item-button"
                  onClick={() => onNavigate({ section: "todos", todoId: item.todoId })}
                >
                  <span className={`tag waiting-kind-${item.kind}`}>{waitingKindLabel(item.kind)}</span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.todoTitle} · {item.detail}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="home-quick-links">
        <button type="button" onClick={() => onNavigate({ section: "todos" })}>
          Todos
        </button>
        <button type="button" className="quiet-button" onClick={() => onNavigate({ section: "projects" })}>
          Projects
        </button>
        <button type="button" className="quiet-button" onClick={() => onNavigate({ section: "agents" })}>
          Agents
        </button>
        <button type="button" className="quiet-button" onClick={() => onNavigate({ section: "connections" })}>
          Connections
        </button>
        <button type="button" className="quiet-button" onClick={() => onNavigate({ section: "settings" })}>
          Settings
        </button>
      </div>
    </section>
  );
}
