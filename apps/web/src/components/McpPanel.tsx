import { useEffect, useMemo, useState } from "react";
import {
  createMcpClient,
  type McpConnectionRecord,
  type McpToolDescriptor
} from "../lib/mcp.js";

interface McpPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
}

interface McpDraft {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  authToken: string;
  envText: string;
}

const emptyDraft: McpDraft = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  authToken: "",
  envText: ""
};

export function McpPanel({ serviceUrl, available, dataEpoch = 0 }: McpPanelProps) {
  const client = useMemo(() => createMcpClient(serviceUrl), [serviceUrl]);
  const [connections, setConnections] = useState<McpConnectionRecord[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [toolsById, setToolsById] = useState<Record<string, McpToolDescriptor[]>>({});
  const [notice, setNotice] = useState("");
  const [roleId, setRoleId] = useState("");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const reload = async () => {
    if (!available) return;
    try {
      const list = await client.list();
      setConnections(list);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取 MCP 连接（路由可能尚未挂载）");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, dataEpoch, serviceUrl]);

  const parseEnv = (text: string): Record<string, string> | undefined => {
    const env: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return Object.keys(env).length > 0 ? env : undefined;
  };

  const saveNew = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const connection = await client.create({
        name: draft.name || "MCP Server",
        transport: draft.transport,
        command: draft.command || undefined,
        args: draft.args
          ? draft.args
              .split(/\s+/)
              .map((part) => part.trim())
              .filter(Boolean)
          : undefined,
        url: draft.url || undefined,
        authToken: draft.authToken || undefined,
        env: parseEnv(draft.envText)
      });
      setConnections((current) => [connection, ...current]);
      setDraft(emptyDraft);
      setNotice("MCP 连接已保存。密钥/环境变量仅写入本机凭据库，界面不回显。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法保存 MCP 连接");
    }
  };

  const testConnection = async (id: string) => {
    try {
      const result = await client.test(id);
      setNotice(result.message);
      const tools = await client.listTools(id);
      setToolsById((current) => ({ ...current, [id]: tools }));
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "测试失败");
    }
  };

  const toggleTool = (connectionId: string, toolName: string) => {
    const key = `${connectionId}::${toolName}`;
    setSelectedTools((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]
    );
  };

  const saveRoleBindings = async () => {
    if (!roleId.trim()) {
      setNotice("请填写 Agent Role ID 以绑定工具。");
      return;
    }
    try {
      const tools = selectedTools.map((key) => {
        const [connectionId, toolName] = key.split("::");
        return { connectionId, toolName };
      });
      await client.setRoleBindings(roleId.trim(), tools);
      setNotice(`已为 Role ${roleId.trim()} 绑定 ${tools.length} 个 MCP 工具（非整 Server）。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法保存 Role 绑定");
    }
  };

  return (
    <section className="panel" aria-labelledby="mcp-title">
      <header className="panel-header">
        <h2 id="mcp-title">MCP 连接</h2>
        <p>配置本地/远程 MCP Server，按工具绑定到 Agent Role；密钥不进入普通备份。</p>
      </header>

      {!available && <p className="muted">服务离线时无法管理 MCP 连接。</p>}

      <form className="stack" onSubmit={saveNew}>
        <label>
          名称
          <input
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder="例如：filesystem-mcp"
          />
        </label>
        <label>
          传输
          <select
            value={draft.transport}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                transport: event.target.value as "stdio" | "http"
              }))
            }
          >
            <option value="stdio">stdio（本地进程）</option>
            <option value="http">http（远程）</option>
          </select>
        </label>
        {draft.transport === "stdio" ? (
          <>
            <label>
              命令
              <input
                value={draft.command}
                onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
                placeholder="npx"
                required
              />
            </label>
            <label>
              参数
              <input
                value={draft.args}
                onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))}
                placeholder="-y @modelcontextprotocol/server-filesystem ."
              />
            </label>
            <label>
              环境变量（KEY=value，每行一条；仅写入凭据库）
              <textarea
                value={draft.envText}
                onChange={(event) => setDraft((current) => ({ ...current, envText: event.target.value }))}
                rows={3}
                placeholder={"API_KEY=\nOTHER="}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              URL
              <input
                value={draft.url}
                onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
                placeholder="https://127.0.0.1:3100/mcp"
                required
              />
            </label>
            <label>
              Auth Token（可选，不回显）
              <input
                type="password"
                value={draft.authToken}
                onChange={(event) => setDraft((current) => ({ ...current, authToken: event.target.value }))}
                autoComplete="off"
              />
            </label>
          </>
        )}
        <button type="submit" disabled={!available}>
          添加 MCP 连接
        </button>
      </form>

      {notice && <p className="notice">{notice}</p>}

      <ul className="list">
        {connections.map((connection) => (
          <li key={connection.id} className="list-item">
            <div>
              <strong>{connection.name}</strong>
              <span className="muted">
                {" "}
                · {connection.transport}
                {connection.enabled ? "" : " · 已停用"}
                {connection.credentialPresent ? " · 凭据已保存" : ""}
              </span>
              {connection.lastTest && (
                <p className="muted">
                  最近测试：{connection.lastTest.kind} — {connection.lastTest.message}
                </p>
              )}
              {connection.envKeys && connection.envKeys.length > 0 && (
                <p className="muted">环境变量键：{connection.envKeys.join(", ")}（值不展示）</p>
              )}
            </div>
            <div className="row-actions">
              <button type="button" onClick={() => void testConnection(connection.id)} disabled={!available}>
                测试并发现工具
              </button>
              <button
                type="button"
                onClick={() =>
                  void client
                    .update(connection.id, { enabled: !connection.enabled })
                    .then(reload)
                    .catch((error: unknown) =>
                      setNotice(error instanceof Error ? error.message : "更新失败")
                    )
                }
                disabled={!available}
              >
                {connection.enabled ? "停用" : "启用"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void client
                    .remove(connection.id)
                    .then(reload)
                    .catch((error: unknown) =>
                      setNotice(error instanceof Error ? error.message : "删除失败")
                    )
                }
                disabled={!available}
              >
                删除
              </button>
            </div>
            {(toolsById[connection.id] ?? connection.tools ?? []).length > 0 && (
              <div className="stack">
                <p>可选工具（勾选后绑定到 Role，默认不暴露整个 Server）：</p>
                <ul>
                  {(toolsById[connection.id] ?? connection.tools ?? []).map((tool) => {
                    const key = `${connection.id}::${tool.name}`;
                    return (
                      <li key={key}>
                        <label>
                          <input
                            type="checkbox"
                            checked={selectedTools.includes(key)}
                            onChange={() => toggleTool(connection.id, tool.name)}
                          />{" "}
                          <code>{tool.name}</code>
                          {tool.description ? ` — ${tool.description}` : ""}
                          {tool.risk ? ` [${tool.risk}]` : ""}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="stack">
        <label>
          绑定到 Agent Role ID
          <input value={roleId} onChange={(event) => setRoleId(event.target.value)} placeholder="role uuid" />
        </label>
        <button type="button" onClick={() => void saveRoleBindings()} disabled={!available}>
          保存工具绑定（{selectedTools.length}）
        </button>
      </div>
    </section>
  );
}
