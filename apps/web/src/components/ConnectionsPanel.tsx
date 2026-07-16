import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createConnectionClient,
  statusLabel,
  statusTone,
  type ProviderCatalogPreset,
  type ProviderRecord
} from "../lib/connections.js";

interface ConnectionsPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
  /** When true, parent already rendered the page header (todos-style). */
  embedded?: boolean;
  onRequestAdd?: () => void;
  addOpen?: boolean;
  onAddOpenChange?: (open: boolean) => void;
}

type Mode = "list" | "pick" | "configure";

const emptyConfig = {
  name: "",
  baseUrl: "",
  apiKey: "",
  modelId: "",
  authMode: "api-key"
};

export function ConnectionsPanel({
  serviceUrl,
  available,
  dataEpoch = 0,
  embedded = false,
  addOpen,
  onAddOpenChange
}: ConnectionsPanelProps) {
  const client = useMemo(() => createConnectionClient(serviceUrl), [serviceUrl]);
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [catalog, setCatalog] = useState<ProviderCatalogPreset[]>([]);
  const [mode, setMode] = useState<Mode>("list");
  const [presetFilter, setPresetFilter] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [config, setConfig] = useState(emptyConfig);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"ok" | "warn" | "err">("ok");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [credDraft, setCredDraft] = useState("");

  // Controlled open from parent "添加服务商" button
  useEffect(() => {
    if (addOpen) {
      setMode("pick");
      setPresetFilter("");
      setSelectedPresetId(null);
      setConfig(emptyConfig);
    } else if (addOpen === false && mode !== "list") {
      setMode("list");
    }
  }, [addOpen]);

  const selectedPreset = catalog.find((p) => p.id === selectedPresetId) ?? null;

  const filteredCatalog = useMemo(() => {
    const q = presetFilter.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (p) =>
        p.id.toLowerCase().includes(q) ||
        p.label.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.hint.toLowerCase().includes(q)
    );
  }, [catalog, presetFilter]);

  const flash = (message: string, tone: typeof noticeTone = "ok") => {
    setNotice(message);
    setNoticeTone(tone);
  };

  const reload = async () => {
    if (!available) return;
    try {
      const [list, cat] = await Promise.all([client.listProviders(), client.listCatalog()]);
      setProviders(list);
      if (cat.length) setCatalog(cat);
      else {
        const legacy = await client.listPresets();
        setCatalog(
          legacy.map((p) => ({
            id: p.id,
            name: p.name,
            label: p.name,
            hint: p.description,
            adapter: p.kind === "ollama" ? "ollama" : "openai-compatible",
            providerType: p.kind === "ollama" ? "local" : p.kind === "custom" ? "custom" : "builtin",
            defaultBaseUrl: p.defaultBaseUrl,
            apiProtocol: "openai-completions",
            authModes: p.requiresCredential ? ["api-key"] : ["none"],
            requiresCredential: p.requiresCredential,
            allowDeferredCredential: !p.requiresCredential,
            description: p.description
          }))
        );
      }
    } catch (error) {
      flash(error instanceof Error ? error.message : "无法加载服务商列表", "err");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, dataEpoch, serviceUrl]);

  const openAdd = () => {
    setMode("pick");
    setPresetFilter("");
    setSelectedPresetId(null);
    setConfig(emptyConfig);
    onAddOpenChange?.(true);
  };

  const closeAdd = () => {
    setMode("list");
    setSelectedPresetId(null);
    setConfig(emptyConfig);
    onAddOpenChange?.(false);
  };

  const pickPreset = (preset: ProviderCatalogPreset) => {
    setSelectedPresetId(preset.id);
    const authMode = preset.authModes.includes("api-key")
      ? "api-key"
      : preset.authModes.includes("none")
        ? "none"
        : preset.authModes[0] ?? "api-key";
    setConfig({
      name: preset.providerType === "custom" || preset.id === "custom" ? "" : preset.name,
      baseUrl:
        preset.defaultBaseUrl && !preset.defaultBaseUrl.includes("{") ? preset.defaultBaseUrl : "",
      apiKey: "",
      modelId: preset.defaultModelId ?? "",
      authMode
    });
    setMode("configure");
  };

  const saveProvider = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPreset) return;
    setBusy(true);
    try {
      const isCustom = selectedPreset.id === "custom" || selectedPreset.providerType === "custom";
      const isOllama = selectedPreset.id === "ollama" || selectedPreset.adapter === "ollama";
      const name = config.name.trim() || (isCustom ? "custom" : selectedPreset.name);
      if (/^\d{1,2}$/.test(name)) {
        flash("请使用 my-gateway 这类名称，不要填菜单序号。", "warn");
        setBusy(false);
        return;
      }
      let baseUrl = config.baseUrl.trim() || selectedPreset.defaultBaseUrl || "";
      if ((!baseUrl || baseUrl.includes("{")) && !isOllama) {
        flash("必须填写 Base URL。", "warn");
        setBusy(false);
        return;
      }
      const apiKey = config.apiKey.trim();
      let authMode = isOllama ? "none" : config.authMode;
      // OAuth-capable channel without a key → create shell for CLI OAuth complete
      if (!isOllama && !apiKey && selectedPreset.authModes.includes("oauth") && authMode === "api-key") {
        authMode = "oauth";
      }
      const allowDeferred =
        (selectedPreset.allowDeferredCredential || authMode === "oauth") &&
        !apiKey &&
        (authMode === "api-key" || authMode === "oauth");
      if (authMode === "api-key" && !apiKey && !allowDeferred) {
        flash("此服务商需要 API Key。", "warn");
        setBusy(false);
        return;
      }
      const modelId = config.modelId.trim() || selectedPreset.defaultModelId || "default";
      const models =
        isCustom || isOllama
          ? [
              {
                remoteModelId: modelId,
                contextWindow: 128000,
                maxOutputTokens: 16384,
                supportsReasoning: false
              }
            ]
          : undefined;

      const created = await client.createProvider({
        name,
        adapter: selectedPreset.adapter,
        providerType: selectedPreset.providerType,
        baseUrl: baseUrl || selectedPreset.defaultBaseUrl,
        apiProtocol: selectedPreset.apiProtocol,
        authMode,
        apiKey: apiKey || undefined,
        allowDeferredCredential: allowDeferred,
        defaultModelId: modelId,
        discoverModels: !isCustom && !isOllama && Boolean(apiKey || authMode === "none"),
        models
      });

      flash(
        `服务商「${created.name}」已添加` +
          (created.lastTestMessage ? ` · ${created.lastTestMessage}` : ""),
        created.status === "ready" ? "ok" : "warn"
      );
      closeAdd();
      await reload();
    } catch (error) {
      flash(error instanceof Error ? error.message : "保存服务商失败", "err");
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (provider: ProviderRecord) => {
    setBusy(true);
    try {
      const result = await client.testProvider(provider.id);
      flash(`${statusLabel(result.status)}: ${result.message}`, result.status === "ready" ? "ok" : "warn");
      await reload();
    } catch (error) {
      flash(error instanceof Error ? error.message : "测试失败", "err");
    } finally {
      setBusy(false);
    }
  };

  const discoverModels = async (provider: ProviderRecord) => {
    setBusy(true);
    try {
      const models = await client.discoverProviderModels(provider.id);
      flash(
        models.length
          ? `已发现 ${models.length} models for “${provider.name}”`
          : `未返回模型：「${provider.name}」`,
        models.length ? "ok" : "warn"
      );
      await reload();
    } catch (error) {
      flash(error instanceof Error ? error.message : "发现模型失败", "err");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: ProviderRecord) => {
    if (!window.confirm(`删除服务商「${provider.name}」？`)) return;
    setBusy(true);
    try {
      await client.removeProvider(provider.id);
      setProviders((c) => c.filter((p) => p.id !== provider.id));
      flash(`已删除「${provider.name}」`, "ok");
    } catch (error) {
      flash(error instanceof Error ? error.message : "删除失败", "err");
    } finally {
      setBusy(false);
    }
  };

  const saveCredential = async (provider: ProviderRecord) => {
    const key = credDraft.trim();
    if (!key) {
      flash("请先粘贴 API Key。", "warn");
      return;
    }
    setBusy(true);
    try {
      await client.setProviderCredential(provider.id, key);
      setCredDraft("");
      setExpandedId(null);
      flash(`Stored API Key for “${provider.name}”`, "ok");
      await reload();
    } catch (error) {
      flash(error instanceof Error ? error.message : "无法保存密钥", "err");
    } finally {
      setBusy(false);
    }
  };

  const needsBaseUrl =
    !selectedPreset?.defaultBaseUrl ||
    selectedPreset.defaultBaseUrl.includes("{") ||
    selectedPreset.providerType === "custom" ||
    selectedPreset.id === "custom";

  const needsKey =
    selectedPreset &&
    selectedPreset.authModes.includes("api-key") &&
    selectedPreset.id !== "ollama";

  // ── Add flow (modal-like panel, todos style) ──────────────────────
  if (mode === "pick" || mode === "configure") {
    return (
      <div className="tds-providers">
        {notice ? <div className={`tds-banner ${noticeTone}`}>{notice}</div> : null}
        <div className="tds-add-panel">
          <div className="tds-add-panel-head">
            <div>
              <p className="tds-kicker">添加服务商</p>
              <h2>{mode === "pick" ? "选择渠道" : selectedPreset?.label}</h2>
              <p className="tds-muted">
                {mode === "pick"
                  ? "与 pawb CLI 同一目录：搜索内置渠道或选择 Custom。"
                  : selectedPreset?.hint}
              </p>
            </div>
            <button type="button" className="tds-btn-ghost" onClick={closeAdd}>
              取消
            </button>
          </div>

          {mode === "pick" ? (
            <>
              <div className="tds-search-field">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                  value={presetFilter}
                  onChange={(e) => setPresetFilter(e.target.value)}
                  placeholder="搜索 openai / deepseek / moonshot…"
                  autoFocus
                />
              </div>
              <div className="tds-preset-grid">
                {filteredCatalog.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="tds-preset-card"
                    onClick={() => pickPreset(preset)}
                  >
                    <span className="tds-preset-title">{preset.label}</span>
                    <span className="tds-preset-hint">{preset.hint}</span>
                    <span className="tds-preset-meta">
                      {preset.providerType}
                      {preset.authModes.includes("oauth") ? " · OAuth" : ""}
                    </span>
                  </button>
                ))}
                {filteredCatalog.length === 0 ? (
                  <p className="tds-muted tds-empty-inline">无匹配，请换个关键字。</p>
                ) : null}
              </div>
            </>
          ) : (
            <form className="tds-form" onSubmit={(e) => void saveProvider(e)}>
              {(selectedPreset?.id === "custom" || selectedPreset?.providerType === "custom") && (
                <label className="tds-field">
                  <span>名称</span>
                  <input
                    required
                    value={config.name}
                    placeholder="my-gateway"
                    onChange={(e) => setConfig({ ...config, name: e.target.value })}
                  />
                </label>
              )}
              {needsBaseUrl ? (
                <label className="tds-field">
                  <span>Base URL</span>
                  <input
                    required
                    value={config.baseUrl}
                    placeholder={selectedPreset?.defaultBaseUrl || "https://api.example.com/v1"}
                    onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
                  />
                </label>
              ) : selectedPreset?.defaultBaseUrl ? (
                <p className="tds-muted">Base URL: {selectedPreset.defaultBaseUrl}</p>
              ) : null}
              {selectedPreset?.authModes.includes("oauth") ? (
                <div className="tds-banner warn">
                  订阅 OAuth（<strong>{selectedPreset.label}</strong>）在 CLI 中完成（浏览器 /
                  设备码），与 todos 一致：
                  <br />
                  <code>pawb provider add</code> → 选择此渠道 → 订阅（OAuth）
                </div>
              ) : null}

              {needsKey ? (
                <label className="tds-field">
                  <span>
                    API Key
                    {selectedPreset?.allowDeferredCredential || selectedPreset?.authModes.includes("oauth")
                      ? "（若用 CLI 做 OAuth 可留空）"
                      : ""}
                  </span>
                  <input
                    type="password"
                    required={
                      !selectedPreset?.allowDeferredCredential &&
                      !selectedPreset?.authModes.includes("oauth")
                    }
                    value={config.apiKey}
                    placeholder={
                      selectedPreset?.credentialEnvVar
                        ? `粘贴密钥（环境变量 $${selectedPreset.credentialEnvVar})`
                        : "仅写入本机凭据库"
                    }
                    onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
                  />
                </label>
              ) : (
                <p className="tds-muted">此渠道通常无需 API Key。</p>
              )}
              <label className="tds-field">
                <span>默认模型</span>
                <input
                  value={config.modelId}
                  placeholder={selectedPreset?.defaultModelId || "模型 ID"}
                  onChange={(e) => setConfig({ ...config, modelId: e.target.value })}
                />
              </label>
              <div className="tds-form-actions">
                <button type="button" className="tds-btn-ghost" onClick={() => setMode("pick")}>
                  ← 返回
                </button>
                <button type="submit" className="tds-btn-primary" disabled={!available || busy}>
                  {busy ? "保存中…" : "保存服务商"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  // ── List: match todos「模型」page screenshot ──────────────────────
  return (
    <div className="tds-providers tds-providers-v2">
      <header className="tds-page-header-v2">
        <div>
          <h1 className="tds-page-title-v2">模型服务</h1>
          <p className="tds-page-desc-v2">管理模型服务商和 API 密钥</p>
        </div>
        <button type="button" className="tds-btn-primary" disabled={!available} onClick={openAdd}>
          <span aria-hidden="true">+</span> 添加服务商
        </button>
      </header>

      {notice ? <div className={`tds-banner ${noticeTone}`}>{notice}</div> : null}

      {!available ? (
        <div className="tds-empty-card">
          <p className="tds-empty-title">服务离线</p>
          <p className="tds-empty-desc">请打开 http://127.0.0.1:41731</p>
        </div>
      ) : providers.length === 0 ? (
        <div className="tds-empty-card">
          <p className="tds-empty-title">还没有服务商</p>
          <p className="tds-empty-desc">添加后即可在总管任务里调用模型</p>
          <button type="button" className="tds-btn-primary" onClick={openAdd}>
            + 添加服务商
          </button>
        </div>
      ) : (
        <div className="tds-provider-list-v2">
          {providers.map((provider) => {
            const modelCount = provider.models?.length ?? (provider.defaultModelId ? 1 : 0);
            const configured =
              provider.credentialConfigured ||
              provider.authMode === "none" ||
              provider.status === "ready";
            const open = expandedId === provider.id;
            const letter = (provider.name || "?").slice(0, 1).toUpperCase();
            return (
              <article key={provider.id} className="tds-provider-card">
                <div className="tds-provider-logo" aria-hidden="true">
                  {letter}
                </div>
                <div className="tds-provider-body">
                  <div className="tds-provider-name-row">
                    <h3>{provider.name}</h3>
                    <span className="tds-muted tds-model-count">
                      {modelCount > 0
                        ? `${modelCount} 个模型`
                        : provider.defaultModelId || "未发现模型"}
                    </span>
                    <span className={`tds-status-pill ${configured ? "ok" : "warn"}`}>
                      {configured ? "已配置" : "缺密钥"}
                    </span>
                  </div>
                  {open ? (
                    <div className="tds-inline-cred">
                      <label className="tds-field">
                        <span>更新 API Key</span>
                        <input
                          type="password"
                          value={credDraft}
                          placeholder="粘贴新密钥"
                          onChange={(e) => setCredDraft(e.target.value)}
                        />
                      </label>
                      <div className="tds-form-actions">
                        <button
                          type="button"
                          className="tds-btn-primary"
                          disabled={busy}
                          onClick={() => void saveCredential(provider)}
                        >
                          保存密钥
                        </button>
                        <button type="button" className="tds-btn-ghost" onClick={() => setExpandedId(null)}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="tds-btn-ghost"
                          disabled={busy}
                          onClick={() => void runTest(provider)}
                        >
                          测试
                        </button>
                        <button
                          type="button"
                          className="tds-btn-ghost"
                          disabled={busy}
                          onClick={() => void discoverModels(provider)}
                        >
                          发现模型
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="tds-provider-ops">
                  <button
                    type="button"
                    className="tds-btn-ghost"
                    onClick={() => {
                      setExpandedId(open ? null : provider.id);
                      setCredDraft("");
                    }}
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    className="tds-btn-ghost tds-btn-danger-ghost"
                    disabled={busy}
                    onClick={() => void remove(provider)}
                  >
                    删除
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
