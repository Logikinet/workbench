/**
 * todos-style GitHub account + repo binding for Projects.
 * PAT stored in CredentialVault (never returned to clients).
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { CredentialVault } from "../connections/connectionService.js";
import type { Project, ProjectService } from "../projects/projectService.js";

export interface GithubAccountPublic {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  htmlUrl?: string;
  createdAt: string;
  /** Token present — never the secret itself. */
  credentialPresent: boolean;
}

export interface GithubRepo {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
  description?: string;
  cloneUrl: string;
}

export interface ProjectGithubBinding {
  accountId: string;
  fullName: string;
  htmlUrl: string;
  private?: boolean;
  defaultBranch?: string;
  cloneUrl?: string;
}

interface GithubAccountStored {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  htmlUrl?: string;
  credentialRef: string;
  createdAt: string;
}

interface GithubState {
  schemaVersion: 1;
  accounts: GithubAccountStored[];
}

function emptyState(): GithubState {
  return { schemaVersion: 1, accounts: [] };
}

export class GithubService {
  private constructor(
    private readonly statePath: string,
    private state: GithubState,
    private readonly vault: CredentialVault,
    private readonly projects: ProjectService,
    private readonly clonesRoot: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  static async open(input: {
    statePath: string;
    vault: CredentialVault;
    projects: ProjectService;
    clonesRoot: string;
    fetcher?: typeof fetch;
  }): Promise<GithubService> {
    try {
      const decoded = JSON.parse(await readFile(input.statePath, "utf8")) as Partial<GithubState>;
      if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.accounts)) {
        throw new Error("GitHub state is not compatible.");
      }
      return new GithubService(
        input.statePath,
        decoded as GithubState,
        input.vault,
        input.projects,
        input.clonesRoot,
        input.fetcher ?? fetch
      );
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return new GithubService(
          input.statePath,
          emptyState(),
          input.vault,
          input.projects,
          input.clonesRoot,
          input.fetcher ?? fetch
        );
      }
      throw error;
    }
  }

  async listAccounts(): Promise<GithubAccountPublic[]> {
    return this.state.accounts.map((a) => ({
      id: a.id,
      login: a.login,
      name: a.name,
      avatarUrl: a.avatarUrl,
      htmlUrl: a.htmlUrl,
      createdAt: a.createdAt,
      credentialPresent: true
    }));
  }

  /**
   * Add or refresh a GitHub account using a Personal Access Token (classic or fine-grained).
   * Token is written to the vault and never returned.
   */
  async addAccount(token: string): Promise<GithubAccountPublic> {
    const pat = token.trim();
    if (!pat) throw new Error("请粘贴 GitHub Personal Access Token。");

    const user = await this.apiJson<{
      login: string;
      name?: string | null;
      avatar_url?: string;
      html_url?: string;
      id: number;
    }>("/user", pat);

    const login = user.login?.trim();
    if (!login) throw new Error("无法读取 GitHub 用户信息，请检查 Token 权限。");

    let account = this.state.accounts.find((a) => a.login.toLowerCase() === login.toLowerCase());
    const now = new Date().toISOString();
    if (!account) {
      const id = randomUUID();
      account = {
        id,
        login,
        name: user.name?.trim() || undefined,
        avatarUrl: user.avatar_url,
        htmlUrl: user.html_url,
        credentialRef: `paw-github-${id}`,
        createdAt: now
      };
      this.state.accounts.push(account);
    } else {
      account.name = user.name?.trim() || account.name;
      account.avatarUrl = user.avatar_url || account.avatarUrl;
      account.htmlUrl = user.html_url || account.htmlUrl;
    }

    await this.vault.write(account.credentialRef, pat);
    await this.persist();
    return {
      id: account.id,
      login: account.login,
      name: account.name,
      avatarUrl: account.avatarUrl,
      htmlUrl: account.htmlUrl,
      createdAt: account.createdAt,
      credentialPresent: true
    };
  }

  async removeAccount(accountId: string): Promise<void> {
    const account = this.state.accounts.find((a) => a.id === accountId);
    if (!account) throw new Error("GitHub 帐号不存在。");
    await this.vault.remove(account.credentialRef).catch(() => undefined);
    this.state.accounts = this.state.accounts.filter((a) => a.id !== accountId);
    await this.persist();
  }

  async listRepos(accountId: string, query?: string): Promise<GithubRepo[]> {
    const token = await this.readToken(accountId);
    // Authenticated user's repos (owner + collaborator + org memberships, first pages)
    const pages: GithubRepo[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const batch = await this.apiJson<
        Array<{
          id: number;
          full_name: string;
          name: string;
          private: boolean;
          html_url: string;
          default_branch?: string;
          description?: string | null;
          clone_url: string;
        }>
      >(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, token);
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const r of batch) {
        pages.push({
          id: r.id,
          fullName: r.full_name,
          name: r.name,
          private: Boolean(r.private),
          htmlUrl: r.html_url,
          defaultBranch: r.default_branch || "main",
          description: r.description?.trim() || undefined,
          cloneUrl: r.clone_url
        });
      }
      if (batch.length < 100) break;
    }

    const q = query?.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false)
    );
  }

  /**
   * Create a Project bound to a GitHub repo (todos flow).
   * Clones into clonesRoot/owner__repo when localPath not provided.
   */
  async createProjectFromRepo(input: {
    accountId: string;
    fullName: string;
    name?: string;
    localPath?: string;
    clone?: boolean;
  }): Promise<Project> {
    const fullName = input.fullName.trim().replace(/^\/+|\/+$/g, "");
    if (!/^[^/]+\/[^/]+$/.test(fullName)) {
      throw new Error("仓库名格式应为 owner/repo。");
    }
    const token = await this.readToken(input.accountId);
    const repo = await this.apiJson<{
      full_name: string;
      name: string;
      private: boolean;
      html_url: string;
      default_branch?: string;
      clone_url: string;
      description?: string | null;
    }>(`/repos/${fullName}`, token);

    const account = this.state.accounts.find((a) => a.id === input.accountId);
    if (!account) throw new Error("GitHub 帐号不存在。");

    let workspacePath = input.localPath?.trim();
    if (!workspacePath) {
      const safe = fullName.replace(/\//g, "__");
      workspacePath = join(this.clonesRoot, safe);
      await mkdir(this.clonesRoot, { recursive: true });
    }

    const shouldClone = input.clone !== false;
    const emptyOrMissing = await isMissingOrEmptyDir(workspacePath);
    if (shouldClone && emptyOrMissing) {
      await mkdir(dirname(workspacePath), { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      // Prefer HTTPS with token via extra header env for git (avoid embedding token in URL logs).
      const cloneUrl = repo.clone_url;
      await gitClone(cloneUrl, workspacePath, token);
    } else if (emptyOrMissing) {
      await mkdir(workspacePath, { recursive: true });
    }

    const name = (input.name?.trim() || repo.name || fullName.split("/")[1] || fullName).trim();
    return this.projects.createLinked({
      name,
      workspacePath,
      summary: repo.description?.trim() || `GitHub · ${repo.full_name}`,
      github: {
        accountId: account.id,
        fullName: repo.full_name,
        htmlUrl: repo.html_url,
        private: Boolean(repo.private),
        defaultBranch: repo.default_branch || "main",
        cloneUrl: repo.clone_url
      }
    });
  }

  private async readToken(accountId: string): Promise<string> {
    const account = this.state.accounts.find((a) => a.id === accountId);
    if (!account) throw new Error("请先在设置 › GitHub 关联帐号。");
    const token = await this.vault.read(account.credentialRef);
    if (!token?.trim()) throw new Error("GitHub Token 缺失，请重新关联帐号。");
    return token.trim();
  }

  private async apiJson<T>(path: string, token: string): Promise<T> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "PersonalAIWorkbench",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("GitHub 认证失败，请检查 Token 是否有效及 repo 权限。");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`GitHub API 失败（HTTP ${response.status}）${text ? `: ${text.slice(0, 160)}` : ""}`);
    }
    return (await response.json()) as T;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(temp, this.statePath);
  }
}

async function isMissingOrEmptyDir(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path);
    return entries.length === 0;
  } catch {
    return true;
  }
}

function gitClone(cloneUrl: string, targetPath: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Use token in URL for non-interactive clone; path is local only.
    const authed = cloneUrl.replace(
      /^https:\/\//i,
      `https://x-access-token:${encodeURIComponent(token)}@`
    );
    const child = spawn("git", ["clone", "--depth", "1", authed, targetPath], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        // Redact token if it leaked into stderr
        const safe = stderr.replace(token, "[REDACTED]").replace(/x-access-token:[^@\s]+@/gi, "x-access-token:[REDACTED]@");
        reject(new Error(`git clone 失败${safe ? `: ${safe.slice(0, 240)}` : ""}`));
      }
    });
  });
}
