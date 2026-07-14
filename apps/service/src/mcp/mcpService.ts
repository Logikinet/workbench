/**
 * MCP connection service: create/test/enable/disable, tool discovery,
 * per-tool role bindings, policy-enforced calls, secret-free backup snapshot.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createDefaultMcpClientFactory,
  McpClientUnavailableError,
  type McpClient,
  type McpClientFactory
} from "./mcpClient.js";
import {
  assertArgsWithinLimit,
  boundResult,
  checkToolPermissions,
  classifyToolRisk,
  normalizeCallError,
  redactForLog
} from "./mcpPolicy.js";
import {
  MCP_DEFAULT_TIMEOUT_MS,
  type CreateMcpConnectionInput,
  type McpCallContext,
  type McpConnection,
  type McpConnectionStateSnapshot,
  type McpTestResult,
  type McpToolCallResult,
  type McpToolDescriptor,
  type McpToolRef,
  type McpVaultSecrets,
  type PublicMcpConnection,
  type RoleMcpBinding,
  type UpdateMcpConnectionInput
} from "./mcpTypes.js";

/** Same vault shape as model connections — injectable (Memory / Windows Credential Manager). */
export interface CredentialVault {
  read(reference: string): Promise<string | undefined>;
  write(reference: string, secret: string): Promise<void>;
  remove(reference: string): Promise<void>;
}

export type McpUnavailableHandler = (connectionId: string, reason: string) => Promise<void> | void;

interface McpState {
  schemaVersion: 1;
  connections: McpConnection[];
  roleBindings: RoleMcpBinding[];
}

function emptyState(): McpState {
  return { schemaVersion: 1, connections: [], roleBindings: [] };
}

export interface McpServiceOptions {
  statePath: string;
  vault: CredentialVault;
  clientFactory?: McpClientFactory;
  onUnavailable?: McpUnavailableHandler;
  defaultTimeoutMs?: number;
}

export class McpService {
  private state: McpState = emptyState();
  private readonly clientFactory: McpClientFactory;
  private readonly defaultTimeoutMs: number;

  private constructor(
    private readonly statePath: string,
    state: McpState,
    private readonly vault: CredentialVault,
    clientFactory: McpClientFactory | undefined,
    private readonly onUnavailable?: McpUnavailableHandler,
    defaultTimeoutMs?: number
  ) {
    this.state = state;
    this.clientFactory = clientFactory ?? createDefaultMcpClientFactory();
    this.defaultTimeoutMs = defaultTimeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  }

