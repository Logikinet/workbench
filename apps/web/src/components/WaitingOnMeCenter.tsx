import {
  waitingKindLabel,
  type WaitingItem,
  type WaitingItemKind
} from "../lib/waitingOnMe.js";
import type { WorkbenchRoute } from "../lib/workbenchRoutes.js";
import { useMemo, useState } from "react";
import { createChatBridge } from "../lib/chatBridge.js";
import { InboxIcon, TdsEmpty, TdsGhostButton, TdsPage, TdsPrimaryButton } from "./TdsPage.js";

interface WaitingOnMeCenterProps {
  available: boolean;
  serviceUrl: string;
  items: WaitingItem[];
  loading: boolean;
  error: string;
  onRefresh(): void;
  onNavigate(route: WorkbenchRoute): void;
}

const filterKinds: Array<{ id: "all" | WaitingItemKind; label: string }> = [
  { id: "all", label: "全部" },
  { id: "plan_approval", label: "Plan ready" },
  { id: "ask_user", label: "需要回答" },
  { id: "dangerous_action", label: "危险操作" },
  { id: "acceptance", label: "验收" },
  { id: "review_failed", label: "审查失败" },
  { id: "recovery", label: "中断恢复" }
];

export function WaitingOnMeCenter({
  items,
  loading,
  error,
  available,
  serviceUrl,
  onRefresh,
  onNavigate
}: WaitingOnMeCenterProps) {
  const bridge = useMemo(() => createChatBridge(serviceUrl), [serviceUrl]);
  const [filter, setFilter] = useState<"all" | WaitingItemKind>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const visible = filter === "all" ? items : items.filter((item) => item.kind === filter);

  const planReady = items.filter((i) => i.kind === "plan_approval");

  const confirmOne = async (item: WaitingItem) => {
    if (!item.runId || busyId) return;
    setBusyId(item.id);
    try {
      const result = await bridge.confirmToBuild(item.runId);
      setNotice(result.notice);
      onRefresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "确认失败");
    } finally {
      setBusyId(null);
    }
  };

  const confirmAllPlans = async () => {
    const ids = planReady.map((i) => i.runId).filter(Boolean);
    if (!ids.length) return;
    setBusyId("__all__");
    try {
      const result = await bridge.confirmMany(ids);
      setNotice(`Run ${result.ok}${result.fail ? ` · 失败 ${result.fail}` : ""}`);
      onRefresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "批量确认失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <TdsPage
      kicker="Inbox"
      title="Inbox"
      description="Plan ready 时点「确认并构建」。其它事项点开处理。"
      action={
        <div className="tds-inline-actions">
          {planReady.length > 0 ? (
            <TdsPrimaryButton
              onClick={() => void confirmAllPlans()}
              disabled={!available || !!busyId}
            >
              Run {planReady.length}
            </TdsPrimaryButton>
          ) : null}
          <TdsGhostButton onClick={onRefresh} disabled={!available || loading}>
            {loading ? "扫描中…" : "刷新"}
          </TdsGhostButton>
        </div>
      }
    >
      {error ? <div className="tds-banner err">{error}</div> : null}
      {notice ? <div className="tds-banner ok">{notice}</div> : null}

      <div className="tds-filter-row" role="tablist" aria-label="筛选类型">
        {filterKinds.map((kind) => (
          <button
            key={kind.id}
            type="button"
            role="tab"
            aria-selected={filter === kind.id}
            className={filter === kind.id ? "tds-filter-chip active" : "tds-filter-chip"}
            onClick={() => setFilter(kind.id)}
          >
            {kind.label}
          </button>
        ))}
      </div>

      {!available ? (
        <TdsEmpty title="服务离线" description="请打开 http://127.0.0.1:41731" />
      ) : visible.length === 0 ? (
        <TdsEmpty
          icon={<InboxIcon />}
          title="收件箱为空"
          description="Agent 需要你确认计划或回答时会出现在这里。"
          action={
            <TdsPrimaryButton onClick={() => onNavigate({ section: "todos" })}>
              前往 Todos
            </TdsPrimaryButton>
          }
        />
      ) : (
        <div className="tds-provider-list">
          {visible.map((item) => (
            <article key={item.id} className="tds-provider-row">
              <div className="tds-provider-main">
                <div className="tds-provider-title-row">
                  <h3>{item.title}</h3>
                  <span className="tds-chip warning">{waitingKindLabel(item.kind)}</span>
                </div>
                <p className="tds-muted">{item.detail || item.todoTitle || "—"}</p>
              </div>
              <div className="tds-provider-actions">
                {item.kind === "plan_approval" && item.runId ? (
                  <TdsPrimaryButton
                    disabled={!!busyId}
                    onClick={() => void confirmOne(item)}
                  >
                    {busyId === item.id ? "…" : "确认并构建"}
                  </TdsPrimaryButton>
                ) : null}
                <TdsGhostButton
                  onClick={() =>
                    onNavigate(
                      item.todoId
                        ? { section: "todos", todoId: item.todoId }
                        : { section: "waiting" }
                    )
                  }
                >
                  打开
                </TdsGhostButton>
              </div>
            </article>
          ))}
        </div>
      )}
    </TdsPage>
  );
}
