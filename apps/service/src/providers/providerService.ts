/**
 * Provider Service facade (task 05).
 * Persists via ConnectionService + CredentialVault; never stores raw secrets in JSON.
 */

import { randomUUID } from "node:crypto";
import type { ConnectionService, CredentialVault, ModelConnection } from "../connections/connectionService.js";
import { getProviderAdapter } from "./providerAdapters.js";
import { PROVIDER_CLI_PRESETS } from "./providerCatalog.js";
import {
  encodeOAuthSecret,
  isOAuthProviderSupported,
  listSupportedOAuthProviders,
  resolveAccessTokenFromVaultSecret,
  tryParseOAuthSecret
} from "./oauthCredentials.js";
import type {
  CreateProviderInput,
  ProviderConnection,
  ProviderModel,
  ProviderStatus,
  ProviderTestResult,
  UpdateProviderInput
} from "./providerTypes.js";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProviderServiceOptions {
  connections: ConnectionService;
  vault: CredentialVault;
  fetchImpl?: Fetcher;
  now?: () => Date;
}

interface ProviderMetaFile {
  schemaVersion: 1;
  /** Extra fields not on ModelConnection. */
  byId: Record<
    string,
    {
      adapter: ProviderConnection["adapter"];
      providerType: ProviderConnection["providerType"];
      authMode: ProviderConnection["authMode"];
      apiProtocol: string;
      credentialEnvVar?: string;
      /** pi-ai OAuth provider id when authMode=oauth */
      oauthProviderId?: string;
      status: ProviderStatus;
      lastTestMessage?: string;
    }
  >;
  models: ProviderModel[];
}

export class ProviderService {
  private readonly fetchImpl: Fetcher;
  private readonly now: () => Date;
  private meta: ProviderMetaFile = { schemaVersion: 1, byId: {}, models: [] };
  private metaPath: string | undefined;

  constructor(private readonly options: ProviderServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  /** Optional durable meta alongside connections.json */
  async attachMetaPath(metaPath: string): Promise<void> {
    this.metaPath = metaPath;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = JSON.parse(await readFile(metaPath, "utf8")) as ProviderMetaFile;
      if (raw.schemaVersion === 1) this.meta = raw;
    } catch {
      /* empty */
    }
  }

  listPresets() {
    return PROVIDER_CLI_PRESETS.map((p) => ({ ...p }));
  }

  async list(): Promise<ProviderConnection[]> {
    const rows = await this.options.connections.listPublic();
    return rows.map((row) => this.toProvider(row as unknown as ModelConnection & { credentialPresent: boolean }));
  }

  async get(id: string): Promise<ProviderConnection> {
    const row = await this.options.connections.getPublic(id);
    return this.toProvider(row as unknown as ModelConnection & { credentialPresent: boolean });
  }

