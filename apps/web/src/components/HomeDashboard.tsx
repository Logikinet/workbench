import type { WorkbenchStatusCounts } from "../lib/waitingOnMe.js";
import type { WorkbenchRoute } from "../lib/workbenchRoutes.js";
import type { WaitingItem } from "../lib/waitingOnMe.js";
import { waitingKindLabel } from "../lib/waitingOnMe.js";
import { TdsEmpty, TdsGhostButton, TdsPage, TdsPrimaryButton, InboxIcon } from "./TdsPage.js";

interface HomeDashboardProps {
  counts: WorkbenchStatusCounts;
  waitingPreview: WaitingItem[];
  loading: boolean;
  error: string;
  online?: boolean;
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

const quickActions: Array<{
  label: string;
  description: string;
  section: WorkbenchRoute["section"];
}> = [
  { label: "新建 Todo", description: "启动 规划 → 执行 → 审查 链路", section: "todos" },
  { label: "模型服务", description: "配置模型 API 与凭据", section: "connections" },
  { label: "项目", description: "绑定 Windows 工作区", section: "projects" },
  { label: "收件箱", description: "处理等待你的事项", section: "waiting" }
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
    <TdsPage
      kicker="总览"
      title="首页"
      description="本地 Agent 工作台一览"
      action={
        <TdsGhostButton onClick={onRefresh} disabled={loading}>
          {loading ? "刷新中…" : "刷新"}
        </TdsGhostButton>
      }
    >
      {error ? <div className="tds-banner err">{error}</div> : null}

      <section className="tds-home-grid">
        <div className="tds-home-primary">
          <div className="tds-section-label">任务状态</div>
          <div className="status-count-grid" role="list">
            {countCards.map((card) => (
              <button
                key={card.key}
                type="button"
                role="listitem"
                className={`status-count-card ${card.tone}`}
                onClick={() => onNavigate({ section: card.section })}
              >
                <span className="status-count-topline">
                  <span className="status-tone-dot" aria-hidden="true" />
                  <span className="status-count-label">{card.label}</span>
                </span>
                <span className="status-count-value">{counts[card.key]}</span>
              </button>
            ))}
          </div>

          <div className="tds-section-label mt-6">等待我处理</div>
          {waitingPreview.length === 0 ? (
            <TdsEmpty
              icon={<InboxIcon />}
              title="收件箱是空的"
              description="需要审批或回答的事项会出现在这里。"
              action={
                <TdsPrimaryButton onClick={() => onNavigate({ section: "todos" })}>
                  + 新建 Todo
                </TdsPrimaryButton>
              }
            />
          ) : (
            <div className="tds-provider-list">
              {waitingPreview.slice(0, 6).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="tds-provider-row tds-row-button"
                  onClick={() =>
                    onNavigate(
                      item.todoId
                        ? { section: "todos", todoId: item.todoId }
                        : { section: "waiting" }
                    )
                  }
                >
                  <div className="tds-provider-main">
                    <div className="tds-provider-title-row">
                      <h3>{item.title}</h3>
                      <span className="tds-chip warning">{waitingKindLabel(item.kind)}</span>
                    </div>
                    <p className="tds-muted">{item.detail || item.todoTitle || "—"}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="tds-home-aside">
          <div className="tds-section-label">快捷入口</div>
          <div className="tds-quick-list">
            {quickActions.map((action) => (
              <button
                key={action.section + action.label}
                type="button"
                className="tds-quick-card"
                onClick={() => onNavigate({ section: action.section })}
              >
                <strong>{action.label}</strong>
                <span>{action.description}</span>
              </button>
            ))}
          </div>
        </aside>
      </section>
    </TdsPage>
  );
}
