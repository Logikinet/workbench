import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import {
  ConfigHotReloader,
  type ConfigChangeEvent,
  type ConfigChangeListener,
  getProviderPreset,
  normalizeBaseUrl,
  validateProviderConfig,
  type ModelSource,
  type ProviderKind
} from "../providers/index.js";

export interface CredentialVault {
  read(reference: string): Promise<string | undefined>;
  write(reference: string, secret: string): Promise<void>;
  remove(reference: string): Promise<void>;
}

export type ConnectionTestKind =
  | "success"
  | "authentication_failed"
  | "network_failed"
  | "model_unavailable";

export interface ConnectionTestResult {
  kind: ConnectionTestKind;
  message: string;
  /** Extra non-secret diagnostics for UI / Doctor. */
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

export interface ModelConnection {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  credentialRef: string;
  createdAt: string;
  updatedAt: string;
  /** Optional extensions (always normalized on read). */
  presetId?: string;
  providerKind?: ProviderKind;
  modelSource?: ModelSource;
  /** Non-secret flag: vault has a value (never the secret itself). */
  credentialPresent?: boolean;
  credentialUpdatedAt?: string;
  lastTest?: ConnectionTestResult;
  lastProbe?: CapabilityProbeResult;
  lastUsage?: UsageSnapshot;
}

/** Public, secret-free connection row for HTTP/UI. */
export interface PublicConnection {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  presetId: string;
  providerKind: ProviderKind;
  modelSource: ModelSource;
  credentialPresent: boolean;
  credentialUpdatedAt?: string;
  lastTest?: ConnectionTestResult;
  lastProbe?: CapabilityProbeResult;
  lastUsage?: UsageSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConnectionInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId: string;
  enabled?: boolean;
  presetId?: string;
  providerKind?: ProviderKind | string;
  modelSource?: ModelSource | string;
}

export interface UpdateConnectionInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  enabled?: boolean;
  presetId?: string;
  providerKind?: ProviderKind | string;
  modelSource?: ModelSource | string;
}

export interface ConnectionTestOptions {
  notifyOnUnavailable?: boolean;
}

export interface ChatCompletionMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatCompletionInput {
  modelId?: string;
  messages: ChatCompletionMessage[];
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  content: string;
  modelId: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface DiscoveredModel {
  id: string;
  ownedBy?: string;
}

export interface ModelListResult {
  models: DiscoveredModel[];
  /** True when the endpoint worked; false means UI should allow manual model ID. */
  supported: boolean;
  message: string;
  manualModelIdRequired: boolean;
}

export interface ConnectionAuditEntry {
  id: string;
  connectionId?: string;
  action: string;
  summary: string;
  /** Secret-free field diffs. */
  changes?: Record<string, { from?: unknown; to?: unknown }>;
  at: string;
  revision?: number;
}

export interface HotApplyResult {
  revision: number;
  appliedAt: string;
  connectionCount: number;
  event: ConfigChangeEvent;
}

type ConnectionFetcher = (input: string, init?: RequestInit) => Promise<Response>;
type ConnectionFailureHandler = (connectionId: string, reason: string) => Promise<void>;

interface ConnectionState {
  schemaVersion: 1;
  connections: ModelConnection[];
}

export interface ConnectionStateSnapshot {
  schemaVersion: 1;
  connections: ModelConnection[];
}

interface AuditState {
  schemaVersion: 1;
  entries: ConnectionAuditEntry[];
}

const MAX_AUDIT_ENTRIES = 500;

function emptyState(): ConnectionState {
  return { schemaVersion: 1, connections: [] };
}

function emptyAudit(): AuditState {
  return { schemaVersion: 1, entries: [] };
}

export class ConnectionService {
  private readonly hotReloader = new ConfigHotReloader();
  private audit: AuditState = emptyAudit();
  private auditPath: string;

  private constructor(
    private readonly statePath: string,
    private state: ConnectionState,
    private readonly vault: CredentialVault,
    private readonly fetcher: ConnectionFetcher,
    private readonly onUnavailable?: ConnectionFailureHandler,
    auditPath?: string
  ) {
    this.auditPath = auditPath ?? defaultAuditPath(statePath);
  }

