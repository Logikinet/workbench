import { useEffect, useState } from "react";
import { createRoleClient, type AgentRoleRecord } from "../lib/roles.js";
import { createRunClient, type CodexCliStatusRecord, type RunRecord } from "../lib/runs.js";

interface CodexHarnessPanelProps {
  serviceUrl: string;
  run: RunRecord;
  onRunChange(run: RunRecord): void;
  onNotice(message: string): void;
}

export function CodexHarnessPanel({ serviceUrl, run, onRunChange, onNotice }: CodexHarnessPanelProps) {
  const runClient = createRunClient(serviceUrl);
  const roleClient = createRoleClient(serviceUrl);
  const [status, setStatus] = useState<CodexCliStatusRecord | null>(null);
  const [roles, setRoles] = useState<AgentRoleRecord[]>([]);
  const [roleId, setRoleId] = useState("");

  const reload = async () => {
    try {
      const [nextStatus, nextRoles] = await Promise.all([runClient.codexCliStatus(), roleClient.list()]);
      const codexRoles = nextRoles.filter((role) => role.enabled && role.harness === "codex-cli");
      setStatus(nextStatus);
      setRoles(codexRoles);
      setRoleId((current) => current || codexRoles[0]?.id || "");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法读取 Codex CLI 状态或 Role");
    }
  };

  useEffect(() => { void reload(); }, [serviceUrl, run.id]);

  const start = async () => {
    try {
      const changed = await runClient.executeCodexCli(run.id, { roleId });
      onRunChange(changed);
      if (changed.status === "running") {
        onNotice("Firstmate 已在当前 Project 工作目录启动 Codex CLI；输出会持续写入此 Run 时间线。");
      } else {
        onNotice(`Codex CLI 已暂停：${changed.execution.lastError ?? changed.timeline.at(-1)?.summary ?? "请根据时间线处理后重试。"}`);
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法启动 Codex CLI");
    }
  };

  const ready = Boolean(status?.installed && status.authenticated);
  return <section className="codex-harness-panel" aria-label="Codex CLI Harness">
    <header><p className="eyebrow">CODEX CLI HARNESS</p><h4>在已批准的 Project 中执行</h4></header>
    <p>Codex 使用本机登录与受限工作区运行，不使用工作台保存的 API 密钥；此非交互 Harness 会关闭网络与外发能力。</p>
    <div className={`codex-status ${ready ? "ready" : "unavailable"}`} role="status">
      <strong>{ready ? "Codex CLI 已就绪" : "Codex CLI 不可用"}</strong>
      {status?.version && <span>{status.version}</span>}
      {!ready && <span>{status?.reason ?? "正在检测本机 Codex CLI。"}</span>}
      <button type="button" className="quiet-button" onClick={() => void reload()}>重新检测</button>
    </div>
    {run.execution.status === "idle" && <div className="codex-start">
      <label>已有 Codex CLI Role
        <select aria-label="已有 Codex CLI Role" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
          <option value="">选择 Role</option>
          {roles.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.responsibility}</option>)}
        </select>
      </label>
      <button type="button" disabled={!ready || !roleId} onClick={() => void start()}>启动 Codex CLI</button>
    </div>}
  </section>;
}
