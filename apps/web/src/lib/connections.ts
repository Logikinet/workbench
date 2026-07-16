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

/** Unified Provider row from /api/providers (CLI + PWA shared). */
export interface ProviderRecord {
  id: string;
  name: string;
  adapter: string;
  providerType?: string;
  authMode: string;
  baseUrl?: string;
  apiProtocol?: string;
  credentialConfigured: boolean;
  credentialEnvVar?: string;
  enabled: boolean;
  status: string;
  defaultModelId?: string;
  lastTestedAt?: string;
  lastTestMessage?: string;
  models?: Array<{ remoteModelId: string; displayName?: string }>;
  type?: string;
  authLabel?: string;
}

export interface ProviderCatalogPreset {
  id: string;
  name: string;
  label: string;
  hint: string;
  adapter: string;
  providerType: string;
  defaultBaseUrl?: string;
  apiProtocol: string;
  authModes: string[];
  requiresCredential: boolean;
  allowDeferredCredential: boolean;
  description: string;
  credentialEnvVar?: string;
  defaultModelId?: string;
}

/** Legacy preset shape (GET /api/providers/presets). */
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

export interface CreateProviderPayload {
  name: string;
  adapter: string;
  providerType?: string;
  baseUrl?: string;
  apiProtocol?: string;
  authMode: string;
  apiKey?: string;
  credentialEnvVar?: string;
  defaultModelId?: string;
  discoverModels?: boolean;
  allowDeferredCredential?: boolean;
  models?: Array<{
    remoteModelId: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsReasoning?: boolean;
  }>;
}

export interface ProviderTestResult {
  status: string;
  message: string;
  detail?: string;
  modelCount?: number;
  checkedAt?: string;
}

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

    /** Unified providers (same store CLI writes to). */
    listProviders: async (): Promise<ProviderRecord[]> => {
      try {
        return await requestJson<ProviderRecord[]>("/api/providers?detailed=1");
      } catch {
        return [];
      }
    },

    listCatalog: async (): Promise<ProviderCatalogPreset[]> => {
      try {
        return await requestJson<ProviderCatalogPreset[]>("/api/providers/catalog");
      } catch {
        return [];
      }
    },

    listPresets: async () => {
      try {
        return await requestJson<ProviderPreset[]>("/api/providers/presets");
      } catch {
        return [] as ProviderPreset[];
      }
    },

    createProvider: (payload: CreateProviderPayload) =>
      requestJson<ProviderRecord>("/api/providers", {
        method: "POST",
        body: JSON.stringify(payload)
      }),

    testProvider: (id: string) =>
      requestJson<ProviderTestResult>(`/api/providers/${encodeURIComponent(id)}/test`, {
        method: "POST",
        body: "{}"
      }),

    removeProvider: (id: string) =>
      requestJson<void>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),

    setProviderCredential: (id: string, apiKey: string) =>
      requestJson<ProviderRecord>(`/api/providers/${encodeURIComponent(id)}/credential`, {
        method: "POST",
        body: JSON.stringify({ apiKey })
      }),

    discoverProviderModels: (id: string) =>
      requestJson<Array<{ remoteModelId: string; displayName?: string }>>(
        `/api/providers/${encodeURIComponent(id)}/models/discover`,
        { method: "POST", body: "{}" }
      ),

    listProviderModels: (id: string) =>
      requestJson<Array<{ remoteModelId: string; displayName?: string }>>(
        `/api/providers/${encodeURIComponent(id)}/models`
      ),

    oauthSupported: () =>
      requestJson<{ providers: Array<{ id: string; name: string }>; note?: string }>(
        "/api/providers/oauth/supported"
      ),

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

export function statusTone(
  status: string
): "success" | "danger" | "warning" | "default" {
  if (status === "ready") return "success";
  if (status === "missing_credentials" || status === "unknown") return "warning";
  if (
    status === "auth_failed" ||
    status === "unreachable" ||
    status === "misconfigured" ||
    status === "model_not_found" ||
    status === "rate_limited"
  ) {
    return "danger";
  }
  return "default";
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    ready: "就绪",
    unknown: "未测试",
    missing_credentials: "缺少凭据",
    auth_failed: "认证失败",
    unreachable: "网络失败",
    rate_limited: "限流",
    misconfigured: "配置错误",
    model_not_found: "模型不可用"
  };
  return map[status] ?? status;
}
