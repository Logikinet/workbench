import { useEffect, useState } from "react";
import { createConnectionClient, type ConnectionRecord } from "../lib/connections.js";

interface ConnectionsPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
}

const emptyDraft = { name: "", baseUrl: "", apiKey: "", modelId: "" };

export function ConnectionsPanel({ serviceUrl, available, dataEpoch = 0 }: ConnectionsPanelProps) {
  const client = createConnectionClient(serviceUrl);
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState<ConnectionRecord | null>(null);
  const [notice, setNotice] = useState("");

  const reload = async () => {
    if (!available) return;
    try {
      setConnections(await client.list());
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取模型连接");
    }
  };

  useEffect(() => { void reload(); }, [available, dataEpoch]);

  const saveNew = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const connection = await client.create(draft);
      setConnections((current) => [connection, ...current]);
      setDraft(emptyDraft);
      setNotice("连接已保存，API Key 已进入 Windows 本机安全凭据库。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法保存连接");
    }
  };

  const update = async (connection: ConnectionRecord, payload: Parameters<typeof client.update>[1]) => {
    try {
      const changed = await client.update(connection.id, payload);
      setConnections((current) => current.map((entry) => entry.id === changed.id ? changed : entry));
      setNotice("连接已更新。");
      return changed;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法更新连接");
      return undefined;
    }
  };

  const runTest = async (connection: ConnectionRecord) => {
    try {
      const result = await client.test(connection.id);
      setNotice(`${result.kind}：${result.message}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法测试连接");
    }
  };

  const remove = async (connection: ConnectionRecord) => {
    if (!window.confirm(`删除连接“${connection.name}”？`)) return;
    try {
      await client.remove(connection.id);
      setConnections((current) => current.filter((entry) => entry.id !== connection.id));
      setNotice("连接和本机凭据已删除。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法删除连接");
    }
  };

  const beginEdit = (connection: ConnectionRecord) => {
    setEditing(connection);
    setDraft({ name: connection.name, baseUrl: connection.baseUrl, apiKey: "", modelId: connection.modelId });
  };

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const changed = await update(editing, {
      name: draft.name,
      baseUrl: draft.baseUrl,
      modelId: draft.modelId,
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {})
    });
    if (changed) {
      setEditing(null);
      setDraft(emptyDraft);
    }
  };

  const form = (
    <form className="connection-form" onSubmit={editing ? saveEdit : saveNew}>
      <input aria-label="连接名称" placeholder="连接名称（可选）" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      <input required aria-label="Base URL" placeholder="https://api.yairouter.com/v1" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
      <input required={!editing} type="password" aria-label="API Key" placeholder={editing ? "留空则不更换 API Key" : "API Key"} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} />
      <input required aria-label="模型 ID" placeholder="模型 ID" value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} />
      <div className="project-actions">
        <button type="submit" disabled={!available}>{editing ? "保存修改" : "保存连接"}</button>
        {editing && <button type="button" className="quiet-button" onClick={() => { setEditing(null); setDraft(emptyDraft); }}>取消</button>}
      </div>
    </form>
  );

  return (
    <section className="workspace-panel" aria-labelledby="connections-title">
      <div className="section-heading">
        <div><p className="eyebrow">MODEL CONNECTIONS</p><h2 id="connections-title">模型连接</h2></div>
        <button type="button" className="quiet-button" onClick={() => void reload()} disabled={!available}>刷新</button>
      </div>
      {form}
      {notice && <p className="notice" role="status">{notice}</p>}
      <ul className="connection-list">
        {connections.map((connection) => (
          <li key={connection.id}>
            <div><strong>{connection.name}</strong><span>{connection.modelId} · {connection.baseUrl}</span></div>
            <div className="project-actions">
              <span className={`tag ${connection.enabled ? "active" : "archived"}`}>{connection.enabled ? "已启用" : "已停用"}</span>
              <button type="button" className="quiet-button" onClick={() => void runTest(connection)}>测试</button>
              <button type="button" className="quiet-button" onClick={() => beginEdit(connection)}>编辑</button>
              <button type="button" className="quiet-button" onClick={() => void update(connection, { enabled: !connection.enabled })}>{connection.enabled ? "停用" : "启用"}</button>
              <button type="button" className="quiet-button" onClick={() => void remove(connection)}>删除</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
