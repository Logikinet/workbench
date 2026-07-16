/**
 * todos「创建项目」：项目名称 + 选择 GitHub 仓库
 * 对照截图 22:09-39 / 22:02-48
 */

import { useEffect, useMemo, useState } from "react";
import {
  createGithubClient,
  type GithubAccountRecord,
  type GithubRepoRecord
} from "../lib/github.js";

interface CreateProjectModalProps {
  open: boolean;
  serviceUrl: string;
  available: boolean;
  onClose(): void;
  onCreated(projectId: string): void;
}

type Step = "form" | "pick-account" | "pick-repo" | "link-token";

export function CreateProjectModal({
  open,
  serviceUrl,
  available,
  onClose,
  onCreated
}: CreateProjectModalProps) {
  const api = useMemo(() => createGithubClient(serviceUrl), [serviceUrl]);
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [accounts, setAccounts] = useState<GithubAccountRecord[]>([]);
  const [account, setAccount] = useState<GithubAccountRecord | null>(null);
  const [repos, setRepos] = useState<GithubRepoRecord[]>([]);
  const [repo, setRepo] = useState<GithubRepoRecord | null>(null);
  const [repoQuery, setRepoQuery] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reloadAccounts = async () => {
    try {
      const list = await api.listAccounts();
      setAccounts(list);
      if (account && !list.some((a) => a.id === account.id)) setAccount(null);
      if (!account && list[0]) setAccount(list[0]);
    } catch {
      setAccounts([]);
    }
  };

  useEffect(() => {
    if (!open) return;
    setStep("form");
    setName("");
    setRepo(null);
    setRepoQuery("");
    setToken("");
    setError("");
    setBusy(false);
    void reloadAccounts();
  }, [open, serviceUrl]);

  useEffect(() => {
    if (!open || !account || step !== "pick-repo") return;
    let cancelled = false;
    setBusy(true);
    setError("");
    void api
      .listRepos(account.id, repoQuery)
      .then((list) => {
        if (!cancelled) setRepos(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "无法加载仓库");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, account?.id, step, repoQuery, api]);

  if (!open) return null;

  const letter = (name.trim() || repo?.name || "项").slice(0, 1);

  const linkAccount = async () => {
    if (!token.trim()) {
      setError("请粘贴 GitHub Token（需 repo 读权限）");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const a = await api.addAccount(token.trim());
      setToken("");
      await reloadAccounts();
      setAccount(a);
      setStep("pick-repo");
    } catch (e) {
      setError(e instanceof Error ? e.message : "关联失败");
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!repo || !account) {
      setError("请先选择 GitHub 仓库");
      setStep(accounts.length ? "pick-account" : "link-token");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const project = await api.createProjectFromRepo({
        accountId: account.id,
        fullName: repo.fullName,
        name: name.trim() || repo.name,
        clone: true
      });
      onCreated(project.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tds-modal-mask" role="presentation" onClick={() => !busy && onClose()}>
      <div
        className="tds-modal tds-create-project-modal"
        role="dialog"
        aria-labelledby="tds-create-project-title"
        onClick={(e) => e.stopPropagation()}
      >
        {step === "form" ? (
          <>
            <div className="tds-modal-head">
              <strong id="tds-create-project-title">创建项目</strong>
              <button type="button" className="tds-modal-x" onClick={onClose} disabled={busy}>
                ×
              </button>
            </div>

            <div className="tds-create-project-avatar" aria-hidden="true">
              {letter}
            </div>

            <label className="tds-field">
              <span>项目名称</span>
              <input
                autoFocus
                value={name}
                placeholder={repo?.name || "例如：测试2"}
                disabled={busy || !available}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <label className="tds-field">
              <span>GitHub 仓库</span>
              <button
                type="button"
                className="tds-select-like"
                disabled={busy || !available}
                onClick={() => {
                  if (!accounts.length) setStep("link-token");
                  else if (accounts.length === 1) {
                    setAccount(accounts[0]!);
                    setStep("pick-repo");
                  } else setStep("pick-account");
                }}
              >
                {repo ? (
                  <span className="tds-repo-selected">
                    {repo.fullName}
                    {repo.private ? " · 私有" : ""}
                  </span>
                ) : (
                  <span className="tds-placeholder">选择仓库</span>
                )}
                <span className="tds-start-chevron">›</span>
              </button>
            </label>

            <p className="tds-create-project-hint">
              与 todos 相同：项目绑定 GitHub 仓库。选择后会 clone 到本机工作区。
            </p>

            {error ? <div className="tds-usage-error">{error}</div> : null}

            <button
              type="button"
              className="tds-btn-primary tds-modal-submit"
              disabled={busy || !available || !repo}
              onClick={() => void create()}
            >
              {busy ? "创建中…" : "创建项目"}
            </button>
          </>
        ) : null}

        {step === "link-token" ? (
          <>
            <div className="tds-modal-head">
              <button type="button" className="tds-back-btn" onClick={() => setStep("form")}>
                ‹ 关联 GitHub
              </button>
              <button type="button" className="tds-modal-x" onClick={onClose}>
                ×
              </button>
            </div>
            <p className="tds-create-project-hint">
              粘贴 Personal Access Token（classic 勾选 repo，或 fine-grained 读 Contents）。Token
              只存本机凭据库，不会回显。
            </p>
            <label className="tds-field">
              <span>Token</span>
              <input
                type="password"
                autoFocus
                value={token}
                placeholder="ghp_… 或 github_pat_…"
                disabled={busy}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void linkAccount();
                }}
              />
            </label>
            {error ? <div className="tds-usage-error">{error}</div> : null}
            <button
              type="button"
              className="tds-btn-primary tds-modal-submit"
              disabled={busy || !token.trim()}
              onClick={() => void linkAccount()}
            >
              {busy ? "验证中…" : "关联帐号"}
            </button>
          </>
        ) : null}

        {step === "pick-account" ? (
          <>
            <div className="tds-modal-head">
              <button type="button" className="tds-back-btn" onClick={() => setStep("form")}>
                ‹ 选择帐号
              </button>
              <button type="button" className="tds-modal-x" onClick={onClose}>
                ×
              </button>
            </div>
            <div className="tds-repo-pick-list">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="tds-repo-pick-item"
                  onClick={() => {
                    setAccount(a);
                    setStep("pick-repo");
                  }}
                >
                  <strong>{a.login}</strong>
                  {a.name ? <span>{a.name}</span> : null}
                </button>
              ))}
              <button type="button" className="tds-repo-pick-item muted" onClick={() => setStep("link-token")}>
                + 关联新的 GitHub 帐号
              </button>
            </div>
          </>
        ) : null}

        {step === "pick-repo" ? (
          <>
            <div className="tds-modal-head">
              <button
                type="button"
                className="tds-back-btn"
                onClick={() => setStep(accounts.length > 1 ? "pick-account" : "form")}
              >
                ‹ {account?.login || "选择仓库"}
              </button>
              <button type="button" className="tds-modal-x" onClick={onClose}>
                ×
              </button>
            </div>
            <input
              className="tds-modal-search"
              placeholder="搜索仓库…"
              value={repoQuery}
              onChange={(e) => setRepoQuery(e.target.value)}
            />
            {error ? <div className="tds-usage-error">{error}</div> : null}
            <div className="tds-repo-pick-list">
              {busy && repos.length === 0 ? (
                <p className="tds-muted" style={{ padding: "0.75rem" }}>
                  加载仓库…
                </p>
              ) : null}
              {!busy && repos.length === 0 ? (
                <p className="tds-muted" style={{ padding: "0.75rem" }}>
                  没有仓库。检查 Token 权限或换个帐号。
                </p>
              ) : null}
              {repos.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="tds-repo-pick-item"
                  onClick={() => {
                    setRepo(r);
                    if (!name.trim()) setName(r.name);
                    setStep("form");
                  }}
                >
                  <strong>{r.fullName}</strong>
                  <span>
                    {r.private ? "私有" : "公开"}
                    {r.description ? ` · ${r.description.slice(0, 48)}` : ""}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
