import { createJsonRequest } from "./apiClient.js";

export interface ConnectionTestResult {
  kind: "success" | "authentication_failed" | "network_failed" | "model_unavailable";
  message: string;
  detail?: string;
  httpStatus?: number;
  checkedAt?: string;
}

export interface CapabilityProbeResult {
  modelsEndpoint: boolean;
  chatCompletions: boolean;
  modelListed: boolean;
  supportsModelList: boolean;
  message: string;
  detail?: string;
  checkedAt: string;
  httpStatus?: number;
}

export interface UsageSnapshot {
  available: boolean;
  source: "provider_endpoint" | "last_completion" | "unsupported" | "error";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  message: string;
  fetchedAt: string;
}

export interface ConnectionRecord {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  presetId?: string;
  providerKind?: string;
  modelSource?: "manual" | "discovered";
  credentialPresent?: boolean;
  credentialUpdatedAt?: string;
  lastTest?: ConnectionTestResult;
  lastProbe?: CapabilityProbeResult;
  lastUsage?: UsageSnapshot;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  kind: string;
  defaultBaseUrl?: string;
  allowCustomBaseUrl: boolean;
  supportsModelList: boolean;
  supportsUsage: boolean;
  authStyle: string;
  requiresCredential: boolean;
  description: string;
}

export interface DiscoveredModel {
  id: string;
  ownedBy?: string;
}

export interface ModelListResult {
  models: DiscoveredModel[];
  supported: boolean;
  message: string;
  manualModelIdRequired: boolean;
}

export interface ConnectionAuditEntry {
  id: string;
  connectionId?: string;
  action: string;
  summary: string;
  at: string;
  revision?: number;
}

export interface CreateConnectionPayload {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId: string;
  enabled?: boolean;
  presetId?: string;
  providerKind?: string;
  modelSource?: "manual" | "discovered";
}

export type UpdateConnectionPayload = Partial<CreateConnectionPayload> & { enabled?: boolean };

export function createConnectionClient(serviceUrl: string) {
  const requestJson = createJsonRequest(serviceUrl);

  const listLegacy = () => requestJson<ConnectionRecord[]>("/api/connections");
  const listPublic = () => requestJson<ConnectionRecord[]>("/api/connections/public");

  return {
    /** Prefer public view (credentialPresent, diagnostics); fall back to legacy list. */
    list: async () => {
      try {
        return await listPublic();
      } catch {
        return listLegacy();
      }
    },
    listPresets: async () => {
      try {
        return await requestJson<ProviderPreset[]>("/api/providers/presets");
      } catch {
        return [] as ProviderPreset[];
      }
    },
    create: async (payload: CreateConnectionPayload) => {
      try {
        return await requestJson<ConnectionRecord>("/api/connections/v2", {
          method: "POST",
          body: JSON.stringify(payload)
        });
      } catch {
        return requestJson<ConnectionRecord>("/api/connections", {
          method: "POST",
          body: JSON.stringify({
            name: payload.name,
            baseUrl: payload.baseUrl ?? "",
            apiKey: payload.apiKey ?? "",
            modelId: payload.modelId,
            enabled: payload.enabled
          })
        });
      }
    },
    update: async (id: string, payload: UpdateConnectionPayload) => {
      try {
        return await requestJson<ConnectionRecord>(`/api/connections/${encodeURIComponent(id)}/v2`, {
          method: "PATCH",
          body: JSON.stringify(payload)
        });
      } catch {
        return requestJson<ConnectionRecord>(`/api/connections/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: payload.name,
            baseUrl: payload.baseUrl,
            apiKey: payload.apiKey,
            modelId: payload.modelId,
            enabled: payload.enabled
          })
        });
      }
    },
    remove: (id: string) =>
      requestJson<void>(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
    test: (id: string) =>
      requestJson<ConnectionTestResult>(`/api/connections/${encodeURIComponent(id)}/test`, { method: "POST" }),
    listModels: (id: string) =>
      requestJson<ModelListResult>(`/api/connections/${encodeURIComponent(id)}/models`),
    probe: (id: string) =>
      requestJson<CapabilityProbeResult>(`/api/connections/${encodeURIComponent(id)}/probe`, { method: "POST" }),
    usage: (id: string) =>
      requestJson<UsageSnapshot>(`/api/connections/${encodeURIComponent(id)}/usage`),
    hotApply: (id?: string) =>
      id
        ? requestJson<{ revision: number }>(`/api/connections/${encodeURIComponent(id)}/apply`, { method: "POST" })
        : requestJson<{ revision: number }>("/api/connections/apply", { method: "POST" }),
    audit: (id?: string) =>
      id
        ? requestJson<ConnectionAuditEntry[]>(`/api/connections/${encodeURIComponent(id)}/audit`)
        : requestJson<ConnectionAuditEntry[]>("/api/connections/audit")
  };
}