  static async open(
    statePath: string,
    vault: CredentialVault,
    fetcher: ConnectionFetcher = fetch,
    onUnavailable?: ConnectionFailureHandler,
    auditPath?: string
  ): Promise<ConnectionService> {
    let state: ConnectionState;
    try {
      const decoded = JSON.parse(await readFile(statePath, "utf8")) as Partial<ConnectionState>;
      if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.connections)) {
        throw new Error("Connection state is not compatible with this service version.");
      }
      state = {
        schemaVersion: 1,
        connections: decoded.connections.map((entry) => normalizeConnection(entry))
      };
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        state = emptyState();
      } else {
        throw error;
      }
    }
    const service = new ConnectionService(statePath, state, vault, fetcher, onUnavailable, auditPath);
    await service.loadAudit();
    return service;
  }

  /** Current hot-apply revision (increments on config mutations). */
  getConfigRevision(): number {
    return this.hotReloader.getRevision();
  }

  subscribeConfigChanges(listener: ConfigChangeListener): () => void {
    return this.hotReloader.subscribe(listener);
  }

  async list(): Promise<ModelConnection[]> {
    return [...this.state.connections]
      .map((entry) => normalizeConnection(entry))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listPublic(): Promise<PublicConnection[]> {
    return (await this.list()).map(toPublicConnection);
  }

  async get(connectionId: string): Promise<ModelConnection> {
    const connection = this.state.connections.find((entry) => entry.id === connectionId);
    if (!connection) throw new Error(`Connection ${connectionId} was not found.`);
    return normalizeConnection(connection);
  }

  async getPublic(connectionId: string): Promise<PublicConnection> {
    return toPublicConnection(await this.get(connectionId));
  }

  /**
   * Durable connection index for backup export.
   * Never reads the credential vault — only opaque credentialRef placeholders are returned.
   * Runtime diagnostics and credentialPresent flags are omitted so backup/restore round-trips
   * stay stable and secrets stay out of packages.
   */
  async exportSnapshot(): Promise<ConnectionStateSnapshot> {
    return {
      schemaVersion: 1,
      connections: this.state.connections.map((entry) => toBackupConnectionRow(entry))
    };
  }

  /**
   * Replace connection index from a backup snapshot.
   * Does not write vault secrets; API keys remain absent until the user re-enters them.
   */
  async importSnapshot(snapshot: ConnectionStateSnapshot): Promise<void> {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.connections)) {
      throw new Error("Connection backup snapshot is not compatible with this service version.");
    }
    this.state = {
      schemaVersion: 1,
      connections: structuredClone(snapshot.connections).map((entry) =>
        normalizeConnection({
          ...toBackupConnectionRow(entry),
          // Snapshots never include vault secrets.
          credentialPresent:
            typeof entry.credentialPresent === "boolean" ? entry.credentialPresent : false,
          credentialUpdatedAt: undefined,
          lastTest: undefined,
          lastProbe: undefined,
          lastUsage: undefined
        })
      )
    };
    await this.persist();
    await this.recordAudit({
      action: "import",
      summary: `Imported ${this.state.connections.length} connection(s) without secrets.`,
      revision: this.getConfigRevision()
    });
    await this.hotReloader.notify("reload", "Connection index restored from backup (secrets excluded).");
  }

  async create(input: CreateConnectionInput): Promise<ModelConnection> {
    const validated = validateProviderConfig({
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      modelId: input.modelId,
      enabled: input.enabled,
      presetId: input.presetId,
      providerKind: input.providerKind,
      modelSource: input.modelSource,
      hasExistingCredential: false
    });

    const id = randomUUID();
    const now = new Date().toISOString();
    const credentialRef = `PersonalAIWorkbench:connection:${id}`;
    const connection: ModelConnection = {
      id,
      name: validated.name || validated.modelId,
      baseUrl: validated.baseUrl,
      modelId: validated.modelId,
      enabled: validated.enabled,
      credentialRef,
      createdAt: now,
      updatedAt: now,
      presetId: validated.presetId,
      providerKind: validated.providerKind,
      modelSource: validated.modelSource,
      credentialPresent: false
    };

    if (validated.apiKey) {
      await this.vault.write(credentialRef, validated.apiKey);
      connection.credentialPresent = true;
      connection.credentialUpdatedAt = now;
    } else if (validated.preset.requiresCredential) {
      throw new Error("An API Key is required for this provider preset.");
    }

    this.state.connections.push(connection);
    try {
      await this.persist();
    } catch (error) {
      this.state.connections = this.state.connections.filter((entry) => entry.id !== connection.id);
      if (connection.credentialPresent) await this.vault.remove(credentialRef);
      throw error;
    }

    const event = await this.hotReloader.notify("create", `Created connection ${connection.name}`, connection.id);
    await this.recordAudit({
      connectionId: connection.id,
      action: "create",
      summary: `Created provider connection “${connection.name}” (${connection.presetId}).`,
      changes: {
        presetId: { to: connection.presetId },
        baseUrl: { to: connection.baseUrl },
        modelId: { to: connection.modelId },
        enabled: { to: connection.enabled },
        credentialPresent: { to: connection.credentialPresent }
      },
      revision: event.revision
    });
    return normalizeConnection(connection);
  }

  async update(connectionId: string, input: UpdateConnectionInput): Promise<ModelConnection> {
    const connection = await this.getMutable(connectionId);
    const snapshot = { ...connection };

    const nextPresetId = input.presetId ?? connection.presetId ?? "custom";
    const validated = validateProviderConfig({
      name: input.name !== undefined ? input.name : connection.name,
      baseUrl: input.baseUrl !== undefined ? input.baseUrl : connection.baseUrl,
      modelId: input.modelId !== undefined ? input.modelId : connection.modelId,
      enabled: input.enabled !== undefined ? input.enabled : connection.enabled,
      presetId: nextPresetId,
      providerKind: input.providerKind ?? connection.providerKind,
      modelSource: input.modelSource ?? connection.modelSource,
      apiKey: input.apiKey,
      hasExistingCredential: connection.credentialPresent === true
    });

    // Non-empty apiKey replaces vault secret; empty/omitted leaves vault unchanged (edit UX).
    const secretToWrite =
      input.apiKey !== undefined && input.apiKey.trim() ? input.apiKey.trim() : undefined;

    const previousSecret = secretToWrite !== undefined ? await this.vault.read(connection.credentialRef) : undefined;
    if (secretToWrite !== undefined) await this.vault.write(connection.credentialRef, secretToWrite);

    const changes: Record<string, { from?: unknown; to?: unknown }> = {};
    const assign = <K extends keyof ModelConnection>(key: K, value: ModelConnection[K]) => {
      if (connection[key] !== value) {
        changes[key as string] = { from: connection[key], to: value };
        connection[key] = value;
      }
    };

    assign("name", validated.name || connection.name);
    assign("baseUrl", validated.baseUrl);
    assign("modelId", validated.modelId);
    assign("enabled", validated.enabled);
    assign("presetId", validated.presetId);
    assign("providerKind", validated.providerKind);
    assign("modelSource", validated.modelSource);

    if (secretToWrite !== undefined) {
      connection.credentialPresent = true;
      connection.credentialUpdatedAt = new Date().toISOString();
      changes.credentialPresent = { from: snapshot.credentialPresent, to: true };
      changes.credentialUpdated = { to: true };
    }

    connection.updatedAt = new Date().toISOString();

    try {
      await this.persist();
    } catch (error) {
      Object.assign(connection, snapshot);
      if (secretToWrite !== undefined) {
        if (previousSecret !== undefined) await this.vault.write(connection.credentialRef, previousSecret);
        else await this.vault.remove(connection.credentialRef);
      }
      throw error;
    }

    const event = await this.hotReloader.notify(
      secretToWrite !== undefined ? "credential_update" : "update",
      `Updated connection ${connection.name}`,
      connection.id
    );
    await this.recordAudit({
      connectionId: connection.id,
      action: secretToWrite !== undefined ? "credential_update" : "update",
      summary: `Updated connection “${connection.name}” (secrets redacted).`,
      changes,
      revision: event.revision
    });
    return normalizeConnection(connection);
  }

  async remove(connectionId: string): Promise<void> {
    const connection = await this.getMutable(connectionId);
    const index = this.state.connections.findIndex((entry) => entry.id === connectionId);
    const previousSecret = await this.vault.read(connection.credentialRef);
    await this.vault.remove(connection.credentialRef);
    this.state.connections.splice(index, 1);
    try {
      await this.persist();
    } catch (error) {
      this.state.connections.splice(index, 0, connection);
      if (previousSecret !== undefined) await this.vault.write(connection.credentialRef, previousSecret);
      throw error;
    }
    const event = await this.hotReloader.notify("remove", `Removed connection ${connection.name}`, connectionId);
    await this.recordAudit({
      connectionId,
      action: "remove",
      summary: `Removed connection “${connection.name}”.`,
      revision: event.revision
    });
  }

  /**
   * Hot-apply current non-secret config: bump revision, notify subscribers.
   * Does not restart the process; in-memory ConnectionService is already the live source of truth.
   */
  async hotApply(connectionId?: string): Promise<HotApplyResult> {
    if (connectionId) {
      await this.get(connectionId);
    }
    // Re-validate all (or one) connection schemas before notifying.
    const targets = connectionId
      ? [await this.get(connectionId)]
      : await this.list();
    for (const connection of targets) {
      validateProviderConfig({
        name: connection.name,
        baseUrl: connection.baseUrl,
        modelId: connection.modelId,
        enabled: connection.enabled,
        presetId: connection.presetId,
        providerKind: connection.providerKind,
        modelSource: connection.modelSource,
        hasExistingCredential: connection.credentialPresent === true || !getProviderPreset(connection.presetId ?? "custom")?.requiresCredential
      });
    }
    const event = await this.hotReloader.notify(
      "hot_apply",
      connectionId
        ? `Hot-applied connection ${connectionId}`
        : `Hot-applied ${targets.length} connection(s)`,
      connectionId
    );
    await this.recordAudit({
      connectionId,
      action: "hot_apply",
      summary: event.summary,
      revision: event.revision
    });
    return {
      revision: event.revision,
      appliedAt: event.at,
      connectionCount: targets.length,
      event
    };
  }

  async test(connectionId: string, modelId?: string, options: ConnectionTestOptions = {}): Promise<ConnectionTestResult> {
    const connection = await this.getMutable(connectionId);
    const requestedModelId = modelId?.trim() || connection.modelId;
    const notifyOnUnavailable = options.notifyOnUnavailable ?? true;
    const checkedAt = new Date().toISOString();
    const apiKey = await this.readCredential(connection);

    if (getProviderPreset(connection.presetId ?? "custom")?.requiresCredential !== false && !apiKey) {
      const result = withStamp(
        { kind: "authentication_failed", message: "未找到本机安全凭据，请重新保存 API Key。", detail: "credentialPresent=false" },
        checkedAt
      );
      return this.finishTest(connection, result, notifyOnUnavailable);
    }

    try {
      const headers = buildAuthHeaders(connection, apiKey);
      const response = await this.fetcher(`${connection.baseUrl}/models`, { headers });
      if (response.status === 401 || response.status === 403) {
        return this.finishTest(
          connection,
          withStamp({ kind: "authentication_failed", message: "认证失败，请检查 API Key。", httpStatus: response.status }, checkedAt),
          notifyOnUnavailable
        );
      }
      if (!response.ok) {
        return this.finishTest(
          connection,
          withStamp(
            response.status === 404
              ? { kind: "model_unavailable", message: "模型服务或模型 ID 不可用。", httpStatus: 404 }
              : { kind: "network_failed", message: `连接失败（HTTP ${response.status}）。`, httpStatus: response.status },
            checkedAt
          ),
          notifyOnUnavailable
        );
      }
      const payload = (await response.json().catch(() => ({ data: [] }))) as { data?: Array<{ id?: string }> };
      const modelAvailable = payload.data?.some((model) => model.id === requestedModelId) ?? false;
      if (modelAvailable) {
        return this.finishTest(
          connection,
          withStamp({ kind: "success", message: "连接成功，模型可用。" }, checkedAt),
          false
        );
      }
      // If /models returned empty list (some proxies), still treat as soft success when HTTP 200.
      if (!payload.data || payload.data.length === 0) {
        return this.finishTest(
          connection,
          withStamp({
            kind: "success",
            message: "连接成功；服务未返回模型列表，请确认手动填写的模型 ID。",
            detail: "models_list_empty"
          }, checkedAt),
          false
        );
      }
      return this.finishTest(
        connection,
        withStamp({ kind: "model_unavailable", message: "连接成功，但指定模型不可用。", detail: `requested=${requestedModelId}` }, checkedAt),
        notifyOnUnavailable
      );
    } catch (error) {
      return this.finishTest(
        connection,
        withStamp({
          kind: "network_failed",
          message: "网络失败，无法连接模型服务。",
          detail: error instanceof Error ? error.message : undefined
        }, checkedAt),
        notifyOnUnavailable
      );
    }
  }

  /**
   * Capability probe: models endpoint + optional minimal chat completion.
   * Never returns secrets.
   */
  async probe(connectionId: string): Promise<CapabilityProbeResult> {
    const connection = await this.getMutable(connectionId);
    const checkedAt = new Date().toISOString();
    const preset = getProviderPreset(connection.presetId ?? "custom");
    const apiKey = await this.readCredential(connection);
    const result: CapabilityProbeResult = {
      modelsEndpoint: false,
      chatCompletions: false,
      modelListed: false,
      supportsModelList: preset?.supportsModelList ?? true,
      message: "",
      checkedAt
    };

    if (preset?.requiresCredential !== false && !apiKey) {
      result.message = "缺少本机凭据，无法探测能力。";
      result.detail = "authentication_failed";
      connection.lastProbe = result;
      connection.updatedAt = checkedAt;
      await this.persist();
      await this.recordAudit({
        connectionId,
        action: "probe",
        summary: result.message
      });
      return result;
    }

    const headers = buildAuthHeaders(connection, apiKey);
    try {
      const modelsResponse = await this.fetcher(`${connection.baseUrl}/models`, { headers });
      result.httpStatus = modelsResponse.status;
      if (modelsResponse.status === 401 || modelsResponse.status === 403) {
        result.message = "认证失败，能力探测中止。";
        result.detail = "authentication_failed";
      } else if (modelsResponse.ok) {
        result.modelsEndpoint = true;
        const payload = (await modelsResponse.json().catch(() => ({ data: [] }))) as {
          data?: Array<{ id?: string }>;
        };
        result.modelListed = payload.data?.some((model) => model.id === connection.modelId) ?? false;
      } else {
        result.detail = `models_http_${modelsResponse.status}`;
      }
    } catch (error) {
      result.detail = error instanceof Error ? `models_network: ${error.message}` : "models_network";
    }

    try {
      const chatResponse = await this.fetcher(`${connection.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: connection.modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          temperature: 0
        })
      });
      if (chatResponse.status === 401 || chatResponse.status === 403) {
        result.detail = result.detail ?? "chat_authentication_failed";
      } else if (chatResponse.ok) {
        result.chatCompletions = true;
        const payload = (await chatResponse.json().catch(() => ({}))) as {
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        if (payload.usage) {
          connection.lastUsage = {
            available: true,
            source: "last_completion",
            promptTokens: payload.usage.prompt_tokens,
            completionTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
            message: "Usage captured from capability probe completion.",
            fetchedAt: checkedAt
          };
        }
      } else {
        result.detail = result.detail ?? `chat_http_${chatResponse.status}`;
      }
    } catch (error) {
      result.detail =
        result.detail ??
        (error instanceof Error ? `chat_network: ${error.message}` : "chat_network");
    }

    if (result.modelsEndpoint && result.chatCompletions) {
      result.message = result.modelListed
        ? "模型列表与 Chat Completions 均可用。"
        : "Chat Completions 可用；指定模型未出现在列表中（可继续手动使用）。";
    } else if (result.modelsEndpoint) {
      result.message = "模型列表可用，但 Chat Completions 探测失败。";
    } else if (result.chatCompletions) {
      result.message = "Chat Completions 可用；模型列表接口不可用，请手动填写模型 ID。";
    } else {
      result.message = "能力探测失败，请检查 Base URL、凭据与网络。";
    }

    connection.lastProbe = result;
    connection.updatedAt = checkedAt;
    await this.persist();
    await this.recordAudit({
      connectionId,
      action: "probe",
      summary: result.message,
      changes: {
        modelsEndpoint: { to: result.modelsEndpoint },
        chatCompletions: { to: result.chatCompletions },
        modelListed: { to: result.modelListed }
      }
    });
    return result;
  }

  /**
   * Usage snapshot — never includes secrets.
   * Tries provider usage endpoint when preset supports it; otherwise returns last completion usage.
   */
  async usageSnapshot(connectionId: string): Promise<UsageSnapshot> {
    const connection = await this.getMutable(connectionId);
    const fetchedAt = new Date().toISOString();
    const preset = getProviderPreset(connection.presetId ?? "custom");

    if (connection.lastUsage?.available && connection.lastUsage.source === "last_completion") {
      // Prefer fresh provider endpoint when supported.
    }

    if (preset?.supportsUsage) {
      const apiKey = await this.readCredential(connection);
      if (!apiKey && preset.requiresCredential) {
        const snapshot: UsageSnapshot = {
          available: false,
          source: "error",
          message: "缺少本机凭据，无法读取 Usage。",
          fetchedAt
        };
        connection.lastUsage = snapshot;
        await this.persist();
        return snapshot;
      }
      try {
        const headers = buildAuthHeaders(connection, apiKey);
        // OpenAI-compatible optional path used by some gateways; failures are non-fatal.
        const response = await this.fetcher(`${connection.baseUrl}/dashboard/billing/usage`, { headers });
        if (response.ok) {
          const payload = (await response.json().catch(() => ({}))) as {
            total_usage?: number;
            total_tokens?: number;
          };
          const snapshot: UsageSnapshot = {
            available: true,
            source: "provider_endpoint",
            totalTokens: payload.total_tokens ?? payload.total_usage,
            message: "Usage snapshot loaded from provider endpoint.",
            fetchedAt
          };
          connection.lastUsage = snapshot;
          connection.updatedAt = fetchedAt;
          await this.persist();
          return snapshot;
        }
      } catch {
        // fall through
      }
    }

    if (connection.lastUsage?.available) {
      return { ...connection.lastUsage, fetchedAt };
    }

    const snapshot: UsageSnapshot = {
      available: false,
      source: preset?.supportsUsage ? "error" : "unsupported",
      message: preset?.supportsUsage
        ? "无法从 Provider 获取 Usage；可先运行连接测试或能力探测。"
        : "当前 Provider 不提供 Usage 接口；完成一次探测/对话后可显示最近 token 用量。",
      fetchedAt
    };
    connection.lastUsage = snapshot;
    await this.persist();
    return snapshot;
  }

  async listModels(connectionId: string): Promise<ModelListResult> {
    const connection = await this.get(connectionId);
    const preset = getProviderPreset(connection.presetId ?? "custom");
    const apiKey = await this.readCredential(connection);

    if (preset?.requiresCredential !== false && !apiKey) {
      return {
        models: [],
        supported: false,
        manualModelIdRequired: true,
        message: "缺少本机凭据，无法拉取模型列表；请手动填写模型 ID。"
      };
    }

    try {
      const headers = buildAuthHeaders(connection, apiKey);
      const response = await this.fetcher(`${connection.baseUrl}/models`, { headers });
      if (response.status === 401 || response.status === 403) {
        return {
          models: [],
          supported: false,
          manualModelIdRequired: true,
          message: "认证失败，无法拉取模型列表；请检查 API Key 或手动填写模型 ID。"
        };
      }
      if (response.status === 404 || response.status === 405) {
        return {
          models: [],
          supported: false,
          manualModelIdRequired: true,
          message: "该端点不支持模型列表接口；请手动填写模型 ID。"
        };
      }
      if (!response.ok) {
        return {
          models: [],
          supported: false,
          manualModelIdRequired: true,
          message: `拉取模型列表失败（HTTP ${response.status}）；请手动填写模型 ID。`
        };
      }
      const payload = (await response.json().catch(() => ({ data: [] }))) as {
        data?: Array<{ id?: string; owned_by?: string }>;
      };
      const models = (payload.data ?? [])
        .filter((entry): entry is { id: string; owned_by?: string } => typeof entry.id === "string" && !!entry.id)
        .map((entry) => ({ id: entry.id, ownedBy: entry.owned_by }));
      if (models.length === 0) {
        return {
          models: [],
          supported: true,
          manualModelIdRequired: true,
          message: "服务返回空模型列表；请手动填写模型 ID。"
        };
      }
      return {
        models,
        supported: true,
        manualModelIdRequired: false,
        message: `发现 ${models.length} 个模型。`
      };
    } catch (error) {
      return {
        models: [],
        supported: false,
        manualModelIdRequired: true,
        message: `无法连接模型列表接口（${error instanceof Error ? error.message : "network"}）；请手动填写模型 ID。`
      };
    }
  }

  async listAudit(connectionId?: string, limit = 100): Promise<ConnectionAuditEntry[]> {
    const capped = Math.max(1, Math.min(limit, MAX_AUDIT_ENTRIES));
    let entries = this.audit.entries;
    if (connectionId) {
      entries = entries.filter((entry) => entry.connectionId === connectionId);
    }
    return entries.slice(0, capped);
  }

  async chatCompletion(connectionId: string, input: ChatCompletionInput): Promise<string> {
    const result = await this.chatCompletionDetailed(connectionId, input);
    return result.content;
  }

  /** Same as chatCompletion but returns provider usage when available. */
  async chatCompletionDetailed(connectionId: string, input: ChatCompletionInput): Promise<ChatCompletionResult> {
    if (input.signal?.aborted) throw new Error("Professional Agent request was interrupted.");
    const connection = await this.getMutable(connectionId);
    if (!connection.enabled) throw new Error("模型连接已停用。");
    const apiKey = await this.readCredential(connection);
    if (!apiKey && getProviderPreset(connection.presetId ?? "custom")?.requiresCredential !== false) {
      const result = {
        kind: "authentication_failed" as const,
        message: "未找到本机安全凭据，请重新保存 API Key。"
      };
      await this.reportUnavailable(connection, result, true);
      throw new Error(result.message);
    }
    const modelId = input.modelId?.trim() || connection.modelId;
    try {
      const headers = buildAuthHeaders(connection, apiKey);
      const response = await this.fetcher(`${connection.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId, messages: input.messages, temperature: 0 }),
        signal: input.signal
      });
      if (!response.ok) {
        const result = response.status === 401 || response.status === 403
          ? { kind: "authentication_failed" as const, message: "认证失败，请检查 API Key。" }
          : response.status === 404
            ? { kind: "model_unavailable" as const, message: "模型服务或模型 ID 不可用。" }
            : { kind: "network_failed" as const, message: `连接失败（HTTP ${response.status}）。` };
        await this.reportUnavailable(connection, result, true);
        throw new Error(result.message);
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
      let usage: ChatCompletionResult["usage"];
      if (payload.usage) {
        usage = {
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens
        };
        connection.lastUsage = {
          available: true,
          source: "last_completion",
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens,
          message: "Usage from last chat completion.",
          fetchedAt: new Date().toISOString()
        };
        await this.persist();
      }
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("模型未返回可执行的专业代理输出。");
      return { content, modelId, usage };
    } catch (error) {
      if (input.signal?.aborted) throw new Error("Professional Agent request was interrupted.");
      if (error instanceof Error && /认证失败|模型服务或模型 ID|连接失败|模型未返回/.test(error.message)) throw error;
      const result = { kind: "network_failed" as const, message: "网络失败，无法调用专业代理模型。" };
      await this.reportUnavailable(connection, result, true);
      throw new Error(result.message);
    }
  }

  private async finishTest(
    connection: ModelConnection,
    result: ConnectionTestResult,
    notifyOnUnavailable: boolean
  ): Promise<ConnectionTestResult> {
    connection.lastTest = result;
    connection.updatedAt = result.checkedAt ?? new Date().toISOString();
    await this.persist();
    await this.recordAudit({
      connectionId: connection.id,
      action: "test",
      summary: `${result.kind}: ${result.message}`
    });
    if (result.kind !== "success") {
      return this.reportUnavailable(connection, result, notifyOnUnavailable);
    }
    return result;
  }

  private async reportUnavailable(
    connection: ModelConnection,
    result: Exclude<ConnectionTestResult, { kind: "success" }>,
    notifyOnUnavailable: boolean
  ): Promise<ConnectionTestResult> {
    if (notifyOnUnavailable) await this.onUnavailable?.(connection.id, result.message);
    return result;
  }

  private async getMutable(connectionId: string): Promise<ModelConnection> {
    const connection = this.state.connections.find((entry) => entry.id === connectionId);
    if (!connection) throw new Error(`Connection ${connectionId} was not found.`);
    // Ensure optional fields exist in place.
    Object.assign(connection, normalizeConnection(connection));
    return connection;
  }

  private async readCredential(connection: ModelConnection): Promise<string | undefined> {
    const value = await this.vault.read(connection.credentialRef);
    if (!value) {
      if (connection.credentialPresent) {
        connection.credentialPresent = false;
        await this.persist();
      }
      return undefined;
    }
    return value;
  }

  private async loadAudit(): Promise<void> {
    try {
      const decoded = JSON.parse(await readFile(this.auditPath, "utf8")) as Partial<AuditState>;
      if (decoded.schemaVersion === 1 && Array.isArray(decoded.entries)) {
        this.audit = { schemaVersion: 1, entries: decoded.entries };
      }
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        this.audit = emptyAudit();
        return;
      }
      // Corrupt audit log should not block service start.
      this.audit = emptyAudit();
    }
  }

  private async recordAudit(entry: Omit<ConnectionAuditEntry, "id" | "at"> & { at?: string }): Promise<void> {
    const full: ConnectionAuditEntry = {
      id: randomUUID(),
      at: entry.at ?? new Date().toISOString(),
      connectionId: entry.connectionId,
      action: entry.action,
      summary: entry.summary,
      changes: entry.changes,
      revision: entry.revision
    };
    // Scrub any accidental secret-looking values from changes.
    if (full.changes) {
      full.changes = scrubAuditChanges(full.changes);
    }
    this.audit.entries.unshift(full);
    if (this.audit.entries.length > MAX_AUDIT_ENTRIES) {
      this.audit.entries = this.audit.entries.slice(0, MAX_AUDIT_ENTRIES);
    }
    try {
      await mkdir(dirname(this.auditPath), { recursive: true });
      const temporaryPath = `${this.auditPath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.audit, null, 2)}\n`, {
        encoding: "utf8",
        mode: constants.S_IRUSR | constants.S_IWUSR
      });
      await rename(temporaryPath, this.auditPath);
    } catch {
      // Audit persistence is best-effort.
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: constants.S_IRUSR | constants.S_IWUSR
    });
    await rename(temporaryPath, this.statePath);
  }
}

