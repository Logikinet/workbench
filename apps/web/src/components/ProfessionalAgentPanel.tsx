import { useEffect, useState } from "react";
import { createConnectionClient, type ConnectionRecord } from "../lib/connections.js";
import { createRoleClient, type AgentRoleRecord } from "../lib/roles.js";
import { createRunClient, type RunRecord } from "../lib/runs.js";

interface ProfessionalAgentPanelProps {
  serviceUrl: string;
  run: RunRecord;
  onRunChange(run: RunRecord): void;
  onNotice(message: string): void;
}

interface TemporaryDraft {
  name: string;
  responsibility: string;
  systemInstruction: string;
  connectionId: string;
  modelId: string;
  saveTemporaryRole: boolean;
  confirmSaveTemporaryRole: boolean;
}

const defaultTemporary: TemporaryDraft = {
  name: "临时 Professional Agent",
  responsibility: "在批准的项目工作区内完成受限文件任务",
  systemInstruction: "仅返回受限的 write_file JSON 动作，不请求危险操作。",
  connectionId: "",
  modelId: "",
  saveTemporaryRole: false,
  confirmSaveTemporaryRole: false
};

export function ProfessionalAgentPanel({ serviceUrl, run, onRunChange, onNotice }: ProfessionalAgentPanelProps) {
  const runClient = createRunClient(serviceUrl);
  const roleClient = createRoleClient(serviceUrl);
  const connectionClient = createConnectionClient(serviceUrl);
  const [roles, setRoles] = useState<AgentRoleRecord[]>([]);
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [mode, setMode] = useState<"role" | "temporary">("role");
  const [roleId, setRoleId] = useState("");
  const [temporary, setTemporary] = useState(defaultTemporary);
  const [correction, setCorrection] = useState("");
  const [changeKind, setChangeKind] = useState<"minor" | "goal" | "scope" | "acceptance" | "prohibition">("minor");
  const controlsCodex = run.execution.selectedAgent?.harness === "codex-cli";

  useEffect(() => {
    void Promise.all([roleClient.list(), connectionClient.list()])
      .then(([nextRoles, nextConnections]) => {
        const apiRoles = nextRoles.filter((role) => role.enabled && role.harness === "api");
        setRoles(apiRoles);
        setConnections(nextConnections.filter((connection) => connection.enabled));
        if (!roleId && apiRoles[0]) setRoleId(apiRoles[0].id);
        if (!temporary.connectionId && nextConnections.find((connection) => connection.enabled)) {
          setTemporary((current) => ({ ...current, connectionId: nextConnections.find((connection) => connection.enabled)!.id }));
        }
      })
      .catch((error: unknown) => onNotice(error instanceof Error ? error.message : "无法读取可用 Agent Role"));
  }, [serviceUrl, run.id]);

  const start = async () => {
    try {
      const changed = await runClient.executeProfessionalAgent(run.id, mode === "role"
        ? { roleId }
        : {
            temporaryAgent: {
              name: temporary.name,
              responsibility: temporary.responsibility,
              systemInstruction: temporary.systemInstruction,
              connectionId: temporary.connectionId,
              modelId: temporary.modelId || undefined,
              tools: ["filesystem"]
            },
            saveTemporaryRole: temporary.saveTemporaryRole,
            confirmSaveTemporaryRole: temporary.confirmSaveTemporaryRole
          });
      onRunChange(changed);
      onNotice("Firstmate 已选择 Professional Agent，执行状态会持续更新到此 Run。" );
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法启动 Professional Agent"); }
  };

  const retry = async () => {
    try {
      const changed = run.execution.selectedAgent?.harness === "codex-cli"
        ? await runClient.executeCodexCli(run.id)
        : await runClient.executeProfessionalAgent(run.id);
      onRunChange(changed);
      onNotice(run.execution.selectedAgent?.harness === "codex-cli"
        ? "正在重试上次 Codex CLI Role；已完成步骤会保留。"
        : "正在重试上次 Professional Agent；已完成步骤会保留。" );
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法重试 Professional Agent"); }
  };

  const stop = async () => {
    try {
      const changed = await runClient.stop(run.id, "用户停止当前 Run。");
      onRunChange(changed);
      onNotice("已停止此 Run；已执行步骤和停止原因已记录到时间线。");
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法停止 Run"); }
  };

  const correctAndContinue = async () => {
    if (!correction.trim()) return;
    try {
      const changed = await runClient.correctAndContinue(run.id, { instruction: correction, changeKind });
      onRunChange(changed);
      setCorrection("");
      onNotice(changeKind === "minor" ? "已应用小范围纠偏并继续受控执行。" : "纠偏已生成计划变更，等待重新审批。");
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法应用纠偏"); }
  };

  const decideExecutionApproval = async (decision: "approved" | "rejected") => {
    try {
      const changed = await runClient.decideExecutionApproval(run.id, {
        decision,
        summary: decision === "approved" ? "用户已确认该危险操作。" : "用户拒绝该危险操作。"
      });
      onRunChange(changed);
      onNotice(decision === "approved" ? "确认已记录；请继续或纠偏后再启动代理。" : "拒绝已记录；可提交纠偏后继续。" );
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法记录危险操作决定"); }
  };

  return <section className="professional-agent-panel" aria-label={controlsCodex ? "Codex CLI 执行控制" : "Professional Agent 执行"}>
    <header><p className="eyebrow">{controlsCodex ? "RUN EXECUTION CONTROL" : "PROFESSIONAL AGENT"}</p><h4>{controlsCodex ? "Codex CLI 执行控制" : "Firstmate 选择执行代理"}</h4></header>
    <p>{controlsCodex ? "停止、重试与纠偏仍由 Run 的受控执行边界处理。" : "计划已获批。Firstmate 只负责编排；文件操作由受限 Professional Agent 经本地工作区边界执行。"}</p>
    {run.execution.status === "idle" && <>
      <div className="agent-mode"><label><input type="radio" checked={mode === "role"} onChange={() => setMode("role")} />使用已有 Role</label><label><input type="radio" checked={mode === "temporary"} onChange={() => setMode("temporary")} />创建临时 Agent</label></div>
      {mode === "role" ? <label>已有 API Role<select aria-label="已有 API Role" value={roleId} onChange={(event) => setRoleId(event.target.value)}><option value="">选择 Role</option>{roles.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.responsibility}</option>)}</select></label> : <div className="temporary-agent-form"><input required aria-label="临时 Agent 名称" placeholder="临时 Agent 名称" value={temporary.name} onChange={(event) => setTemporary({ ...temporary, name: event.target.value })} /><input required aria-label="临时 Agent 职责" placeholder="职责" value={temporary.responsibility} onChange={(event) => setTemporary({ ...temporary, responsibility: event.target.value })} /><textarea required aria-label="临时 Agent 系统指令" placeholder="系统指令" value={temporary.systemInstruction} onChange={(event) => setTemporary({ ...temporary, systemInstruction: event.target.value })} /><select aria-label="临时 Agent 模型连接" value={temporary.connectionId} onChange={(event) => setTemporary({ ...temporary, connectionId: event.target.value })}><option value="">选择模型连接</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select><input aria-label="临时 Agent 模型 ID" placeholder="覆盖模型 ID（可选）" value={temporary.modelId} onChange={(event) => setTemporary({ ...temporary, modelId: event.target.value })} /><label className="inline-check"><input type="checkbox" checked={temporary.saveTemporaryRole} onChange={(event) => setTemporary({ ...temporary, saveTemporaryRole: event.target.checked, confirmSaveTemporaryRole: event.target.checked ? temporary.confirmSaveTemporaryRole : false })} />保存为长期 Role</label>{temporary.saveTemporaryRole && <label className="inline-check"><input type="checkbox" checked={temporary.confirmSaveTemporaryRole} onChange={(event) => setTemporary({ ...temporary, confirmSaveTemporaryRole: event.target.checked })} />我确认保存此临时 Agent</label>}</div>}
      <button type="button" onClick={() => void start()} disabled={mode === "role" ? !roleId : !temporary.connectionId}>启动 Professional Agent</button>
    </>}
    {run.execution.status !== "idle" && <div className="execution-state">
      <span className={`tag ${run.execution.status === "succeeded" ? "active" : "archived"}`}>{run.execution.status}</span>
      {run.execution.selectedAgent && <span>{run.execution.selectedAgent.name}</span>}
      {run.execution.completedSteps.length > 0 && <small>已完成：{run.execution.completedSteps.join("、")}</small>}
      {run.execution.lastError && <p className="notice">错误：{run.execution.lastError}</p>}
      {run.execution.pendingApproval?.status === "awaiting_confirmation" && <div className="execution-approval" role="alert">
        <strong>需要确认：{run.execution.pendingApproval.kind}</strong>
        <p>{run.execution.pendingApproval.summary}</p>
        <button type="button" onClick={() => void decideExecutionApproval("approved")}>确认并记录</button>
        <button type="button" className="quiet-button" onClick={() => void decideExecutionApproval("rejected")}>拒绝操作</button>
      </div>}
      {run.execution.retryable && run.execution.pendingApproval?.status !== "awaiting_confirmation" && <button type="button" className="quiet-button" onClick={() => void retry()}>重试上次 Agent</button>}
      {run.execution.terminationUnconfirmed && <p className="notice">尚未确认执行进程已终止；Run 保持暂停，不能标记为已取消。</p>}
      {["running", "queued", "paused", "failed", "interrupted"].includes(run.status) && !run.execution.terminationUnconfirmed && <button type="button" className="danger-button" onClick={() => void stop()}>停止此 Run</button>}
      {run.execution.selectedAgent && run.execution.status !== "succeeded" && run.status !== "cancelled" && <div className="correction-form">
        <textarea aria-label="纠偏指令" placeholder="输入小范围纠偏；目标、范围、验收或禁止项变化会重新审批。" value={correction} onChange={(event) => setCorrection(event.target.value)} />
        <select aria-label="纠偏类型" value={changeKind} onChange={(event) => setChangeKind(event.target.value as typeof changeKind)}>
          <option value="minor">小范围纠偏</option><option value="goal">改变目标</option><option value="scope">改变范围</option><option value="acceptance">改变验收条件</option><option value="prohibition">改变禁止项</option>
        </select>
        <button type="button" className="quiet-button" disabled={!correction.trim()} onClick={() => void correctAndContinue()}>纠偏并继续</button>
      </div>}
    </div>}
  </section>;
}