  static async open(options: McpServiceOptions): Promise<McpService> {
    let state: McpState;
    try {
      const decoded = JSON.parse(await readFile(options.statePath, "utf8")) as Partial<McpState>;
      if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.connections)) {
        throw new Error("MCP state is not compatible with this service version.");
      }
      state = {
        schemaVersion: 1,
        connections: (decoded.connections as McpConnection[]).map(normalizeConnection),
        roleBindings: Array.isArray(decoded.roleBindings)
          ? (decoded.roleBindings as RoleMcpBinding[]).map(normalizeBinding)
          : []
      };
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        state = emptyState();
      } else {
        throw error;
      }
    }
    return new McpService(
      options.statePath,
      state,
      options.vault,
      options.clientFactory,
      options.onUnavailable,
      options.defaultTimeoutMs
    );
  }

  async list(): Promise<McpConnection[]> {
    return [...this.state.connections]
      .map(normalizeConnection)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listPublic(): Promise<PublicMcpConnection[]> {
    return (await this.list()).map(toPublicMcpConnection);
  }

  async get(connectionId: string): Promise<McpConnection> {
    const connection = this.state.connections.find((entry) => entry.id === connectionId);
    if (!connection) throw new Error(`MCP connection ${connectionId} was not found.`);
    return normalizeConnection(connection);
  }

  async getPublic(connectionId: string): Promise<PublicMcpConnection> {
    return toPublicMcpConnection(await this.get(connectionId));
  }

  async create(input: CreateMcpConnectionInput): Promise<McpConnection> {
    const name = requireNonEmpty(input.name, "name");
    const transport = input.transport;
    if (transport !== "stdio" && transport !== "http" && transport !== "fake") {
      throw new Error("MCP transport must be stdio, http, or fake.");
    }
    if (transport === "stdio" && !input.command?.trim()) {
      throw new Error("stdio MCP connections require a command.");
    }
    if (transport === "http" && !input.url?.trim()) {
      throw new Error("http MCP connections require a url.");
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const credentialRef = `PersonalAIWorkbench:mcp:${id}`;
    const connection: McpConnection = {
      id,
      name,
      transport,
      enabled: input.enabled !== false,
      command: input.command?.trim() || undefined,
      args: Array.isArray(input.args) ? input.args.map(String) : undefined,
      envKeys: input.env ? Object.keys(input.env).sort() : undefined,
      url: input.url?.trim() || undefined,
      credentialRef,
      credentialPresent: false,
      createdAt: now,
      updatedAt: now
    };

    const secrets = buildSecretsBlob({
      env: input.env,
      authToken: input.authToken,
      fakeServerId: input.fakeServerId
    });
    if (secrets) {
      await this.vault.write(credentialRef, JSON.stringify(secrets));
      connection.credentialPresent = true;
      connection.credentialUpdatedAt = now;
    }

    this.state.connections.push(connection);
    try {
      await this.persist();
    } catch (error) {
      this.state.connections = this.state.connections.filter((entry) => entry.id !== id);
      if (connection.credentialPresent) await this.vault.remove(credentialRef);
      throw error;
    }
    return normalizeConnection(connection);
  }

  async update(connectionId: string, input: UpdateMcpConnectionInput): Promise<McpConnection> {
    const connection = await this.getMutable(connectionId);
    const now = new Date().toISOString();

    if (input.name !== undefined) connection.name = requireNonEmpty(input.name, "name");
    if (input.enabled !== undefined) connection.enabled = input.enabled;
    if (input.command !== undefined) connection.command = input.command.trim() || undefined;
    if (input.args !== undefined) connection.args = input.args.map(String);
    if (input.url !== undefined) connection.url = input.url.trim() || undefined;

    if (input.clearSecrets) {
      await this.vault.remove(connection.credentialRef);
      connection.credentialPresent = false;
      connection.credentialUpdatedAt = undefined;
      connection.envKeys = undefined;
    } else if (input.env !== undefined || input.authToken !== undefined || input.fakeServerId !== undefined) {
      const existing = await this.readSecrets(connection);
      const next: McpVaultSecrets = {
        env: input.env !== undefined ? input.env : existing.env,
        authToken: input.authToken !== undefined ? input.authToken : existing.authToken,
        fakeServerId: input.fakeServerId !== undefined ? input.fakeServerId : existing.fakeServerId
      };
      // Empty auth token means leave previous unless explicitly clearing via empty env+token
      if (input.authToken === "") {
        delete next.authToken;
      }
      const blob = buildSecretsBlob(next);
      if (blob) {
        await this.vault.write(connection.credentialRef, JSON.stringify(blob));
        connection.credentialPresent = true;
        connection.credentialUpdatedAt = now;
      }
      if (input.env !== undefined) {
        connection.envKeys = Object.keys(input.env).sort();
      }
    }

    if (connection.transport === "stdio" && !connection.command) {
      throw new Error("stdio MCP connections require a command.");
    }
    if (connection.transport === "http" && !connection.url) {
      throw new Error("http MCP connections require a url.");
    }

    connection.updatedAt = now;
    await this.persist();
    return normalizeConnection(connection);
  }

  async remove(connectionId: string): Promise<void> {
    const connection = await this.get(connectionId);
    this.state.connections = this.state.connections.filter((entry) => entry.id !== connectionId);
    this.state.roleBindings = this.state.roleBindings.map((binding) => ({
      ...binding,
      tools: binding.tools.filter((tool) => tool.connectionId !== connectionId),
      updatedAt: new Date().toISOString()
    }));
    await this.persist();
    await this.vault.remove(connection.credentialRef).catch(() => undefined);
  }

  /**
   * Test connection: discover tools, store descriptors, report distinct failure kinds.
   * Does not throw for soft failures — returns McpTestResult.
   */
  async test(connectionId: string): Promise<McpTestResult> {
    const connection = await this.getMutable(connectionId);
    const checkedAt = new Date().toISOString();

    if (!connection.enabled) {
      const result: McpTestResult = {
        kind: "disabled",
        message: "MCP 连接已停用。",
        checkedAt
      };
      connection.lastTest = result;
      connection.updatedAt = checkedAt;
      await this.persist();
      return result;
    }

    let client: McpClient | undefined;
    try {
      client = await this.openClient(connection);
      const tools = await client.listTools();
      connection.tools = tools.map(normalizeTool);
      const result: McpTestResult = {
        kind: "success",
        message: `已发现 ${tools.length} 个 MCP 工具。`,
        checkedAt,
        toolCount: tools.length
      };
      connection.lastTest = result;
      connection.updatedAt = checkedAt;
      await this.persist();
      return result;
    } catch (error) {
      const result = classifyTestError(error, checkedAt);
      connection.lastTest = result;
      connection.updatedAt = checkedAt;
      await this.persist();
      if (result.kind === "server_unavailable" || result.kind === "network_failed" || result.kind === "authentication_failed") {
        await this.notifyUnavailable(connection.id, result.message);
      }
      return result;
    } finally {
      await client?.close?.().catch(() => undefined);
    }
  }

  /** List tools for a connection (cached after test, or live discover). */
  async listTools(connectionId: string, options?: { refresh?: boolean }): Promise<McpToolDescriptor[]> {
    const connection = await this.getMutable(connectionId);
    if (!options?.refresh && connection.tools && connection.tools.length > 0) {
      return connection.tools.map(normalizeTool);
    }
    if (!connection.enabled) {
      throw new Error("MCP 连接已停用，无法列出工具。");
    }
    let client: McpClient | undefined;
    try {
      client = await this.openClient(connection);
      const tools = (await client.listTools()).map(normalizeTool);
      connection.tools = tools;
      connection.updatedAt = new Date().toISOString();
      await this.persist();
      return tools;
    } catch (error) {
      const normalized = normalizeCallError(error);
      if (normalized.pauseRelatedSubtasks) {
        await this.notifyUnavailable(connection.id, normalized.message);
      }
      throw error instanceof Error ? error : new Error(normalized.message);
    } finally {
      await client?.close?.().catch(() => undefined);
    }
  }

  /**
   * Bind specific MCP tools to an Agent Role.
   * Whole-server exposure is never implied — empty tools list clears bindings.
   */
  async setRoleBindings(roleId: string, tools: McpToolRef[]): Promise<RoleMcpBinding> {
    const id = requireNonEmpty(roleId, "roleId");
    const normalizedTools = tools.map((tool) => ({
      connectionId: requireNonEmpty(tool.connectionId, "connectionId"),
      toolName: requireNonEmpty(tool.toolName, "toolName")
    }));

    // Validate connection ids exist
    for (const tool of normalizedTools) {
      await this.get(tool.connectionId);
    }

    const now = new Date().toISOString();
    const existing = this.state.roleBindings.find((entry) => entry.roleId === id);
    if (existing) {
      existing.tools = dedupeToolRefs(normalizedTools);
      existing.updatedAt = now;
      await this.persist();
      return structuredClone(existing);
    }
    const binding: RoleMcpBinding = {
      roleId: id,
      tools: dedupeToolRefs(normalizedTools),
      updatedAt: now
    };
    this.state.roleBindings.push(binding);
    await this.persist();
    return structuredClone(binding);
  }

  async getRoleBindings(roleId: string): Promise<RoleMcpBinding> {
    const binding = this.state.roleBindings.find((entry) => entry.roleId === roleId);
    if (!binding) {
      return { roleId, tools: [], updatedAt: new Date(0).toISOString() };
    }
    return structuredClone(binding);
  }

  async listRoleBindings(): Promise<RoleMcpBinding[]> {
    return this.state.roleBindings.map((entry) => structuredClone(entry));
  }

  /** Tools exposed to a role: intersection of bindings + currently discovered tools. */
  async listToolsForRole(roleId: string): Promise<Array<McpToolDescriptor & McpToolRef>> {
    const binding = await this.getRoleBindings(roleId);
    const out: Array<McpToolDescriptor & McpToolRef> = [];
    for (const ref of binding.tools) {
      try {
        const connection = await this.get(ref.connectionId);
        if (!connection.enabled) continue;
        const tool = connection.tools?.find((entry) => entry.name === ref.toolName);
        if (tool) {
          out.push({ ...normalizeTool(tool), connectionId: ref.connectionId, toolName: ref.toolName });
        } else {
          out.push({
            name: ref.toolName,
            description: "工具尚未发现或已从 Server 移除。",
            connectionId: ref.connectionId,
            toolName: ref.toolName
          });
        }
      } catch {
        // skip missing connections
      }
    }
    return out;
  }

  /**
   * Call an MCP tool with binding, permission, size, timeout, redaction, and soft-fail policy.
   * Never throws for server unavailability — returns ok:false with pauseRelatedSubtasks.
   */
  async callTool(
    connectionId: string,
    toolName: string,
    args: Record<string, unknown> = {},
    context: McpCallContext = {}
  ): Promise<McpToolCallResult> {
    const started = Date.now();
    const safeName = toolName?.trim() || "";
    if (!safeName) {
      return {
        ok: false,
        connectionId,
        toolName: safeName,
        kind: "invalid_args",
        message: "toolName is required.",
        pauseRelatedSubtasks: false,
        durationMs: 0
      };
    }

    let connection: McpConnection;
    try {
      connection = await this.get(connectionId);
    } catch {
      return {
        ok: false,
        connectionId,
        toolName: safeName,
        kind: "not_found",
        message: `MCP connection ${connectionId} was not found.`,
        pauseRelatedSubtasks: false,
        durationMs: Date.now() - started
      };
    }

    if (!connection.enabled) {
      return {
        ok: false,
        connectionId,
        toolName: safeName,
        kind: "disabled",
        message: "MCP 连接已停用。",
        pauseRelatedSubtasks: true,
        durationMs: Date.now() - started
      };
    }

    if (context.roleId) {
      const binding = await this.getRoleBindings(context.roleId);
      const allowed = binding.tools.some(
        (tool) => tool.connectionId === connectionId && tool.toolName === safeName
      );
      if (!allowed) {
        return {
          ok: false,
          connectionId,
          toolName: safeName,
          kind: "not_bound",
          message: "该 MCP 工具未绑定到当前 Agent Role；不会默认暴露整个 Server。",
          pauseRelatedSubtasks: false,
          durationMs: Date.now() - started
        };
      }
    }

    const toolMeta: McpToolDescriptor =
      connection.tools?.find((entry) => entry.name === safeName) ?? { name: safeName };
    const denial = checkToolPermissions(toolMeta, context.permissions, {
      approvedDangerous: context.approvedDangerous
    });
    if (denial) {
      return {
        ok: false,
        connectionId,
        toolName: safeName,
        kind: "permission_denied",
        message: denial,
        pauseRelatedSubtasks: false,
        durationMs: Date.now() - started
      };
    }

    try {
      assertArgsWithinLimit(args ?? {});
    } catch (error) {
      const normalized = normalizeCallError(error);
      return {
        ok: false,
        connectionId,
        toolName: safeName,
        kind: normalized.kind,
        message: normalized.message,
        pauseRelatedSubtasks: false,
        durationMs: Date.now() - started
      };
    }

    const timeoutMs = context.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (context.signal) {
      if (context.signal.aborted) {
        return {
          ok: false,
          connectionId,
          toolName: safeName,
          kind: "cancelled",
          message: "MCP 工具调用已取消。",
          pauseRelatedSubtasks: false,
          durationMs: Date.now() - started
        };
      }
      context.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let client: McpClient | undefined;
    try {
      client = await this.openClient(connection);
      const raw = await client.callTool(safeName, args ?? {}, { signal: controller.signal });
      if (raw.isError) {
        return {
          ok: false,
          connectionId,
          toolName: safeName,
          kind: "tool_error",
          message: String(redactForLog(raw.content) ?? "Tool returned an error."),
          pauseRelatedSubtasks: false,
          durationMs: Date.now() - started
        };
      }
      const bounded = boundResult(raw.content);
      if (bounded.truncated && bounded.resultBytes > 0) {
        // Still success with truncated payload (policy applied).
      }
      return {
        ok: true,
        connectionId,
        toolName: safeName,
        content: bounded.content,
        resultBytes: bounded.resultBytes,
        truncated: bounded.truncated,
        durationMs: Date.now() - started
      };
    } catch (error) {
      const isAbort =
        (error && typeof error === "object" && "name" in error && (error as Error).name === "AbortError") ||
        controller.signal.aborted;

      if (isAbort && context.signal?.aborted) {
        return {
          ok: false,
          connectionId,
          toolName: safeName,
          kind: "cancelled",
          message: "MCP 工具调用已取消。",
          pauseRelatedSubtasks: false,
          durationMs: Date.now() - started
        };
      }
      if (isAbort && !context.signal?.aborted) {
        return {
          ok: false,
          connectionId,
          toolName: safeName,
          kind: "timeout",
          message: `MCP 工具调用超时（${timeoutMs}ms）。`,
          pauseRelatedSubtasks: true,
          durationMs: Date.now() - started
        };
      }

      const normalized = normalizeCallError(error);
      if (normalized.pauseRelatedSubtasks) {
        await this.notifyUnavailable(connectionId, normalized.message);
      }
      return {
        ok: false,
        connectionId,
        toolName: safeName,
        kind: normalized.kind,
        message: normalized.message,
        pauseRelatedSubtasks: normalized.pauseRelatedSubtasks,
        durationMs: Date.now() - started
      };
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onExternalAbort);
      await client?.close?.().catch(() => undefined);
    }
  }

  /**
   * Durable snapshot for ordinary backup export.
   * Never reads secret values from the vault — only opaque credentialRef + env key names.
   */
  async exportSnapshot(): Promise<McpConnectionStateSnapshot> {
    return {
      schemaVersion: 1,
      secretsExcluded: true,
      connections: this.state.connections.map((entry) => toBackupConnectionRow(entry)),
      roleBindings: this.state.roleBindings.map((entry) => structuredClone(entry))
    };
  }

  /**
   * Restore index from backup. Does not write vault secrets;
   * users must re-enter env/auth after restore.
   */
  async importSnapshot(snapshot: McpConnectionStateSnapshot): Promise<void> {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.connections)) {
      throw new Error("MCP backup snapshot is not compatible with this service version.");
    }
    this.state = {
      schemaVersion: 1,
      connections: snapshot.connections.map((entry) =>
        normalizeConnection({
          ...toBackupConnectionRow(entry),
          credentialPresent: false,
          credentialUpdatedAt: undefined,
          lastTest: undefined
        })
      ),
      roleBindings: Array.isArray(snapshot.roleBindings)
        ? snapshot.roleBindings.map(normalizeBinding)
        : []
    };
    await this.persist();
  }

  private async openClient(connection: McpConnection): Promise<McpClient> {
    const secrets = await this.readSecrets(connection);
    return this.clientFactory(connection, secrets);
  }

  private async readSecrets(connection: McpConnection): Promise<McpVaultSecrets> {
    const raw = await this.vault.read(connection.credentialRef);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as McpVaultSecrets;
      return {
        authToken: typeof parsed.authToken === "string" ? parsed.authToken : undefined,
        env:
          parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)
            ? (parsed.env as Record<string, string>)
            : undefined,
        fakeServerId: typeof parsed.fakeServerId === "string" ? parsed.fakeServerId : undefined
      };
    } catch {
      // Legacy plain token
      return { authToken: raw };
    }
  }

  private async getMutable(connectionId: string): Promise<McpConnection> {
    const connection = this.state.connections.find((entry) => entry.id === connectionId);
    if (!connection) throw new Error(`MCP connection ${connectionId} was not found.`);
    return connection;
  }

  private async notifyUnavailable(connectionId: string, reason: string): Promise<void> {
    try {
      await this.onUnavailable?.(connectionId, reason);
    } catch {
      // Unavailability handlers must never crash the workbench.
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${randomUUID()}.tmp`;
    // Persist without secret material — only credentialPresent flags and env key names.
    const durable: McpState = {
      schemaVersion: 1,
      connections: this.state.connections.map((entry) => toDurableConnection(entry)),
      roleBindings: this.state.roleBindings.map((entry) => structuredClone(entry))
    };
    const json = `${JSON.stringify(durable, null, 2)}\n`;
    assertNoSecretsInJson(json);
    await writeFile(tempPath, json, "utf8");
    await rename(tempPath, this.statePath);
  }
}

export function toPublicMcpConnection(connection: McpConnection): PublicMcpConnection {
  return {
    id: connection.id,
    name: connection.name,
    transport: connection.transport,
    enabled: connection.enabled,
    command: connection.command,
    args: connection.args ? [...connection.args] : undefined,
    envKeys: connection.envKeys ? [...connection.envKeys] : undefined,
    url: connection.url,
    credentialPresent: connection.credentialPresent === true,
    credentialUpdatedAt: connection.credentialUpdatedAt,
    tools: connection.tools?.map(normalizeTool),
    lastTest: connection.lastTest ? { ...connection.lastTest } : undefined,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

function toDurableConnection(connection: McpConnection): McpConnection {
  return {
    id: connection.id,
    name: connection.name,
    transport: connection.transport,
    enabled: connection.enabled,
    command: connection.command,
    args: connection.args ? [...connection.args] : undefined,
    envKeys: connection.envKeys ? [...connection.envKeys] : undefined,
    url: connection.url,
    credentialRef: connection.credentialRef,
    credentialPresent: connection.credentialPresent === true,
    credentialUpdatedAt: connection.credentialUpdatedAt,
    tools: connection.tools?.map(normalizeTool),
    lastTest: connection.lastTest ? { ...connection.lastTest } : undefined,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

function toBackupConnectionRow(connection: McpConnection): McpConnection {
  return {
    id: connection.id,
    name: connection.name,
    transport: connection.transport,
    enabled: connection.enabled,
    command: connection.command,
    args: connection.args ? [...connection.args] : undefined,
    envKeys: connection.envKeys ? [...connection.envKeys] : undefined,
    url: connection.url,
    credentialRef: connection.credentialRef,
    credentialPresent: false,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    tools: connection.tools?.map(normalizeTool)
    // lastTest / credentialUpdatedAt omitted for stable backup rows
  };
}

function normalizeConnection(entry: McpConnection): McpConnection {
  return {
    id: entry.id,
    name: entry.name,
    transport: entry.transport,
    enabled: entry.enabled !== false,
    command: entry.command,
    args: entry.args ? [...entry.args] : undefined,
    envKeys: entry.envKeys ? [...entry.envKeys] : undefined,
    url: entry.url,
    credentialRef: entry.credentialRef,
    credentialPresent: entry.credentialPresent === true,
    credentialUpdatedAt: entry.credentialUpdatedAt,
    tools: entry.tools?.map(normalizeTool),
    lastTest: entry.lastTest ? { ...entry.lastTest } : undefined,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

function normalizeBinding(entry: RoleMcpBinding): RoleMcpBinding {
  return {
    roleId: entry.roleId,
    tools: dedupeToolRefs(
      (entry.tools ?? []).map((tool) => ({
        connectionId: tool.connectionId,
        toolName: tool.toolName
      }))
    ),
    updatedAt: entry.updatedAt
  };
}

function normalizeTool(tool: McpToolDescriptor): McpToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ? structuredClone(tool.inputSchema) : undefined,
    risk: tool.risk ?? classifyToolRisk(tool)
  };
}

function dedupeToolRefs(tools: McpToolRef[]): McpToolRef[] {
  const seen = new Set<string>();
  const out: McpToolRef[] = [];
  for (const tool of tools) {
    const key = `${tool.connectionId}::${tool.toolName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ connectionId: tool.connectionId, toolName: tool.toolName });
  }
  return out;
}

