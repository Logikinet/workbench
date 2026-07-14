import { createJsonRequest } from "./apiClient.js";

export interface RolePermissions {
  workspace: "project_only" | "read_only";
  network: boolean;
  shell: boolean;
  externalSend: boolean;
}

export interface AgentRoleRecord {
  id: string;
  name: string;
  responsibility: string;
  systemInstruction: string;
  connectionId?: string;
  modelId?: string;
  harness: "api" | "codex-cli";
  reasoningEffort: "low" | "medium" | "high";
  skills: string[];
  tools: string[];
  permissions: RolePermissions;
  allowFirstmateAutoInvoke: boolean;
  enabled: boolean;
}

export type RoleInput = Omit<AgentRoleRecord, "id" | "enabled" | "connectionId" | "modelId"> & {
  connectionId?: string | null;
  modelId?: string | null;
};

export interface RoleVerification {
  ready: boolean;
  formalRunStarted: false;
  connection?: { ready: boolean; reason?: string };
  missingSkills: string[];
  missingTools: string[];
}

export function createRoleClient(serviceUrl: string) {
  const requestJson = createJsonRequest(serviceUrl);
  return {
    list: () => requestJson<AgentRoleRecord[]>("/api/roles"),
    create: (payload: RoleInput) => requestJson<AgentRoleRecord>("/api/roles", { method: "POST", body: JSON.stringify(payload) }),
    update: (id: string, payload: Partial<RoleInput> & { enabled?: boolean }) => requestJson<AgentRoleRecord>(`/api/roles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
    copy: (id: string, name?: string) => requestJson<AgentRoleRecord>(`/api/roles/${encodeURIComponent(id)}/copy`, { method: "POST", body: JSON.stringify({ name }) }),
    remove: (id: string) => requestJson<void>(`/api/roles/${encodeURIComponent(id)}`, { method: "DELETE" }),
    verify: (id: string) => requestJson<RoleVerification>(`/api/roles/${encodeURIComponent(id)}/verify`, { method: "POST" })
  };
}
