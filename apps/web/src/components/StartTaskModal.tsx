/**
 * todos「开始任务」弹窗：规划 Agent + 执行 Agent + 分用开关 + 先做规划
 */

import { useEffect, useState } from "react";
import type { AgentRoleRecord } from "../lib/roles.js";

export interface StartTaskChoice {
  planRoleId: string;
  execRoleId: string;
  splitAgents: boolean;
}

interface StartTaskModalProps {
  open: boolean;
  roles: AgentRoleRecord[];
  defaultRoleId?: string;
  onClose(): void;
  onConfirm(choice: StartTaskChoice): void;
  busy?: boolean;
}

export function StartTaskModal({
  open,
  roles,
  defaultRoleId,
  onClose,
  onConfirm,
  busy
}: StartTaskModalProps) {
  const enabled = roles.filter((r) => r.enabled);
  const first = defaultRoleId || enabled[0]?.id || "";
  const [planRoleId, setPlanRoleId] = useState(first);
  const [execRoleId, setExecRoleId] = useState(first);
  const [splitAgents, setSplitAgents] = useState(true);
  const [picking, setPicking] = useState<"plan" | "exec" | null>(null);

  useEffect(() => {
    if (!open) return;
    const id = defaultRoleId || enabled[0]?.id || "";
    setPlanRoleId(id);
    setExecRoleId(id);
    setSplitAgents(true);
    setPicking(null);
  }, [open, defaultRoleId, enabled.length]);

  if (!open) return null;

  const planRole = enabled.find((r) => r.id === planRoleId);
  const execRole = enabled.find((r) => r.id === (splitAgents ? execRoleId : planRoleId));

  const roleRow = (role: AgentRoleRecord | undefined, onPick: () => void) => (
    <button type="button" className="tds-start-agent-row" onClick={onPick} disabled={busy}>
      <span className="tds-start-av">{role?.name?.slice(0, 1) || "?"}</span>
      <span className="tds-start-agent-meta">
        <strong>{role?.name || "选择 Agent"}</strong>
        <small>{role?.modelId || "未绑模型"}</small>
      </span>
      <span className="tds-start-chevron">›</span>
    </button>
  );

  return (
    <div className="tds-modal-mask" onClick={() => !busy && onClose()}>
      <div className="tds-modal tds-start-modal" onClick={(e) => e.stopPropagation()}>
        {picking ? (
          <>
            <div className="tds-modal-head">
              <button type="button" className="tds-back-btn" onClick={() => setPicking(null)}>
                ‹ 选择{picking === "plan" ? "规划" : "执行"} Agent
              </button>
              <button type="button" className="tds-modal-x" onClick={onClose}>
                ×
              </button>
            </div>
            <div className="tds-agent-pick-list">
              <button
                type="button"
                className="tds-agent-pick-item"
                onClick={() => {
                  if (picking === "plan") setPlanRoleId("");
                  else setExecRoleId("");
                  setPicking(null);
                }}
              >
                <span className="tds-start-av muted">–</span>
                <span>未指派</span>
              </button>
              {enabled.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`tds-agent-pick-item${
                    (picking === "plan" ? planRoleId : execRoleId) === r.id ? " selected" : ""
                  }`}
                  onClick={() => {
                    if (picking === "plan") setPlanRoleId(r.id);
                    else setExecRoleId(r.id);
                    setPicking(null);
                  }}
                >
                  <span className="tds-start-av">{r.name.slice(0, 1)}</span>
                  <span className="tds-start-agent-meta">
                    <strong>{r.name}</strong>
                    <small>{r.modelId || "未绑模型"}</small>
                  </span>
                  {(picking === "plan" ? planRoleId : execRoleId) === r.id ? (
                    <span className="tds-check">✓</span>
                  ) : null}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="tds-modal-head">
              <strong>开始任务</strong>
              <button type="button" className="tds-modal-x" onClick={onClose}>
                ×
              </button>
            </div>

            <div className="tds-start-section">
              <div className="tds-start-label">规划</div>
              {roleRow(planRole, () => setPicking("plan"))}
            </div>

            <div className="tds-start-section">
              <div className="tds-start-label">执行</div>
              {roleRow(execRole, () => setPicking("exec"))}
            </div>

            <label className="tds-start-toggle">
              <span>规划与执行分用不同 Agent</span>
              <input
                type="checkbox"
                checked={splitAgents}
                onChange={(e) => setSplitAgents(e.target.checked)}
              />
              <i className={`tds-switch${splitAgents ? " on" : ""}`} />
            </label>

            <button
              type="button"
              className="tds-btn-primary tds-modal-submit"
              disabled={busy || !planRoleId}
              onClick={() =>
                onConfirm({
                  planRoleId,
                  execRoleId: splitAgents ? execRoleId || planRoleId : planRoleId,
                  splitAgents
                })
              }
            >
              {busy ? "启动中…" : "先做规划"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