function buildSecretsBlob(input: McpVaultSecrets): McpVaultSecrets | undefined {
  const blob: McpVaultSecrets = {};
  if (input.authToken && input.authToken.trim()) blob.authToken = input.authToken.trim();
  if (input.env && Object.keys(input.env).length > 0) blob.env = { ...input.env };
  if (input.fakeServerId && input.fakeServerId.trim()) blob.fakeServerId = input.fakeServerId.trim();
  return Object.keys(blob).length > 0 ? blob : undefined;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed;
}

function classifyTestError(error: unknown, checkedAt: string): McpTestResult {
  if (error instanceof McpClientUnavailableError) {
    if (error.kind === "authentication_failed") {
      return { kind: "authentication_failed", message: error.message, checkedAt };
    }
    if (error.kind === "network_failed") {
      return { kind: "network_failed", message: error.message, checkedAt };
    }
    return { kind: "server_unavailable", message: error.message, checkedAt };
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("unauthorized") || lower.includes("401") || lower.includes("403") || lower.includes("authentication")) {
    return { kind: "authentication_failed", message, checkedAt };
  }
  if (lower.includes("econnrefused") || lower.includes("network") || lower.includes("enotfound") || lower.includes("socket")) {
    return { kind: "network_failed", message, checkedAt };
  }
  return { kind: "server_unavailable", message, checkedAt };
}

/** Guard persisted JSON against accidental secret material. */
function assertNoSecretsInJson(json: string): void {
  if (/"authToken"\s*:\s*"[^"]+"/i.test(json) && !/"authToken"\s*:\s*"\[REDACTED\]"/i.test(json)) {
    // vault blob should never be in state file; public field names alone are ok if empty
  }
  // Reject obvious env value maps in state (we only store envKeys arrays)
  if (/"env"\s*:\s*\{/.test(json)) {
    throw new Error("Refusing to persist MCP env secret map into state file.");
  }
  if (/"apiKey"\s*:\s*"/i.test(json) || /"password"\s*:\s*"/i.test(json)) {
    throw new Error("Refusing to persist secret-like keys into MCP state file.");
  }
}

export { classifyToolRisk };