export function toPublicConnection(connection: ModelConnection): PublicConnection {
  const normalized = normalizeConnection(connection);
  return {
    id: normalized.id,
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    modelId: normalized.modelId,
    enabled: normalized.enabled,
    presetId: normalized.presetId ?? "custom",
    providerKind: normalized.providerKind ?? "openai_compatible",
    modelSource: normalized.modelSource ?? "manual",
    credentialPresent: normalized.credentialPresent === true,
    credentialUpdatedAt: normalized.credentialUpdatedAt,
    lastTest: normalized.lastTest,
    lastProbe: normalized.lastProbe,
    lastUsage: normalized.lastUsage,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt
  };
}

/** Stable, secret-free connection row for backup export / import equality. */
export function toBackupConnectionRow(connection: ModelConnection | Record<string, unknown>): ModelConnection {
  const normalized = normalizeConnection(connection);
  return {
    id: normalized.id,
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    modelId: normalized.modelId,
    enabled: normalized.enabled,
    credentialRef: normalized.credentialRef,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    presetId: normalized.presetId,
    providerKind: normalized.providerKind,
    modelSource: normalized.modelSource
  };
}

export function normalizeConnection(raw: ModelConnection | Record<string, unknown>): ModelConnection {
  const entry = raw as ModelConnection;
  const presetId = typeof entry.presetId === "string" && getProviderPreset(entry.presetId)
    ? entry.presetId
    : "custom";
  const preset = getProviderPreset(presetId);
  return {
    id: String(entry.id),
    name: String(entry.name ?? ""),
    baseUrl: String(entry.baseUrl ?? ""),
    modelId: String(entry.modelId ?? ""),
    enabled: entry.enabled !== false,
    credentialRef: String(entry.credentialRef ?? ""),
    createdAt: String(entry.createdAt ?? new Date(0).toISOString()),
    updatedAt: String(entry.updatedAt ?? new Date(0).toISOString()),
    presetId,
    providerKind: entry.providerKind && isKind(entry.providerKind) ? entry.providerKind : preset?.kind ?? "custom",
    modelSource: entry.modelSource === "discovered" ? "discovered" : "manual",
    // Legacy rows always stored a key; explicit false is used after backup restore / ollama without key.
    credentialPresent:
      typeof entry.credentialPresent === "boolean" ? entry.credentialPresent : true,
    credentialUpdatedAt: entry.credentialUpdatedAt,
    lastTest: entry.lastTest,
    lastProbe: entry.lastProbe,
    lastUsage: entry.lastUsage
  };
}

