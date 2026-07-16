/**
 * todos team home (from PixPin_2026-07-16_21-42-11):
 * 欢迎回来 · agent avatars · status chips · 需要处理 · 邀请队友
 */

import { useEffect, useState } from "react";
import { createRoleClient, type AgentRoleRecord } from "../lib/roles.js";
import type { WorkbenchRoute } from "../lib/workbenchRoutes.js";
import type { WaitingItem } from "../lib/waitingOnMe.js";
import type { WorkbenchStatusCounts } from "../lib/waitingOnMe.js";

interface TeamPanelProps {
  online: boolean;
  statusLabel: string;
  serviceUrl: string;
  counts: WorkbenchStatusCounts;
  waitingItems: WaitingItem[];
  onNavigate(route: WorkbenchRoute): void;
}

export function TeamPanel({
  online,
  serviceUrl,
  counts,
  waitingItems,
  onNavigate
}: TeamPanelProps) {
  const [roles, setRoles] = useState<AgentRoleRecord[]>([]);

  useEffect(() => {
    void createRoleClient(serviceUrl)
      .list()
      .then((list) => setRoles(list.filter((r) => r.enabled).slice(0, 8)))
      .catch(() => setRoles([]));
  }, [serviceUrl]);

  const need = waitingItems.slice(0, 5);

  return (
    <div className="tds-team-home">
      <header className="tds-team-head">
        <div className="tds-team-title-row">
          <h1>欢迎回来</h1>
          <button type="button" className="tds-team-dropdown" onClick={() => onNavigate({ section: "settings" })}>
            本地 team ▾
          </button>
        </div>
        <div className="tds-avatar-stack">
          <span className="tds-av tds-av-me">本</span>
          {roles.map((r) => (
            <span key={r.id} className="tds-av" title={r.name}>
              {r.name.slice(0, 1)}
            </span>
          ))}
          <button
            type="button"
            className="tds-av tds-av-add"
            title="创建 Agent"
            onClick={() => onNavigate({ section: "agents" })}
          >
            +
          </button>
        </div>
      </header>

      <div className="tds-stat-row">
        <button type="button" className="tds-stat" onClick={() => onNavigate({ section: "waiting" })}>
          <i className="dot amber" />
          <b>{counts.waitingOnUser + counts.pending}</b>
          <span>待处理</span>
        </button>
        <button type="button" className="tds-stat" onClick={() => onNavigate({ section: "todos" })}>
          <i className="dot blue" />
          <b>{counts.running}</b>
          <span>进行中</span>
        </button>
        <button type="button" className="tds-stat">
          <i className="dot red" />
          <b>{counts.reviewFailed}</b>
          <span>失败</span>
        </button>
        <button type="button" className="tds-stat" onClick={() => onNavigate({ section: "todos" })}>
          <i className="dot gray" />
          <b>{counts.pending}</b>
          <span>待办</span>
        </button>
      </div>

      <section className="tds-team-section">
        <h2>需要处理</h2>
        {need.length === 0 ? (
          <div className="tds-team-empty-row">暂无需要你处理的事项</div>
        ) : (
          <div className="tds-need-list">
            {need.map((item) => (
              <button
                key={item.id}
                type="button"
                className="tds-need-row"
                onClick={() =>
                  onNavigate(
                    item.todoId
                      ? { section: "todos", todoId: item.todoId }
                      : { section: "waiting" }
                  )
                }
              >
                <span className="tds-need-hash">#</span>
                <span className="tds-need-title">{item.title || item.todoTitle}</span>
                <span className="tds-need-go">›</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="tds-team-section">
        <div className="tds-invite-card">
          <div>
            <strong>邀请队友</strong>
            <p>本地单机模式：可配置多个 Agent 协同。云端邀请暂不支持。</p>
          </div>
          <button type="button" className="tds-link-btn" onClick={() => onNavigate({ section: "agents" })}>
            管理 Agents
          </button>
        </div>
      </section>

      <p className="tds-team-foot">
        执行器：{online ? "在线" : "离线"} · 打开{" "}
        <button type="button" className="tds-link-btn" onClick={() => onNavigate({ section: "home" })}>
          总管
        </button>{" "}
        开始派活
      </p>
    </div>
  );
}
