import { useEffect, useMemo, useState } from "react";
import {
  createConnectionClient,
  type ConnectionRecord,
  type ProviderPreset
} from "../lib/connections.js";

interface ConnectionsPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
}

const emptyDraft = {
  name: "",
  baseUrl: "",
  apiKey: "",
  modelId: "",
  presetId: "custom"
};

export function ConnectionsPanel({ serviceUrl, available, dataEpoch = 0 }: ConnectionsPanelProps) {
  const client = useMemo(() => createConnectionClient(serviceUrl), [serviceUrl]);
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState<ConnectionRecord | null>(null);
  const [notice, setNotice] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [manualModel, setManualModel] = useState(true);

  const selectedPreset = presets.find((preset) => preset.id === draft.presetId);

  const reload = async () => {
    if (!available) return;
    try {
      const [list, presetList] = await Promise.all([client.list(), client.listPresets()]);
      setConnections(list);
      setPresets(presetList);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取模型连接");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, dataEpoch, serviceUrl]);

  useEffect(() => {
    if (!selectedPreset) return;
    if (selectedPreset.defaultBaseUrl && !selectedPreset.allowCustomBaseUrl) {
      setDraft((current) => ({ ...current, baseUrl: selectedPreset.defaultBaseUrl ?? current.baseUrl }));
    } else if (selectedPreset.defaultBaseUrl && !draft.baseUrl) {
      setDraft((current) => ({ ...current, baseUrl: selectedPreset.defaultBaseUrl ?? "" }));
    }
  }, [draft.presetId]);

  const saveNew = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const connection = await client.create({
        name: draft.name || undefined,
        baseUrl: draft.baseUrl || undefined,
        apiKey: draft.apiKey || undefined,
        modelId: draft.modelId,
        presetId: draft.presetId
      });
      setConnections((current) => [connection, ...current]);
      setDraft(emptyDraft);
      setNotice("连接已保存并热应用。API Key 仅写入 Windows 本机凭据库，界面不回显完整密钥。");
      try {
        await client.hotApply(connection.id);
      } catch {
        // Enhanced routes may not be mounted yet; create still persisted.
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法保存连接");
    }
  };

  const update = async (connection: ConnectionRecord, payload: Parameters<typeof client.update>[1]) => {
    try {
      const changed = await client.update(connection.id, payload);
      setConnections((current) => current.map((entry) => (entry.id === changed.id ? changed : entry)));
      setNotice("连接已更新（非敏感配置已热应用，无需重启工作台）。");
      try {
        await client.hotApply(connection.id);
      } catch {
        /* optional */
      }
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
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法测试连接");
    }
  };

  const runProbe = async (connection: ConnectionRecord) => {
    try {
      const result = await client.probe(connection.id);
      setNotice(`能力探测：${result.message}`);
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法进行能力探测（路由可能尚未挂载）");
    }
  };

  const runUsage = async (connection: ConnectionRecord) => {
    try {
      const result = await client.usage(connection.id);
      const tokens =
        result.totalTokens !== undefined
          ? ` · tokens=${result.totalTokens}`
          : result.promptTokens !== undefined
            ? ` · prompt=${result.promptTokens}`
            : "";
      setNotice(`Usage：${result.message}${tokens}`);
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取 Usage 快照");
    }
  };

  const loadModels = async (connection: ConnectionRecord) => {
    try {
      const result = await client.listModels(connection.id);
      setModelOptions(result.models.map((model) => model.id));
      setManualModel(result.manualModelIdRequired || result.models.length === 0);
      setNotice(result.message);
    } catch (error) {
      setManualModel(true);
      setModelOptions([]);
      setNotice(error instanceof Error ? error.message : "无法拉取模型列表，请手动填写模型 ID");
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
    setDraft({
      name: connection.name,
      baseUrl: connection.baseUrl,
      apiKey: "",
      modelId: connection.modelId,
      presetId: connection.presetId ?? "custom"
    });
    setModelOptions([]);
    setManualModel(true);
  };

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const changed = await update(editing, {
      name: draft.name,
      baseUrl: draft.baseUrl,
      modelId: draft.modelId,
      presetId: draft.presetId,
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {})
    });
    if (changed) {
      setEditing(null);
      setDraft(emptyDraft);
    }
  };

  const credentialRequired = selectedPreset?.requiresCredential !== false;

  const form = (
    <form className="role-form" onSubmit={editing ? saveEdit : saveNew}>
      <label>
        Provider Preset
        <select
          aria-label="Provider Preset"
          value={draft.presetId}
          onChange={(event) => setDraft({ ...draft, presetId: event.target.value })}
        >
          {(presets.length ? presets : [{ id: "custom", name: "自定义 OpenAI-compatible" } as ProviderPreset]).map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </label>
      <input
        aria-label="连接名称"
        placeholder="连接名称（可选）"
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <input
        required={!selectedPreset?.defaultBaseUrl || selectedPreset.allowCustomBaseUrl}
        aria-label="Base URL"
        placeholder={selectedPreset?.defaultBaseUrl ?? "https://api.example.com/v1"}
        value={draft.baseUrl}
        disabled={selectedPreset ? !selectedPreset.allowCustomBaseUrl : false}
        onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
      />
      <input
        required={!editing && credentialRequired}
        type="password"
        autoComplete="off"
        aria-label="API Key"
        placeholder={
          editing
            ? "留空则不更换 API Key"
            : credentialRequired
              ? "API Key（仅存入 Windows 凭据库）"
              : "API Key（可选）"
        }
        value={draft.apiKey}
        onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
      />
      {modelOptions.length > 0 && !manualModel ? (
        <select
          required
          aria-label="模型 ID"
          value={draft.modelId}
          onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
        >
          <option value="">选择模型</option>
          {modelOptions.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      ) : (
        <input
          required
          aria-label="模型 ID"
          placeholder="模型 ID（可手动填写）"
          value={draft.modelId}
          onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
        />
      )}
      <div className="project-actions">
        <button type="submit" disabled={!available}>
          {editing ? "保存修改" : "保存连接"}
        </button>
        {editing && (
          <button
            type="button"
            className="quiet-button"
            onClick={() => {
              setEditing(null);
              setDraft(emptyDraft);
            }}
          >
            取消
          </button>
        )}
        {editing && (
          <button type="button" className="quiet-button" onClick={() => void loadModels(editing)}>
            拉取模型列表
          </button>
        )}
      </div>
      {selectedPreset?.description && <p className="backup-help">{selectedPreset.description}</p>}
    </form>
  );

  return (
    <section className="workspace-panel" aria-labelledby="connections-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">MODEL CONNECTIONS</p>
          <h2 id="connections-title">模型连接 / Provider</h2>
        </div>
        <button type="button" className="quiet-button" onClick={() => void reload()} disabled={!available}>
          刷新
        </button>
      </div>
      {form}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <ul className="connection-list">
        {connections.map((connection) => (
          <li key={connection.id}>
            <div>
              <strong>{connection.name}</strong>
              <span>
                {connection.presetId ?? "custom"} · {connection.modelId} · {connection.baseUrl}
              </span>
              <span>
                凭据：
                {connection.credentialPresent ? "已保存于 Windows 凭据库" : "未配置"}
                {connection.credentialUpdatedAt ? ` · 更新于 ${formatTime(connection.credentialUpdatedAt)}` : ""}
                {connection.updatedAt ? ` · 配置 ${formatTime(connection.updatedAt)}` : ""}
              </span>
              {connection.lastTest && (
                <span>
                  最近测试：{connection.lastTest.kind} — {connection.lastTest.message}
                </span>
              )}
              {connection.lastProbe && <span>能力探测：{connection.lastProbe.message}</span>}
              {connection.lastUsage?.available && (
                <span>
                  Usage：
                  {connection.lastUsage.totalTokens !== undefined
                    ? `${connection.lastUsage.totalTokens} tokens`
                    : connection.lastUsage.message}
                </span>
              )}
            </div>
            <div className="project-actions">
              <span className={`tag ${connection.enabled ? "active" : "archived"}`}>
                {connection.enabled ? "已启用" : "已停用"}
              </span>
              <button type="button" className="quiet-button" onClick={() => void runTest(connection)}>
                测试
              </button>
              <button type="button" className="quiet-button" onClick={() => void runProbe(connection)}>
                探测
              </button>
              <button type="button" className="quiet-button" onClick={() => void runUsage(connection)}>
                Usage
              </button>
              <button type="button" className="quiet-button" onClick={() => beginEdit(connection)}>
                编辑
              </button>
              <button
                type="button"
                className="quiet-button"
                onClick={() => void update(connection, { enabled: !connection.enabled })}
              >
                {connection.enabled ? "停用" : "启用"}
              </button>
              <button type="button" className="quiet-button" onClick={() => void remove(connection)}>
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatTime(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
