import { createJsonRequest } from "./apiClient.js";

export interface McpTestResult {
  kind: "success" | "authentication_failed" | "network_failed" | "server_unavailable" | "disabled";
  message: string;
  detail?: string;
  checkedAt: string;
  toolCount?: number;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  risk?: string;
  connectionId?: string;
  toolName?: string;
}

export interface McpConnectionRecord {
  id: string;
  name: string;
  transport: "stdio" | "http" | "fake";
  enabled: boolean;
  command?: string;
  args?: string[];
  envKeys?: string[];
  url?: string;
  credentialPresent?: boolean;
  tools?: McpToolDescriptor[];
  lastTest?: McpTestResult;
  createdAt?: string;
  updatedAt?: string;
}

export interface RoleMcpBinding {
  roleId: string;
  tools: Array<{ connectionId: string; toolName: string }>;
  updatedAt: string;
}

export interface CreateMcpConnectionInput {
  name: string;
  transport: "stdio" | "http" | "fake";
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  authToken?: string;
}

export function createMcpClient(serviceUrl: string) {
  const json = createJsonRequest(serviceUrl);

  return {
    async list(): Promise<McpConnectionRecord[]> {
      return json<McpConnectionRecord[]>("/api/mcp/connections");
    },
    async create(input: CreateMcpConnectionInput): Promise<McpConnectionRecord> {
      return json<McpConnectionRecord>("/api/mcp/connections", {
        method: "POST",
        body: JSON.stringify(input)
      });
    },
    async update(
      id: string,
      input: Partial<CreateMcpConnectionInput> & { enabled?: boolean; clearSecrets?: boolean }
    ): Promise<McpConnectionRecord> {
      return json<McpConnectionRecord>(`/api/mcp/connections/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input)
      });
    },
    async remove(id: string): Promise<void> {
      await json<void>(`/api/mcp/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async test(id: string): Promise<McpTestResult> {
      return json<McpTestResult>(`/api/mcp/connections/${encodeURIComponent(id)}/test`, {
        method: "POST",
        body: "{}"
      });
    },
    async listTools(id: string, refresh = false): Promise<McpToolDescriptor[]> {
      const q = refresh ? "?refresh=1" : "";
      return json<McpToolDescriptor[]>(`/api/mcp/connections/${encodeURIComponent(id)}/tools${q}`);
    },
    async setRoleBindings(
      roleId: string,
      tools: Array<{ connectionId: string; toolName: string }>
    ): Promise<RoleMcpBinding> {
      return json<RoleMcpBinding>(`/api/mcp/role-bindings/${encodeURIComponent(roleId)}`, {
        method: "PUT",
        body: JSON.stringify({ tools })
      });
    },
    async getRoleBindings(roleId: string): Promise<RoleMcpBinding> {
      return json<RoleMcpBinding>(`/api/mcp/role-bindings/${encodeURIComponent(roleId)}`);
    }
  };
}