  async create(input: CreateProviderInput): Promise<ProviderConnection> {
    const name = required(input.name, "name");
    const adapter = input.adapter;
    const authMode = input.authMode;
    const hasKey = Boolean(input.apiKey?.trim());
    if (authMode === "api-key" && !hasKey && !input.allowDeferredCredential && adapter !== "ollama") {
      throw new Error("API Key is required for authMode=api-key.");
    }
    if (authMode === "environment" && !input.credentialEnvVar?.trim()) {
      throw new Error("credentialEnvVar is required for authMode=environment.");
    }

    const baseUrl =
      input.baseUrl?.trim() ||
      PROVIDER_CLI_PRESETS.find((p) => p.adapter === adapter)?.defaultBaseUrl ||
      "";

    const explicitModels = (input.models ?? [])
      .map((m) => ({
        remoteModelId: m.remoteModelId?.trim() ?? "",
        displayName: m.displayName?.trim(),
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        supportsReasoning: m.supportsReasoning === true
      }))
      .filter((m) => m.remoteModelId);

    const defaultModelId =
      input.defaultModelId?.trim() || explicitModels[0]?.remoteModelId || "default";

    // ConnectionService presets may require vault key — use custom/ollama when no vault secret yet
    // (deferred api-key, environment, oauth). Environment secrets resolve at runtime via env var.
    const needsVaultBypass =
      !hasKey && (authMode === "api-key" || authMode === "environment" || authMode === "oauth");
    const resolvedPresetId =
      adapter === "ollama"
        ? "ollama"
        : needsVaultBypass
          ? "custom"
          : adapter === "openai-compatible"
            ? "openai_compatible"
            : "custom";

    const connection = await this.options.connections.create({
      name,
      baseUrl: baseUrl || "http://127.0.0.1",
      modelId: defaultModelId,
      apiKey: authMode === "api-key" && hasKey ? input.apiKey : undefined,
      enabled: input.enabled !== false,
      presetId: resolvedPresetId,
      providerKind: mapAdapterToKind(adapter),
      modelSource: "manual"
    });

    this.meta.byId[connection.id] = {
      adapter,
      providerType:
        input.providerType ??
        (adapter === "ollama"
          ? "local"
          : input.providerType === "custom" || !PROVIDER_CLI_PRESETS.find((p) => p.defaultBaseUrl === baseUrl)
            ? adapter === "openai-compatible" && !baseUrl.includes("api.openai.com")
              ? "custom"
              : "builtin"
            : "builtin"),
      authMode: authMode === "api-key" && !hasKey ? "api-key" : authMode,
      apiProtocol: input.apiProtocol?.trim() || defaultProtocol(adapter),
      credentialEnvVar: input.credentialEnvVar?.trim(),
      status:
        hasKey || authMode === "none" || authMode === "environment"
          ? "unknown"
          : authMode === "oauth" || (authMode === "api-key" && !hasKey)
            ? "missing_credentials"
            : "unknown"
    };
    await this.persistMeta();

    // Register explicit models (todos multi-model flow)
    if (explicitModels.length > 0) {
      this.meta.models = [
        ...this.meta.models.filter((m) => m.providerConnectionId !== connection.id),
        ...explicitModels.map((m) => ({
          id: randomUUID(),
          providerConnectionId: connection.id,
          remoteModelId: m.remoteModelId,
          displayName: m.displayName || m.remoteModelId,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          supportsReasoning: m.supportsReasoning,
          supportedThinkingLevels: [] as string[],
          enabled: true
        }))
      ];
      await this.persistMeta();
    }

    if (input.discoverModels === true || (input.discoverModels !== false && explicitModels.length === 0 && hasKey)) {
      try {
        await this.discoverModels(connection.id);
      } catch {
        /* discovery optional on create */
      }
    }

    // Only auto-test when we have a way to authenticate (or none)
    if (hasKey || authMode === "none" || authMode === "environment") {
      const test = await this.test(connection.id);
      this.meta.byId[connection.id]!.status = test.status;
      this.meta.byId[connection.id]!.lastTestMessage = test.detail
        ? `${test.message}${test.message.includes(test.detail) ? "" : ` — ${test.detail.slice(0, 200)}`}`
        : test.message;
      await this.persistMeta();
    }
    return this.get(connection.id);
  }

  /** List providers with attached model registry (for CLI table). */
  async listDetailed(): Promise<
    Array<ProviderConnection & { models: ProviderModel[]; type: string; authLabel: string }>
  > {
    const rows = await this.list();
    return rows.map((p) => {
      const models = this.meta.models.filter((m) => m.providerConnectionId === p.id);
      return {
        ...p,
        models,
        type: p.providerType,
        authLabel: p.credentialConfigured || p.authMode === "none" || p.authMode === "environment" ? "ok" : "-"
      };
    });
  }

  async update(id: string, input: UpdateProviderInput): Promise<ProviderConnection> {
    await this.options.connections.update(id, {
      name: input.name,
      baseUrl: input.baseUrl,
      modelId: input.defaultModelId,
      apiKey: input.apiKey,
      enabled: input.enabled
    });
    const meta = this.meta.byId[id] ?? {
      adapter: "openai-compatible" as const,
      providerType: "custom" as const,
      authMode: "api-key" as const,
      apiProtocol: "openai-compatible",
      status: "unknown" as ProviderStatus
    };
    if (input.authMode) meta.authMode = input.authMode;
    if (input.credentialEnvVar !== undefined) meta.credentialEnvVar = input.credentialEnvVar.trim() || undefined;
    if (input.status) meta.status = input.status;
    this.meta.byId[id] = meta;
    await this.persistMeta();
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.options.connections.remove(id);
    delete this.meta.byId[id];
    this.meta.models = this.meta.models.filter((m) => m.providerConnectionId !== id);
    await this.persistMeta();
  }