function isKind(value: string): value is ProviderKind {
  return ["openai", "openai_compatible", "azure_openai", "ollama", "custom"].includes(value);
}

function buildAuthHeaders(connection: ModelConnection, apiKey: string | undefined): Record<string, string> {
  const preset = getProviderPreset(connection.presetId ?? "custom");
  const style = preset?.authStyle ?? "bearer";
  if (!apiKey || style === "none") return {};
  if (style === "api_key_header") {
    return { "api-key": apiKey };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function withStamp(
  result: Omit<ConnectionTestResult, "checkedAt">,
  checkedAt: string
): ConnectionTestResult {
  return { ...result, checkedAt };
}

function scrubAuditChanges(
  changes: Record<string, { from?: unknown; to?: unknown }>
): Record<string, { from?: unknown; to?: unknown }> {
  const secretKey = /apiKey|password|secret|token|authorization|credential/i;
  const scrubbed: Record<string, { from?: unknown; to?: unknown }> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (secretKey.test(key)) {
      scrubbed[key] = {
        from: value.from !== undefined ? "[redacted]" : undefined,
        to: value.to !== undefined ? "[redacted]" : undefined
      };
      continue;
    }
    scrubbed[key] = {
      from: scrubValue(value.from),
      to: scrubValue(value.to)
    };
  }
  return scrubbed;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string" && /sk-[a-zA-Z0-9]{10,}|Bearer\s+\S+/i.test(value)) {
    return "[redacted]";
  }
  return value;
}

