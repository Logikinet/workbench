import { createJsonRequest } from "./apiClient.js";
import type { ProjectRecord } from "./projects.js";

export interface GithubAccountRecord {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  htmlUrl?: string;
  createdAt: string;
  credentialPresent: boolean;
}

export interface GithubRepoRecord {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
  description?: string;
  cloneUrl: string;
}

export function createGithubClient(serviceUrl: string) {
  const requestJson = createJsonRequest(serviceUrl);
  return {
    listAccounts: () => requestJson<GithubAccountRecord[]>("/api/github/accounts"),
    addAccount: (token: string) =>
      requestJson<GithubAccountRecord>("/api/github/accounts", {
        method: "POST",
        body: JSON.stringify({ token })
      }),
    removeAccount: async (accountId: string) => {
      const res = await fetch(`${serviceUrl}/api/github/accounts/${encodeURIComponent(accountId)}`, {
        method: "DELETE"
      });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    },
    listRepos: (accountId: string, q?: string) => {
      const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
      return requestJson<GithubRepoRecord[]>(
        `/api/github/accounts/${encodeURIComponent(accountId)}/repos${qs}`
      );
    },
    createProjectFromRepo: (payload: {
      accountId: string;
      fullName: string;
      name?: string;
      localPath?: string;
      clone?: boolean;
    }) =>
      requestJson<ProjectRecord>("/api/github/projects", {
        method: "POST",
        body: JSON.stringify(payload)
      })
  };
}
