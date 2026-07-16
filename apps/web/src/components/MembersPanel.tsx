/**
 * todos 设置 › 成员 — 人 + Agent 列表，创建 Agent 弹窗（名称 / 机器 / 模型）
 * 对照截图 PixPin_2026-07-16_21-53-23 / 21-53-53 / 21-54-08
 */

import { useEffect, useMemo, useState } from "react";
import { createConnectionClient, type ProviderRecord } from "../lib/connections.js";
import { createGithubClient, type GithubAccountRecord } from "../lib/github.js";
import { createProjectClient, type ProjectRecord } from "../lib/projects.js";
import { createRoleClient, type AgentRoleRecord } from "../lib/roles.js";
import { CreateProjectModal } from "./CreateProjectModal.js";

interface MembersPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
}

type Tab = "basic" | "projects" | "members" | "machines" | "plan" | "github";

export function MembersPanel({ serviceUrl, available, dataEpoch = 0 }: MembersPanelProps) {
  const roles = useMemo(() => createRoleClient(serviceUrl), [serviceUrl]);
  const providers = useMemo(() => createConnectionClient(serviceUrl), [serviceUrl]);
  const projectsApi = useMemo(() => createProjectClient(serviceUrl), [serviceUrl]);
  const githubApi = useMemo(() => createGithubClient(serviceUrl), [serviceUrl]);

  const [tab, setTab] = useState<Tab>("members");
  const [list, setList] = useState<AgentRoleRecord[]>([]);
  const [providerList, setProviderList] = useState<ProviderRecord[]>([]);
  const [projectList, setProjectList] = useState<ProjectRecord[]>([]);
  const [ghAccounts, setGhAccounts] = useState<GithubAccountRecord[]>([]);
  const [ghToken, setGhToken] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [draft, setDraft] = useState({
    name: "",
    providerId: "",
    modelId: ""
  });

  const reload = async () => {
    if (!available) return;
    try {
      const [r, p, proj, gh] = await Promise.all([
        roles.list(),
        providers.listProviders(),
        projectsApi.list().catch(() => [] as ProjectRecord[]),
        githubApi.listAccounts().catch(() => [] as GithubAccountRecord[])
      ]);
      setList(r);
      setProviderList(p.filter((x) => x.enabled));
      setProjectList(proj.filter((x) => x.status === "active"));
      setGhAccounts(gh);
      setNotice("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "无法加载成员");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, dataEpoch, serviceUrl]);

  const modelOptions = useMemo(() => {
    const opts: Array<{ providerId: string; providerName: string; modelId: string; label: string }> =
      [];
    for (const p of providerList) {
      const models = p.models ?? [];
      if (models.length) {
        for (const m of models) {
          opts.push({
            providerId: p.id,
            providerName: p.name,
            modelId: m.remoteModelId,
            label: m.displayName || m.remoteModelId
          });
        }
      } else if (p.defaultModelId) {
        opts.push({
          providerId: p.id,
          providerName: p.name,
          modelId: p.defaultModelId,
          label: p.defaultModelId
        });
      }
    }
    const q = modelSearch.trim().toLowerCase();
    if (!q) return opts;
    return opts.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.modelId.toLowerCase().includes(q) ||
        o.providerName.toLowerCase().includes(q)
    );
  }, [providerList, modelSearch]);

  const selectedModelLabel = useMemo(() => {
    if (!draft.modelId) return "选择模型";
    const hit = modelOptions.find((m) => m.modelId === draft.modelId && m.providerId === draft.providerId);
    return hit ? `${hit.providerName} · ${hit.label}` : draft.modelId;
  }, [draft, modelOptions]);

  const createAgent = async () => {
    const name = draft.name.trim();
    if (!name) {
      setNotice("请填写 Agent 名称");
      return;
    }
    if (!draft.providerId || !draft.modelId) {
      setNotice("请选择模型");
      return;
    }
    setBusy(true);
    try {
      await roles.create({
        name,
        responsibility: "Builder",
        systemInstruction: `你是「${name}」。在批准的计划与项目工作区内完成分配任务，回报可验证结果。`,
        connectionId: draft.providerId,
        modelId: draft.modelId,
        harness: "api",
        reasoningEffort: "medium",
        skills: ["implement"],
        tools: ["filesystem", "shell"],
        permissions: {
          workspace: "project_only",
          network: false,
          shell: true,
          externalSend: false
        },
        allowFirstmateAutoInvoke: true
      });
      setShowCreate(false);
      setDraft({ name: "", providerId: "", modelId: "" });
      setNotice(`已创建 Agent「${name}」`);
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const removeAgent = async (role: AgentRoleRecord) => {
    if (!window.confirm(`删除 Agent「${role.name}」？`)) return;
    setBusy(true);
    try {
      await roles.remove(role.id);
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "basic", label: "基本信息" },
    { id: "projects", label: "项目" },
    { id: "members", label: "成员" },
    { id: "machines", label: "机器" },
    { id: "plan", label: "套餐" },
    { id: "github", label: "GitHub" }
  ];

  return (
    <div className="tds-settings-page">
      <div className="tds-settings-top">
        <h1>设置</h1>
      </div>

      <div className="tds-settings-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className={`tds-settings-tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {notice ? <div className="tds-banner ok">{notice}</div> : null}

      {tab === "members" ? (
        <div className="tds-members">
          <p className="tds-members-count">{1 + list.length} 个成员</p>

          <div className="tds-member-list">
            <div className="tds-member-row">
              <span className="tds-member-av me">本</span>
              <div className="tds-member-meta">
                <div className="tds-member-name">
                  本地用户 <span className="tds-badge-captain">队长</span>
                </div>
                <div className="tds-member-sub">本机 · 人类</div>
              </div>
            </div>

            {list.map((role) => (
              <div key={role.id} className="tds-member-row">
                <span className="tds-member-av">{role.name.slice(0, 1)}</span>
                <div className="tds-member-meta">
                  <div className="tds-member-name">
                    {role.name}
                    {role.enabled ? <span className="tds-dot-online" title="启用" /> : null}
                  </div>
                  <div className="tds-member-sub">
                    <span className="tds-model-pill">{role.modelId || "未绑模型"}</span>
                    {" · "}
                    默认 · 本机
                  </div>
                </div>
                <div className="tds-member-actions">
                  <button type="button" className="tds-btn-ghost" disabled={busy} onClick={() => void removeAgent(role)}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="tds-member-actions-row">
            <button type="button" className="tds-member-action-btn" disabled title="本地单机暂不支持邀请">
              邀请成员
            </button>
            <button
              type="button"
              className="tds-member-action-btn primary"
              disabled={!available || busy}
              onClick={() => setShowCreate(true)}
            >
              创建 Agent
            </button>
          </div>
        </div>
      ) : tab === "basic" ? (
        <div className="tds-settings-block">
          <label className="tds-field">
            <span>团队名称</span>
            <input value="本地 team" readOnly />
          </label>
          <p className="tds-muted">本地单机模式，无云端团队 ID。</p>
        </div>
      ) : tab === "machines" ? (
        <div className="tds-settings-block">
          <div className="tds-member-row">
            <span className="tds-dot-online big" />
            <div className="tds-member-meta">
              <div className="tds-member-name">本机</div>
              <div className="tds-member-sub">{available ? "在线 · shell 可用" : "离线"}</div>
            </div>
          </div>
          <p className="tds-muted" style={{ marginTop: "0.75rem" }}>
            对应 todos 的 `tds start` 执行器。当前由本地 Agent Service 承担。
          </p>
        </div>
      ) : tab === "projects" ? (
        <div className="tds-settings-block">
          <p className="tds-muted" style={{ marginBottom: "0.75rem" }}>
            项目绑定本地仓库路径（对齐 todos 的 GitHub 仓库绑定）。任务都建在项目里。
          </p>
          <div className="tds-member-list" style={{ marginBottom: "0.75rem" }}>
            {projectList.length === 0 ? (
              <p className="tds-muted">还没有项目。</p>
            ) : (
              projectList.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="tds-member-row tds-member-row-btn"
                  onClick={() => {
                    window.location.hash = `#/projects/${encodeURIComponent(p.id)}`;
                  }}
                >
                  <span className="tds-member-av">{p.name.slice(0, 1)}</span>
                  <div className="tds-member-meta">
                    <div className="tds-member-name">{p.name}</div>
                    <div className="tds-member-sub break-all">
                      {p.github?.fullName || p.workspacePath}
                      {p.github?.fullName ? " ↗" : ""}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="tds-member-actions-row">
            <button
              type="button"
              className="tds-member-action-btn primary"
              disabled={!available}
              onClick={() => setShowCreateProject(true)}
            >
              + 新建项目
            </button>
            <button
              type="button"
              className="tds-member-action-btn"
              onClick={() => {
                window.location.hash = "#/projects";
              }}
            >
              打开项目板
            </button>
          </div>
        </div>
      ) : tab === "github" ? (
        <div className="tds-settings-block">
          <p className="tds-muted" style={{ marginBottom: "0.75rem" }}>
            关联 GitHub 帐号后，创建项目时可直接选择仓库（与 todos 相同）。
          </p>
          <div className="tds-member-list" style={{ marginBottom: "0.75rem" }}>
            {ghAccounts.length === 0 ? (
              <p className="tds-muted">尚未关联 GitHub 帐号。</p>
            ) : (
              ghAccounts.map((a) => (
                <div key={a.id} className="tds-member-row">
                  <span className="tds-member-av">{a.login.slice(0, 1)}</span>
                  <div className="tds-member-meta">
                    <div className="tds-member-name">{a.login}</div>
                    <div className="tds-member-sub">{a.name || a.htmlUrl || "已关联"}</div>
                  </div>
                  <button
                    type="button"
                    className="tds-btn-ghost"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void githubApi
                        .removeAccount(a.id)
                        .then(() => reload())
                        .catch((e) => setNotice(e instanceof Error ? e.message : "移除失败"))
                        .finally(() => setBusy(false));
                    }}
                  >
                    移除
                  </button>
                </div>
              ))
            )}
          </div>
          <label className="tds-field">
            <span>添加 Token</span>
            <input
              type="password"
              placeholder="ghp_… 或 github_pat_…"
              value={ghToken}
              disabled={!available || busy}
              onChange={(e) => setGhToken(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="tds-member-action-btn primary"
            style={{ marginTop: "0.5rem" }}
            disabled={!available || busy || !ghToken.trim()}
            onClick={() => {
              setBusy(true);
              void githubApi
                .addAccount(ghToken.trim())
                .then(() => {
                  setGhToken("");
                  setNotice("GitHub 帐号已关联");
                  return reload();
                })
                .catch((e) => setNotice(e instanceof Error ? e.message : "关联失败"))
                .finally(() => setBusy(false));
            }}
          >
            + 关联新的 GitHub 帐号
          </button>
          <div style={{ marginTop: "1rem" }}>
            <p className="tds-muted" style={{ marginBottom: "0.45rem" }}>
              已绑定仓库的项目
            </p>
            {projectList.filter((p) => p.github?.fullName).length === 0 ? (
              <p className="tds-muted">还没有绑定 GitHub 的项目。</p>
            ) : (
              projectList
                .filter((p) => p.github?.fullName)
                .map((p) => (
                  <div key={p.id} className="tds-member-row" style={{ marginBottom: "0.35rem" }}>
                    <span className="tds-member-av">{p.name.slice(0, 1)}</span>
                    <div className="tds-member-meta">
                      <div className="tds-member-name">{p.name}</div>
                      <div className="tds-member-sub">
                        {p.github?.fullName}
                        {p.github?.htmlUrl ? (
                          <>
                            {" · "}
                            <a href={p.github.htmlUrl} target="_blank" rel="noreferrer">
                              打开
                            </a>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>
      ) : (
        <div className="tds-settings-block">
          <p className="tds-muted">本地免费，无套餐计费。</p>
        </div>
      )}

      {/* 创建 Agent 弹窗 — 对齐 todos */}
      {showCreate ? (
        <div className="tds-modal-mask" role="presentation" onClick={() => !busy && setShowCreate(false)}>
          <div
            className="tds-modal"
            role="dialog"
            aria-label="创建 agent"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tds-modal-head">
              <strong>创建 agent</strong>
              <button type="button" className="tds-modal-x" onClick={() => setShowCreate(false)}>
                ×
              </button>
            </div>
            <div className="tds-modal-avatar-placeholder">{`{}`}</div>
            <label className="tds-field">
              <span>名称</span>
              <input
                autoFocus
                placeholder="如 Opus builder"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="tds-field">
              <span>机器</span>
              <select value="local" disabled>
                <option value="local">本机</option>
              </select>
            </label>
            <label className="tds-field">
              <span>模型</span>
              <button
                type="button"
                className="tds-select-like"
                onClick={() => setShowModelPicker(true)}
              >
                {selectedModelLabel}
              </button>
            </label>
            <button
              type="button"
              className="tds-btn-primary tds-modal-submit"
              disabled={busy || !available}
              onClick={() => void createAgent()}
            >
              {busy ? "创建中…" : "创建"}
            </button>
          </div>
        </div>
      ) : null}

      {/* 选择模型弹窗 */}
      {showModelPicker ? (
        <div
          className="tds-modal-mask"
          role="presentation"
          onClick={() => setShowModelPicker(false)}
        >
          <div className="tds-modal tds-modal-sm" role="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tds-modal-head">
              <strong>选择模型</strong>
              <button type="button" className="tds-modal-x" onClick={() => setShowModelPicker(false)}>
                ×
              </button>
            </div>
            <input
              className="tds-modal-search"
              placeholder="搜索…"
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
            />
            <div className="tds-model-pick-list">
              {modelOptions.length === 0 ? (
                <p className="tds-muted" style={{ padding: "0.75rem" }}>
                  还没有模型。请先到「模型服务」添加服务商并发现模型。
                </p>
              ) : (
                modelOptions.map((m) => (
                  <button
                    key={`${m.providerId}:${m.modelId}`}
                    type="button"
                    className="tds-model-pick-item"
                    onClick={() => {
                      setDraft({
                        ...draft,
                        providerId: m.providerId,
                        modelId: m.modelId
                      });
                      setShowModelPicker(false);
                    }}
                  >
                    <span className="tds-model-pick-provider">{m.providerName}</span>
                    <span>{m.label}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      <CreateProjectModal
        open={showCreateProject}
        serviceUrl={serviceUrl}
        available={available}
        onClose={() => setShowCreateProject(false)}
        onCreated={(projectId) => {
          setShowCreateProject(false);
          void reload();
          window.location.hash = `#/projects/${encodeURIComponent(projectId)}`;
        }}
      />
    </div>
  );
}