  async setCredential(id: string, apiKey: string): Promise<ProviderConnection> {
    if (!apiKey.trim()) throw new Error("API Key must not be empty.");
    await this.options.connections.update(id, { apiKey: apiKey.trim() });
    const meta = this.meta.byId[id];
    if (meta) {
      meta.authMode = "api-key";
      meta.status = "unknown";
    }
    await this.persistMeta();
    return this.get(id);
  }

  async clearCredential(id: string): Promise<ProviderConnection> {
    const connection = await this.options.connections.get(id);
    if (connection.credentialRef) {
      await this.options.vault.remove(connection.credentialRef);
    }
    // Force missing flag via empty key path if supported — re-read
    const meta = this.meta.byId[id];
    if (meta) {
      meta.status = "missing_credentials";
      // Keep oauthProviderId so re-login knows which flow to use
    }
    await this.persistMeta();
    // Touch update without secret
    await this.options.connections.update(id, { enabled: connection.enabled });
    return this.get(id);
  }

  async test(id: string): Promise<ProviderTestResult> {
    const provider = await this.get(id);
    const adapter = getProviderAdapter(provider.adapter);
    const credential = await this.resolveCredentialById(id, provider);
    const result = await adapter.testConnection(provider, credential ?? undefined, this.fetchImpl);
    // release credential reference
    const meta = this.meta.byId[id] ?? {
      adapter: provider.adapter,
      providerType: provider.providerType,
      authMode: provider.authMode,
      apiProtocol: provider.apiProtocol,
      status: result.status
    };
    meta.status = result.status;
    meta.lastTestMessage = result.message;
    this.meta.byId[id] = meta;
    await this.persistMeta();
    // Also update connection lastTest for existing UI
    try {
      await this.options.connections.test(id);
    } catch {
      /* optional */
    }
    return result;
  }

  async discoverModels(id: string): Promise<ProviderModel[]> {
    const provider = await this.get(id);
    const adapter = getProviderAdapter(provider.adapter);
    const credential = await this.resolveCredentialById(id, provider);
    try {
      const models = await adapter.discoverModels(provider, credential ?? undefined, this.fetchImpl);
      this.meta.models = [
        ...this.meta.models.filter((m) => m.providerConnectionId !== id),
        ...models
      ];
      await this.persistMeta();
      return models;
    } finally {
      // credential goes out of scope
    }
  }

  async listModels(id: string): Promise<ProviderModel[]> {
    await this.get(id);
    return this.meta.models.filter((m) => m.providerConnectionId === id);
  }

  async addModel(
    id: string,
    input: { remoteModelId: string; displayName?: string; contextWindow?: number; supportsReasoning?: boolean }
  ): Promise<ProviderModel> {
    await this.get(id);
    const remoteModelId = required(input.remoteModelId, "remoteModelId");
    const model: ProviderModel = {
      id: randomUUID(),
      providerConnectionId: id,
      remoteModelId,
      displayName: input.displayName?.trim() || remoteModelId,
      contextWindow: input.contextWindow,
      supportsReasoning: input.supportsReasoning === true,
      supportedThinkingLevels: [],
      enabled: true
    };
    this.meta.models.push(model);
    await this.persistMeta();
    return model;
  }

