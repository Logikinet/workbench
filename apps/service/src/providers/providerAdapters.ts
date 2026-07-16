/**
 * Provider adapters: validate, discover models, test connection.
 * Credentials are passed only for the request lifetime — never stored here.
 */

import type {
  ProviderAdapterKind,
  ProviderConnection,
  ProviderModel,
  ProviderStatus,
  ProviderTestResult
} from "./providerTypes.js";

export interface AdapterFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface ProviderAdapter {
  kind: ProviderAdapterKind;
  validateConfig(connection: Pick<ProviderConnection, "baseUrl" | "authMode" | "credentialConfigured" | "credentialEnvVar">): void;
  discoverModels(
    connection: ProviderConnection,
    credential: string | undefined,
    fetchImpl: AdapterFetch
  ): Promise<ProviderModel[]>;
  testConnection(
    connection: ProviderConnection,
    credential: string | undefined,
    fetchImpl: AdapterFetch
  ): Promise<ProviderTestResult>;
}

function stamp(
  status: ProviderStatus,
  message: string,
  extra: Partial<ProviderTestResult> = {}
): ProviderTestResult {
  return {
    status,
    message,
    checkedAt: new Date().toISOString(),
    ...extra
  };
}

function requireBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim() ?? "";
  if (!trimmed) throw new Error("Base URL is required.");
  try {
    // eslint-disable-next-line no-new
    new URL(trimmed);
  } catch {
    throw new Error("Base URL is invalid.");
  }
  return trimmed.replace(/\/+$/, "");
}

async function classifyHttpError(response: Response): Promise<ProviderTestResult> {
  if (response.status === 401 || response.status === 403) {
    return stamp("auth_failed", "认证失败，请检查 API Key 或 OAuth。", { httpStatus: response.status });
  }
  if (response.status === 404) {
    return stamp("model_not_found", "模型服务或模型 ID 不可用。", { httpStatus: 404 });
  }
  if (response.status === 429) {
    return stamp("rate_limited", "请求被限流，请稍后重试。", { httpStatus: 429 });
  }
  return stamp("unreachable", `连接失败（HTTP ${response.status}）。`, { httpStatus: response.status });
}

function toModels(
  providerId: string,
  ids: string[]
): ProviderModel[] {
  return ids.map((remoteModelId) => ({
    id: `${providerId}:${remoteModelId}`,
    providerConnectionId: providerId,
    remoteModelId,
    displayName: remoteModelId,
    supportsReasoning: /o1|o3|r1|reason|think/i.test(remoteModelId),
    supportedThinkingLevels: [],
    enabled: true
  }));
}

