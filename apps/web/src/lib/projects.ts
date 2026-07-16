export interface ProjectGithubRecord {
  accountId: string;
  fullName: string;
  htmlUrl: string;
  private?: boolean;
  defaultBranch?: string;
  cloneUrl?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  workspacePath: string;
  summary?: string;
  status: "active" | "archived";
  workspaceLinkStatus?: "linked" | "needs_repair";
  workspaceRepairNote?: string;
  /** todos-style GitHub binding */
  github?: ProjectGithubRecord;
}

export interface CreateProjectPayload {
  name: string;
  workspacePath: string;
  summary?: string;
  authorizationGrantId: string;
}

export interface WorkspaceGrant {
  id: string;
  workspacePath: string;
  expiresAt: string;
}

export interface ProjectClient {
  list(): Promise<ProjectRecord[]>;
  requestWorkspaceAuthorization(workspacePath: string): Promise<WorkspaceGrant>;
  create(payload: CreateProjectPayload): Promise<ProjectRecord>;
  update(id: string, payload: Partial<Pick<ProjectRecord, "name" | "summary" | "status">>): Promise<ProjectRecord>;
}

export function createProjectClient(serviceUrl: string): ProjectClient {
  const requestJson = createJsonRequest(serviceUrl);

  return {
    list: () => requestJson<ProjectRecord[]>("/api/projects"),
    requestWorkspaceAuthorization: (workspacePath) =>
      requestJson<WorkspaceGrant>("/api/workspace-authorizations", {
        method: "POST",
        body: JSON.stringify({ workspacePath })
      }),
    create: (payload) => requestJson<ProjectRecord>("/api/projects", { method: "POST", body: JSON.stringify(payload) }),
    update: (id, payload) =>
      requestJson<ProjectRecord>(`/api/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      })
  };
}
import { createJsonRequest } from "./apiClient.js";
