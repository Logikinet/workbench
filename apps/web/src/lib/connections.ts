import { createJsonRequest } from "./apiClient.js";

export interface ConnectionRecord {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
}

export interface ConnectionTestResult {
  kind: "success" | "authentication_failed" | "network_failed" | "model_unavailable";
  message: string;
}

export function createConnectionClient(serviceUrl: string) {
  const requestJson = createJsonRequest(serviceUrl);
  return {
    list: () => requestJson<ConnectionRecord[]>("/api/connections"),
    create: (payload: { name?: string; baseUrl: string; apiKey: string; modelId: string }) =>
      requestJson<ConnectionRecord>("/api/connections", { method: "POST", body: JSON.stringify(payload) }),
    update: (id: string, payload: Partial<{ name: string; baseUrl: string; apiKey: string; modelId: string; enabled: boolean }>) =>
      requestJson<ConnectionRecord>(`/api/connections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
    remove: (id: string) => requestJson<void>(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
    test: (id: string) => requestJson<ConnectionTestResult>(`/api/connections/${encodeURIComponent(id)}/test`, { method: "POST" })
  };
}
