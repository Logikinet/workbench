import { useState } from "react";
import { createRoleClient, type AgentRoleRecord } from "../lib/roles.js";
import {
  createRoutingClient,
  type RouteDecisionInput,
  type RoutingDecisionRecord
} from "../lib/routing.js";

interface RoleRouterPanelProps {
  serviceUrl: string;
  available: boolean;
  /** Optional Run id to attach to the routing decision / queue payload. */
  runId?: string;
  onNotice?(message: string): void;
}

/**
 * Small Firstmate role-router inspector (Task 20).
 * Shows auto selection (role / model / harness / reason), allows override,
 * and can confirm temporary roles into the long-term library.
 * Mount from App when routing API is wired in the service.
 */
export function RoleRouterPanel({ serviceUrl, available, runId, onNotice }: RoleRouterPanelProps) {
  const routing = createRoutingClient(serviceUrl);
  const rolesClient = createRoleClient(serviceUrl);
  const [capabilities, setCapabilities] = useState("filesystem, shell, tests");
  const [complexity, setComplexity] = useState<"low" | "medium" | "high">("low");
  const [planApproved, setPlanApproved] = useState(true);
  const [decision, setDecision] = useState<RoutingDecisionRecord | null>(null);
  const [roles, setRoles] = useState<AgentRoleRecord[]>([]);
  const [overrideRoleId, setOverrideRoleId] = useState("");
  const [busy, setBusy] = useState(false);

  const notify = (message: string) => onNotice?.(message);

  const runRoute = async () => {
    if (!available) return;
    setBusy(true);
    try {
      const payload: RouteDecisionInput = {
        runId,
        complexity,
        planApproved,
        requiredCapabilities: splitList(capabilities)
      };
      const next = await routing.route(payload);
      setDecision(next);
      const listed = await rolesClient.list();
      setRoles(listed.filter((role) => role.enabled));
      if (!overrideRoleId && listed[0]) setOverrideRoleId(listed[0].id);
      notify(next.canAutoQueue ? "角色已就绪，可直接入队执行。" : next.autoQueueBlockedReason ?? "路由完成。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法路由角色");
    } finally {
      setBusy(false);
    }
  };

  const applyOverride = async () => {
    if (!decision || !overrideRoleId) return;
    setBusy(true);
    try {
      const next = await routing.override(decision.id, { roleId: overrideRoleId });
      setDecision(next);
      notify("已应用用户覆盖选择。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法覆盖角色");
    } finally {
      setBusy(false);
    }
  };

  const confirmTemporary = async (temporaryRoleId: string) => {
    if (!decision) return;
    setBusy(true);
    try {
      const result = await routing.confirmTemporary(decision.id, {
        temporaryRoleId,
        confirm: true
      });
      setDecision(result.decision);
      notify(`临时角色已确认并保存为长期角色「${result.role.name}」。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法确认临时角色");
    } finally {
      setBusy(false);
    }
  };

  if (!available) {
    return (
      <section className="panel">
        <h2>Firstmate 角色路由</h2>
        <p className="muted">服务不可用，无法预览自动角色选择。</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Firstmate 角色路由</h2>
      <p className="muted">
        计划批准后按能力 / Harness / Skills / Tools / 权限 / 启用状态 / allowFirstmateAutoInvoke 自动匹配；
        可在执行前覆盖；临时角色需确认后才进入长期库。
      </p>

      <div className="form-grid">
        <label>
          所需能力（逗号分隔）
          <input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} />
        </label>
        <label>
          复杂度
          <select value={complexity} onChange={(event) => setComplexity(event.target.value as typeof complexity)}>
            <option value="low">简单（单角色）</option>
            <option value="medium">中等</option>
            <option value="high">复杂（可多实例）</option>
          </select>
        </label>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={planApproved}
            onChange={(event) => setPlanApproved(event.target.checked)}
          />
          计划已批准（可自动入队）
        </label>
        <button type="button" disabled={busy} onClick={() => void runRoute()}>
          自动选择角色
        </button>
      </div>

      {decision && (
        <div className="stack" style={{ marginTop: "1rem" }}>
          <p>
            <strong>决策</strong> {decision.id.slice(0, 8)}…
            {decision.canAutoQueue ? (
              <span className="ok"> · 可直接入队</span>
            ) : (
              <span className="warn"> · {decision.autoQueueBlockedReason}</span>
            )}
          </p>
          <pre className="muted" style={{ whiteSpace: "pre-wrap" }}>{decision.explanation}</pre>

          {decision.instances.map((instance) => (
            <article key={instance.instanceId} className="card">
              <header>
                <strong>{instance.instanceName}</strong>
                <span className="muted"> · {instance.status}</span>
              </header>
              {instance.selection && (
                <ul>
                  <li>角色：{instance.selection.name}</li>
                  <li>模型：{instance.selection.modelId ?? "默认"}</li>
                  <li>Harness：{instance.selection.harness}</li>
                  <li>来源：{instance.selection.source}</li>
                </ul>
              )}
              <p>{instance.reason}</p>
              {instance.temporaryRole && !instance.temporaryRole.confirmedForLongTerm && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void confirmTemporary(instance.temporaryRole!.id)}
                >
                  确认保存为长期角色
                </button>
              )}
            </article>
          ))}

          <div className="form-grid">
            <label>
              执行前覆盖为
              <select value={overrideRoleId} onChange={(event) => setOverrideRoleId(event.target.value)}>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} ({role.harness}{role.modelId ? ` / ${role.modelId}` : ""})
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={busy || !overrideRoleId} onClick={() => void applyOverride()}>
              应用用户覆盖
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function splitList(value: string): string[] {
  return value.split(/[,，]/).map((part) => part.trim()).filter(Boolean);
}
