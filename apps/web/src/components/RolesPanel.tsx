import { useEffect, useState } from "react";
import { createConnectionClient, type ConnectionRecord } from "../lib/connections.js";
import { createRoleClient, type AgentRoleRecord, type RolePermissions } from "../lib/roles.js";

interface RolesPanelProps { serviceUrl: string; available: boolean; dataEpoch?: number; }

interface RoleDraft {
  name: string;
  responsibility: string;
  systemInstruction: string;
  connectionId: string;
  modelId: string;
  harness: "api" | "codex-cli";
  reasoningEffort: "low" | "medium" | "high";
  skills: string;
  tools: string;
  permissions: RolePermissions;
  allowFirstmateAutoInvoke: boolean;
}

const defaultPermissions: RolePermissions = { workspace: "project_only", network: false, shell: true, externalSend: false };
const emptyDraft: RoleDraft = {
  name: "", responsibility: "", systemInstruction: "", connectionId: "", modelId: "", harness: "api" as const,
  reasoningEffort: "medium" as const, skills: "implement, tdd", tools: "filesystem, shell", permissions: defaultPermissions,
  allowFirstmateAutoInvoke: false
};

export function RolesPanel({ serviceUrl, available, dataEpoch = 0 }: RolesPanelProps) {
  const client = createRoleClient(serviceUrl);
  const connectionsClient = createConnectionClient(serviceUrl);
  const [roles, setRoles] = useState<AgentRoleRecord[]>([]);
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState<AgentRoleRecord | null>(null);
  const [notice, setNotice] = useState("");

  const reload = async () => {
    if (!available) return;
    try {
      const [nextRoles, nextConnections] = await Promise.all([client.list(), connectionsClient.list()]);
      setRoles(nextRoles);
      setConnections(nextConnections.filter((connection) => connection.enabled));
      setNotice("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法读取 Agent Role"); }
  };
  useEffect(() => { void reload(); }, [available, dataEpoch]);

  const payload = () => ({
    name: draft.name,
    responsibility: draft.responsibility,
    systemInstruction: draft.systemInstruction,
    connectionId: draft.connectionId || null,
    modelId: draft.modelId || null,
    harness: draft.harness,
    reasoningEffort: draft.reasoningEffort,
    skills: splitList(draft.skills),
    tools: splitList(draft.tools),
    permissions: draft.permissions,
    allowFirstmateAutoInvoke: draft.allowFirstmateAutoInvoke
  });

  const changeHarness = (harness: RoleDraft["harness"]) => {
    setDraft((current) => harness === "codex-cli"
      ? {
          ...current,
          harness,
          connectionId: "",
          modelId: "",
          tools: ensureTools(current.tools, ["codex-cli", "filesystem", "shell"]),
          permissions: { ...current.permissions, workspace: "project_only", network: false, shell: true, externalSend: false }
        }
      : { ...current, harness });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const changed = editing ? await client.update(editing.id, payload()) : await client.create(payload());
      setRoles((current) => editing ? current.map((role) => role.id === changed.id ? changed : role) : [changed, ...current]);
      setEditing(null); setDraft(emptyDraft); setNotice(editing ? "Role 已更新。" : "Role 已创建。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法保存 Role"); }
  };

  const beginEdit = (role: AgentRoleRecord) => {
    setEditing(role);
    setDraft({
      name: role.name, responsibility: role.responsibility, systemInstruction: role.systemInstruction,
      connectionId: role.connectionId ?? "", modelId: role.modelId ?? "", harness: role.harness, reasoningEffort: role.reasoningEffort,
      skills: role.skills.join(", "), tools: role.tools.join(", "),
      permissions: role.harness === "codex-cli"
        ? { ...role.permissions, network: false, externalSend: false }
        : role.permissions,
      allowFirstmateAutoInvoke: role.allowFirstmateAutoInvoke
    });
  };

  const update = async (role: AgentRoleRecord, change: Partial<AgentRoleRecord>) => {
    try {
      const changed = await client.update(role.id, change);
      setRoles((current) => current.map((entry) => entry.id === changed.id ? changed : entry));
      return changed;
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法更新 Role"); return undefined; }
  };

  const verify = async (role: AgentRoleRecord) => {
    try {
      const result = await client.verify(role.id);
      setNotice(result.ready ? "Role 就绪：未启动正式 Run。" : `Role 未就绪：${[...result.missingSkills, ...result.missingTools, result.connection?.reason].filter(Boolean).join("；")}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法验证 Role"); }
  };

  const copy = async (role: AgentRoleRecord) => {
    try {
      const duplicate = await client.copy(role.id);
      setRoles((current) => [duplicate, ...current]);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法复制 Role"); }
  };

  const remove = async (role: AgentRoleRecord) => {
    try {
      await client.remove(role.id);
      setRoles((current) => current.filter((entry) => entry.id !== role.id));
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法删除 Role"); }
  };

  return <section className="workspace-panel" aria-labelledby="roles-title">
    <div className="section-heading"><div><p className="eyebrow">AGENT ROLES</p><h2 id="roles-title">Agent Role</h2></div><button type="button" className="quiet-button" onClick={() => void reload()} disabled={!available}>刷新</button></div>
    <p className="protected-note">Firstmate 的编排与安全规则受保护，不能由普通 Role 覆盖。</p>
    <form className="role-form" onSubmit={submit}>
      <input required aria-label="Role 名称" placeholder="Role 名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      <input required aria-label="职责" placeholder="职责" value={draft.responsibility} onChange={(event) => setDraft({ ...draft, responsibility: event.target.value })} />
      <textarea required aria-label="系统指令" placeholder="系统指令" value={draft.systemInstruction} onChange={(event) => setDraft({ ...draft, systemInstruction: event.target.value })} />
      {draft.harness === "api" ? <><select aria-label="模型连接" value={draft.connectionId} onChange={(event) => setDraft({ ...draft, connectionId: event.target.value })}><option value="">不绑定模型连接</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select>
      <input aria-label="Role 模型 ID" placeholder="覆盖模型 ID（可选）" value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} /></> : <p className="protected-note">Codex CLI Role 使用本机 Codex 登录，不绑定工作台 API 连接。</p>}
      <select aria-label="Harness" value={draft.harness} onChange={(event) => changeHarness(event.target.value as "api" | "codex-cli")}><option value="api">API</option><option value="codex-cli">Codex CLI</option></select>
      <select aria-label="推理强度" value={draft.reasoningEffort} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value as "low" | "medium" | "high" })}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select>
      <input aria-label="Skills" placeholder="Skills（逗号分隔）" value={draft.skills} onChange={(event) => setDraft({ ...draft, skills: event.target.value })} />
      <input aria-label="Tools" placeholder="Tools（逗号分隔）" value={draft.tools} onChange={(event) => setDraft({ ...draft, tools: event.target.value })} />
      <select aria-label="工作区权限" value={draft.permissions.workspace} onChange={(event) => setDraft({ ...draft, permissions: { ...draft.permissions, workspace: event.target.value as RolePermissions["workspace"] } })}><option value="project_only">仅项目工作区</option><option value="read_only">只读</option></select>
      <label className="inline-check"><input type="checkbox" disabled={draft.harness === "codex-cli"} checked={draft.permissions.network} onChange={(event) => setDraft({ ...draft, permissions: { ...draft.permissions, network: event.target.checked } })} />允许网络</label>
      <label className="inline-check"><input type="checkbox" checked={draft.permissions.shell} onChange={(event) => setDraft({ ...draft, permissions: { ...draft.permissions, shell: event.target.checked } })} />允许 Shell</label>
      <label className="inline-check"><input type="checkbox" disabled={draft.harness === "codex-cli"} checked={draft.permissions.externalSend} onChange={(event) => setDraft({ ...draft, permissions: { ...draft.permissions, externalSend: event.target.checked } })} />允许外发</label>
      <label className="inline-check"><input type="checkbox" checked={draft.allowFirstmateAutoInvoke} onChange={(event) => setDraft({ ...draft, allowFirstmateAutoInvoke: event.target.checked })} />允许 Firstmate 自动调用</label>
      <div className="project-actions"><button type="submit" disabled={!available}>{editing ? "保存 Role" : "创建 Role"}</button>{editing && <button type="button" className="quiet-button" onClick={() => { setEditing(null); setDraft(emptyDraft); }}>取消</button>}</div>
    </form>
    {notice && <p className="notice" role="status">{notice}</p>}
    <ul className="role-list">{roles.map((role) => <li key={role.id}><div><strong>{role.name}</strong><span>{role.harness} · {role.reasoningEffort} · {role.responsibility}</span><small>{role.skills.join(", ")} · {role.tools.join(", ")}</small></div><div className="project-actions"><span className={`tag ${role.enabled ? "active" : "archived"}`}>{role.enabled ? "已启用" : "已停用"}</span><button type="button" className="quiet-button" onClick={() => void verify(role)}>验证</button><button type="button" className="quiet-button" onClick={() => void copy(role)}>复制</button><button type="button" className="quiet-button" onClick={() => beginEdit(role)}>编辑</button><button type="button" className="quiet-button" onClick={() => void update(role, { enabled: !role.enabled })}>{role.enabled ? "停用" : "启用"}</button><button type="button" className="quiet-button" onClick={() => void remove(role)}>删除</button></div></li>)}</ul>
  </section>;
}

function splitList(value: string): string[] { return value.split(",").map((entry) => entry.trim()).filter(Boolean); }

function ensureTools(value: string, required: string[]): string {
  return [...new Set([...splitList(value), ...required])].join(", ");
}