  /**
   * Describe how to complete OAuth for this provider.
   * Interactive browser/device-code login runs in the CLI (pi-ai), then
   * POST /oauth/complete stores tokens in the vault.
   */
  async startOAuth(id: string): Promise<{
    flowId: string;
    mode: "cli-interactive";
    providerId: string;
    oauthProviderId?: string;
    supportedOAuthProviders: Array<{ id: string; name: string }>;
    message: string;
  }> {
    const provider = await this.get(id);
    const oauthProviderId =
      this.meta.byId[id]?.oauthProviderId ||
      inferOAuthProviderId(provider.name, provider.baseUrl);
    const supported = listSupportedOAuthProviders();
    const supportedIds = supported.map((p) => p.id).join(", ");

    if (oauthProviderId && !isOAuthProviderSupported(oauthProviderId)) {
      return {
        flowId: randomUUID(),
        mode: "cli-interactive",
        providerId: id,
        oauthProviderId,
        supportedOAuthProviders: supported,
        message: `OAuth provider '${oauthProviderId}' is not supported. Use: ${supportedIds}. Or switch to API key.`
      };
    }

    return {
      flowId: randomUUID(),
      mode: "cli-interactive",
      providerId: id,
      oauthProviderId: oauthProviderId || undefined,
      supportedOAuthProviders: supported,
      message: oauthProviderId
        ? `Run interactive OAuth in CLI for '${oauthProviderId}', then POST tokens to /api/providers/${id}/oauth/complete.`
        : `Supported subscription OAuth: ${supportedIds}. CLI will run browser/device-code login, then call /oauth/complete.`
    };
  }

  /**
   * Persist OAuth tokens from CLI login into the vault.
   * Public response never echoes tokens.
   */
  async completeOAuth(
    id: string,
    input: { oauthProviderId: string; credentials: OAuthCredentials }
  ): Promise<ProviderConnection> {
    await this.get(id);
    const oauthProviderId = input.oauthProviderId?.trim();
    if (!oauthProviderId) throw new Error("oauthProviderId is required.");
    if (!isOAuthProviderSupported(oauthProviderId)) {
      throw new Error(
        `Unsupported OAuth provider '${oauthProviderId}'. Supported: ${listSupportedOAuthProviders()
          .map((p) => p.id)
          .join(", ")}.`
      );
    }
    const creds = input.credentials;
    if (!creds?.access || !creds?.refresh || typeof creds.expires !== "number") {
      throw new Error("OAuth credentials must include access, refresh, and expires.");
    }

    const secret = encodeOAuthSecret(oauthProviderId, creds);
    await this.options.connections.update(id, { apiKey: secret });

    const meta = this.meta.byId[id] ?? {
      adapter: "openai-compatible" as const,
      providerType: "builtin" as const,
      authMode: "oauth" as const,
      apiProtocol: "openai-compatible",
      status: "unknown" as ProviderStatus
    };
    meta.authMode = "oauth";
    meta.oauthProviderId = oauthProviderId;
    meta.status = "unknown";
    meta.lastTestMessage = `OAuth login completed for ${oauthProviderId}.`;
    this.meta.byId[id] = meta;
    await this.persistMeta();

    // Optional connectivity test (best-effort)
    try {
      const test = await this.test(id);
      meta.status = test.status;
      meta.lastTestMessage = test.message;
      this.meta.byId[id] = meta;
      await this.persistMeta();
    } catch {
      /* test optional */
    }
    return this.get(id);
  }

  async logout(id: string): Promise<ProviderConnection> {
    return this.clearCredential(id);
  }

  /**
   * Temporary runtime credential — never attach to returned ProviderConnection.
   * Prefer loading vault ref from private ConnectionService record (public DTO omits credentialRef).
   * OAuth: refresh expired tokens via pi-ai and write back to vault when rotated.
   */
  private async resolveCredentialById(
    id: string,
    provider: ProviderConnection
  ): Promise<string | null> {
    if (provider.authMode === "none") return null;
    if (provider.authMode === "environment") {
      const name = provider.credentialEnvVar?.trim();
      if (!name) return null;
      return process.env[name] ?? null;
    }
    try {
      const privateRow = await this.options.connections.get(id);
      if (!privateRow.credentialRef) return null;
      const raw = (await this.options.vault.read(privateRow.credentialRef)) ?? null;
      if (!raw) return null;

      if (provider.authMode === "oauth" || tryParseOAuthSecret(raw)) {
        const resolved = await resolveAccessTokenFromVaultSecret(raw);
        if (resolved.updatedSecret) {
          // Persist rotated tokens without changing public metadata unnecessarily
          await this.options.vault.write(privateRow.credentialRef, resolved.updatedSecret);
        }
        return resolved.token;
      }
      return raw;
    } catch {
      return null;
    }
  }