export const openaiCompatibleAdapter: ProviderAdapter = {
  kind: "openai-compatible",
  validateConfig(connection) {
    requireBaseUrl(connection.baseUrl);
    if (connection.authMode === "api-key" && !connection.credentialConfigured && !connection.credentialEnvVar) {
      // allow create path before credential write
    }
  },
  async discoverModels(connection, credential, fetchImpl) {
    const base = requireBaseUrl(connection.baseUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (credential) headers.Authorization = `Bearer ${credential}`;
    const response = await fetchImpl(`${base}/models`, { headers });
    if (!response.ok) {
      const err = await classifyHttpError(response);
      throw new Error(err.message);
    }
    const payload = (await response.json().catch(() => ({ data: [] }))) as {
      data?: Array<{ id?: string }>;
    };
    const ids = (payload.data ?? [])
      .map((row) => row.id?.trim())
      .filter((id): id is string => Boolean(id));
    return toModels(connection.id, ids);
  },
  async testConnection(connection, credential, fetchImpl) {
    try {
      if (connection.authMode === "api-key" && !credential) {
        return stamp("missing_credentials", "未配置 API Key。");
      }
      if (connection.authMode === "environment") {
        const name = connection.credentialEnvVar?.trim();
        if (!name) return stamp("misconfigured", "未指定环境变量名称。");
        if (!process.env[name]) {
          return stamp("missing_credentials", `环境变量 ${name} 未设置。`);
        }
      }
      const base = requireBaseUrl(connection.baseUrl);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (credential) headers.Authorization = `Bearer ${credential}`;
      const response = await fetchImpl(`${base}/models`, { headers });
      if (!response.ok) return classifyHttpError(response);
      const payload = (await response.json().catch(() => ({ data: [] }))) as {
        data?: Array<{ id?: string }>;
      };
      const count = payload.data?.length ?? 0;
      if (connection.defaultModelId && count > 0) {
        const found = payload.data!.some((m) => m.id === connection.defaultModelId);
        if (!found) {
          return stamp("model_not_found", `连接成功，但模型 ${connection.defaultModelId} 不在列表中。`, {
            modelCount: count
          });
        }
      }
      return stamp("ready", count ? `连接成功，发现 ${count} 个模型。` : "连接成功；未返回模型列表。", {
        modelCount: count
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const hint = /ENOTFOUND/i.test(detail)
        ? "（DNS 无法解析主机名，请检查 Base URL）"
        : /ECONNREFUSED/i.test(detail)
          ? "（连接被拒绝，请确认服务已启动且端口正确）"
          : /certificate|SSL|TLS/i.test(detail)
            ? "（TLS/证书错误）"
            : /timeout|aborted/i.test(detail)
              ? "（连接超时）"
              : detail
                ? `（${detail.slice(0, 160)}）`
                : "";
      return stamp("unreachable", `网络失败，无法连接模型服务${hint}`, {
        detail
      });
    }
  }
};

export const ollamaAdapter: ProviderAdapter = {
  ...openaiCompatibleAdapter,
  kind: "ollama",
  async testConnection(connection, credential, fetchImpl) {
    // Ollama typically needs no key
    return openaiCompatibleAdapter.testConnection(
      { ...connection, authMode: connection.authMode === "api-key" ? "none" : connection.authMode },
      credential,
      fetchImpl
    );
  }
};

export const anthropicAdapter: ProviderAdapter = {
  kind: "anthropic",
  validateConfig(connection) {
    requireBaseUrl(connection.baseUrl);
  },
  async discoverModels(connection, credential, fetchImpl) {
    const base = requireBaseUrl(connection.baseUrl);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "anthropic-version": "2023-06-01"
    };
    if (credential) headers["x-api-key"] = credential;
    // Anthropic has no public models list on all tiers; fall back to known defaults on failure.
    try {
      const response = await fetchImpl(`${base}/v1/models`, { headers });
      if (response.ok) {
        const payload = (await response.json().catch(() => ({ data: [] }))) as {
          data?: Array<{ id?: string }>;
        };
        const ids = (payload.data ?? []).map((r) => r.id?.trim()).filter(Boolean) as string[];
        if (ids.length) return toModels(connection.id, ids);
      }
    } catch {
      /* use defaults */
    }
    return toModels(connection.id, ["claude-sonnet-4-20250514", "claude-3-5-haiku-latest"]);
  },
  async testConnection(connection, credential, fetchImpl) {
    try {
      if (connection.authMode === "api-key" && !credential) {
        return stamp("missing_credentials", "未配置 Anthropic API Key。");
      }
      const base = requireBaseUrl(connection.baseUrl);
      const headers: Record<string, string> = {
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      };
      if (credential) headers["x-api-key"] = credential;
      // Lightweight probe: models or tiny messages may 404; treat 401 specially.
      const response = await fetchImpl(`${base}/v1/models`, { headers });
      if (response.status === 401 || response.status === 403) {
        return stamp("auth_failed", "Anthropic 认证失败。", { httpStatus: response.status });
      }
      if (response.ok) {
        return stamp("ready", "Anthropic 连接成功。");
      }
      // Some accounts don't expose /v1/models — auth header accepted if not 401.
      if (response.status === 404) {
        return stamp("ready", "Anthropic 端点可达（models 列表可能不可用）。", { httpStatus: 404 });
      }
      return classifyHttpError(response);
    } catch (error) {
      return stamp("unreachable", "无法连接 Anthropic。", {
        detail: error instanceof Error ? error.message : undefined
      });
    }
  }
};

export const geminiAdapter: ProviderAdapter = {
  kind: "gemini",
  validateConfig(connection) {
    requireBaseUrl(connection.baseUrl);
  },
  async discoverModels(connection, credential, fetchImpl) {
    const base = requireBaseUrl(connection.baseUrl);
    const url = credential
      ? `${base}/models?key=${encodeURIComponent(credential)}`
      : `${base}/models`;
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      const err = await classifyHttpError(response);
      throw new Error(err.message);
    }
    const payload = (await response.json().catch(() => ({ models: [] }))) as {
      models?: Array<{ name?: string }>;
    };
    const ids = (payload.models ?? [])
      .map((m) => m.name?.replace(/^models\//, "").trim())
      .filter((id): id is string => Boolean(id));
    return toModels(connection.id, ids);
  },
  async testConnection(connection, credential, fetchImpl) {
    try {
      if (connection.authMode === "api-key" && !credential) {
        return stamp("missing_credentials", "未配置 Gemini API Key。");
      }
      const base = requireBaseUrl(connection.baseUrl);
      const url = credential
        ? `${base}/models?key=${encodeURIComponent(credential)}`
        : `${base}/models`;
      const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
      if (!response.ok) return classifyHttpError(response);
      const payload = (await response.json().catch(() => ({ models: [] }))) as {
        models?: unknown[];
      };
      const count = Array.isArray(payload.models) ? payload.models.length : 0;
      return stamp("ready", count ? `Gemini 连接成功，发现 ${count} 个模型。` : "Gemini 连接成功。", {
        modelCount: count
      });
    } catch (error) {
      return stamp("unreachable", "无法连接 Gemini。", {
        detail: error instanceof Error ? error.message : undefined
      });
    }
  }
};

const ADAPTERS: Record<ProviderAdapterKind, ProviderAdapter> = {
  "openai-compatible": openaiCompatibleAdapter,
  ollama: ollamaAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter
};

export function getProviderAdapter(kind: ProviderAdapterKind): ProviderAdapter {
  return ADAPTERS[kind] ?? openaiCompatibleAdapter;
}