function defaultAuditPath(statePath: string): string {
  return join(dirname(statePath), "connections-audit.json");
}

/** Windows Credential Manager implementation; no secret is persisted in application data. */
export class WindowsCredentialVault implements CredentialVault {
  async read(reference: string): Promise<string | undefined> {
    const output = await runCredentialPowerShell("read", { PAW_CREDENTIAL_TARGET: reference });
    return output ? Buffer.from(output, "base64").toString("utf8") : undefined;
  }

  async write(reference: string, secret: string): Promise<void> {
    await runCredentialPowerShell("write", { PAW_CREDENTIAL_TARGET: reference }, secret);
  }

  async remove(reference: string): Promise<void> {
    await runCredentialPowerShell("remove", { PAW_CREDENTIAL_TARGET: reference });
  }
}

function runCredentialPowerShell(action: "read" | "write" | "remove", variables: NodeJS.ProcessEnv, secret?: string): Promise<string> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Windows Credential Manager is only available on Windows."));
  }
  const script = `${credentialInterop}\n$action = $env:PAW_CREDENTIAL_ACTION; if ($action -eq 'write') { [CredentialBridge]::Write($env:PAW_CREDENTIAL_TARGET, [Console]::In.ReadToEnd()) } elseif ($action -eq 'read') { $secret = [CredentialBridge]::Read($env:PAW_CREDENTIAL_TARGET); if ($null -ne $secret) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret))) } } else { [CredentialBridge]::Remove($env:PAW_CREDENTIAL_TARGET) }`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, ...variables, PAW_CREDENTIAL_ACTION: action },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin?.end(secret);
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || "Credential Manager operation failed.")));
  });
}

const credentialInterop = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CredentialBridge {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll", SetLastError = true)] static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("Advapi32.dll")] static extern void CredFree(IntPtr buffer);
  const UInt32 Generic = 1, LocalMachine = 2;
  public static void Write(string target, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    IntPtr blob = Marshal.AllocCoTaskMem(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL credential = new CREDENTIAL { Type = Generic, TargetName = target, CredentialBlobSize = (UInt32)bytes.Length, CredentialBlob = blob, Persist = LocalMachine, UserName = "PersonalAIWorkbench" };
      if (!CredWrite(ref credential, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeCoTaskMem(blob); }
  }
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, Generic, 0, out pointer)) return null;
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      byte[] bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      return Encoding.Unicode.GetString(bytes);
    } finally { CredFree(pointer); }
  }
  public static void Remove(string target) { CredDelete(target, Generic, 0); }
}
'@
`;