  private toProvider(row: {
    id: string;
    name: string;
    baseUrl: string;
    modelId: string;
    enabled: boolean;
    credentialPresent?: boolean;
    providerKind?: string;
    lastTest?: { kind?: string; message?: string; checkedAt?: string };
    createdAt: string;
    updatedAt: string;
  }): ProviderConnection {
    const meta = this.meta.byId[row.id];
    const adapter = meta?.adapter ?? mapKindToAdapter(row.providerKind);
    const authMode =
      meta?.authMode ??
      (row.credentialPresent ? "api-key" : row.providerKind === "ollama" ? "none" : "api-key");
    return {
      id: row.id,
      name: row.name,
      providerType:
        meta?.providerType ??
        (row.providerKind === "ollama" ? "local" : row.providerKind === "custom" ? "custom" : "builtin"),
      adapter,
      baseUrl: row.baseUrl,
      apiProtocol: meta?.apiProtocol ?? defaultProtocol(adapter),
      authMode,
      // Never expose vault ref on public provider DTOs
      credentialConfigured: Boolean(row.credentialPresent),
      credentialEnvVar: meta?.credentialEnvVar,
      enabled: row.enabled,
      status: meta?.status ?? mapTestToStatus(row.lastTest?.kind),
      defaultModelId: row.modelId,
      lastTestedAt: row.lastTest?.checkedAt,
      lastTestMessage: meta?.lastTestMessage ?? row.lastTest?.message,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  private async persistMeta(): Promise<void> {
    if (!this.metaPath) return;
    const { mkdir, writeFile, rename } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(this.metaPath), { recursive: true });
    const tmp = `${this.metaPath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.meta, null, 2), "utf8");
    await rename(tmp, this.metaPath);
  }
}

function required(value: string | undefined, field: string): string {
  const t = value?.trim() ?? "";
  if (!t) throw new Error(`${field} is required.`);
  return t;
}

/** Best-effort map of connection name/url → pi-ai OAuth provider id. */
function inferOAuthProviderId(name: string, baseUrl?: string): string | undefined {
  const n = name.toLowerCase();
  const u = (baseUrl ?? "").toLowerCase();
  if (n.includes("anthropic") || n.includes("claude") || u.includes("anthropic") || u.includes("claude.ai")) {
    return "anthropic";
  }
  if (n.includes("codex") || n.includes("chatgpt") || u.includes("chatgpt.com")) {
    return "openai-codex";
  }
  if (n.includes("copilot") || n.includes("github") || u.includes("githubcopilot")) {
    return "github-copilot";
  }
  if (n.includes("radius")) return "radius";
  if (isOAuthProviderSupported(n)) return n;
  return undefined;
}

function defaultProtocol(adapter: ProviderConnection["adapter"]): string {
  if (adapter === "anthropic") return "anthropic-messages";
  if (adapter === "gemini") return "gemini";
  return "openai-compatible";
}

function mapAdapterToKind(adapter: ProviderConnection["adapter"]): string {
  if (adapter === "ollama") return "ollama";
  if (adapter === "openai-compatible") return "openai_compatible";
  return "custom";
}

function mapKindToAdapter(kind?: string): ProviderConnection["adapter"] {
  if (kind === "ollama") return "ollama";
  if (kind === "openai" || kind === "openai_compatible" || kind === "azure_openai") return "openai-compatible";
  return "openai-compatible";
}

function mapTestToStatus(kind?: string): ProviderStatus {
  if (kind === "success") return "ready";
  if (kind === "authentication_failed") return "auth_failed";
  if (kind === "network_failed") return "unreachable";
  if (kind === "model_unavailable") return "model_not_found";
  return "unknown";
}
