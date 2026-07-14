import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

export interface CredentialVault {
  read(reference: string): Promise<string | undefined>;
  write(reference: string, secret: string): Promise<void>;
  remove(reference: string): Promise<void>;
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
}

export interface CreateConnectionInput {
  name?: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  enabled?: boolean;
}

export interface UpdateConnectionInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  enabled?: boolean;
}

export type ConnectionTestResult =
  | { kind: "success"; message: string }
  | { kind: "authentication_failed"; message: string }
  | { kind: "network_failed"; message: string }
  | { kind: "model_unavailable"; message: string };

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

function emptyState(): ConnectionState {
  return { schemaVersion: 1, connections: [] };
}

export class ConnectionService {
  private constructor(
    private readonly statePath: string,
    private state: ConnectionState,
    private readonly vault: CredentialVault,
    private readonly fetcher: ConnectionFetcher,
    private readonly onUnavailable?: ConnectionFailureHandler
  ) {}

  static async open(
    statePath: string,
    vault: CredentialVault,
    fetcher: ConnectionFetcher = fetch,
    onUnavailable?: ConnectionFailureHandler
  ): Promise<ConnectionService> {
    try {
      const decoded = JSON.parse(await readFile(statePath, "utf8")) as Partial<ConnectionState>;
      if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.connections)) {
        throw new Error("Connection state is not compatible with this service version.");
      }
      return new ConnectionService(statePath, decoded as ConnectionState, vault, fetcher, onUnavailable);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return new ConnectionService(statePath, emptyState(), vault, fetcher, onUnavailable);
      }
      throw error;
    }
  }

  async list(): Promise<ModelConnection[]> {
    return [...this.state.connections].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(connectionId: string): Promise<ModelConnection> {
    const connection = this.state.connections.find((entry) => entry.id === connectionId);
    if (!connection) throw new Error(`Connection ${connectionId} was not found.`);
    return connection;
  }

  /**
   * Durable connection index for backup export.
   * Never reads the credential vault — only opaque credentialRef placeholders are returned.
   */
  async exportSnapshot(): Promise<ConnectionStateSnapshot> {
    return {
      schemaVersion: 1,
      connections: structuredClone(this.state.connections)
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
      connections: structuredClone(snapshot.connections)
    };
    await this.persist();
  }

  async create(input: CreateConnectionInput): Promise<ModelConnection> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const modelId = required(input.modelId, "A model ID is required.");
    const apiKey = required(input.apiKey, "An API Key is required.");
    const id = randomUUID();
    const now = new Date().toISOString();
    const connection: ModelConnection = {
      id,
      name: input.name?.trim() || modelId,
      baseUrl,
      modelId,
      enabled: input.enabled ?? true,
      credentialRef: `PersonalAIWorkbench:connection:${id}`,
      createdAt: now,
      updatedAt: now
    };
    await this.vault.write(connection.credentialRef, apiKey);
    this.state.connections.push(connection);
    try {
      await this.persist();
    } catch (error) {
      this.state.connections = this.state.connections.filter((entry) => entry.id !== connection.id);
      await this.vault.remove(connection.credentialRef);
      throw error;
    }
    return connection;
  }

  async update(connectionId: string, input: UpdateConnectionInput): Promise<ModelConnection> {
    const connection = await this.get(connectionId);
    const snapshot = { ...connection };
    const next = {
      name: input.name !== undefined ? required(input.name, "A connection name is required.") : connection.name,
      baseUrl: input.baseUrl !== undefined ? normalizeBaseUrl(input.baseUrl) : connection.baseUrl,
      modelId: input.modelId !== undefined ? required(input.modelId, "A model ID is required.") : connection.modelId,
      enabled: input.enabled ?? connection.enabled
    };
    const replacementSecret = input.apiKey !== undefined ? required(input.apiKey, "An API Key is required.") : undefined;
    const previousSecret = replacementSecret !== undefined ? await this.vault.read(connection.credentialRef) : undefined;
    if (replacementSecret !== undefined) await this.vault.write(connection.credentialRef, replacementSecret);
    Object.assign(connection, next);
    connection.updatedAt = new Date().toISOString();
    try {
      await this.persist();
    } catch (error) {
      Object.assign(connection, snapshot);
      if (replacementSecret !== undefined) {
        if (previousSecret !== undefined) await this.vault.write(connection.credentialRef, previousSecret);
        else await this.vault.remove(connection.credentialRef);
      }
      throw error;
    }
    return connection;
  }

  async remove(connectionId: string): Promise<void> {
    const connection = await this.get(connectionId);
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
  }

  async test(connectionId: string, modelId?: string, options: ConnectionTestOptions = {}): Promise<ConnectionTestResult> {
    const connection = await this.get(connectionId);
    const requestedModelId = modelId?.trim() || connection.modelId;
    const notifyOnUnavailable = options.notifyOnUnavailable ?? true;
    const apiKey = await this.vault.read(connection.credentialRef);
    if (!apiKey) return this.reportUnavailable(connection, { kind: "authentication_failed", message: "未找到本机安全凭据，请重新保存 API Key。" }, notifyOnUnavailable);

    try {
      const response = await this.fetcher(`${connection.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (response.status === 401 || response.status === 403) {
        return this.reportUnavailable(connection, { kind: "authentication_failed", message: "认证失败，请检查 API Key。" }, notifyOnUnavailable);
      }
      if (!response.ok) {
        return this.reportUnavailable(connection, response.status === 404
          ? { kind: "model_unavailable", message: "模型服务或模型 ID 不可用。" }
          : { kind: "network_failed", message: `连接失败（HTTP ${response.status}）。` }, notifyOnUnavailable);
      }
      const payload = (await response.json().catch(() => ({ data: [] }))) as { data?: Array<{ id?: string }> };
      const modelAvailable = payload.data?.some((model) => model.id === requestedModelId) ?? false;
      return modelAvailable
        ? { kind: "success", message: "连接成功，模型可用。" }
        : this.reportUnavailable(connection, { kind: "model_unavailable", message: "连接成功，但指定模型不可用。" }, notifyOnUnavailable);
    } catch {
      return this.reportUnavailable(connection, { kind: "network_failed", message: "网络失败，无法连接模型服务。" }, notifyOnUnavailable);
    }
  }

  async chatCompletion(connectionId: string, input: ChatCompletionInput): Promise<string> {
    if (input.signal?.aborted) throw new Error("Professional Agent request was interrupted.");
    const connection = await this.get(connectionId);
    if (!connection.enabled) throw new Error("模型连接已停用。");
    const apiKey = await this.vault.read(connection.credentialRef);
    if (!apiKey) {
      const result = { kind: "authentication_failed" as const, message: "未找到本机安全凭据，请重新保存 API Key。" };
      await this.reportUnavailable(connection, result, true);
      throw new Error(result.message);
    }
    const modelId = input.modelId?.trim() || connection.modelId;
    try {
      const response = await this.fetcher(`${connection.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("模型未返回可执行的专业代理输出。");
      return content;
    } catch (error) {
      if (input.signal?.aborted) throw new Error("Professional Agent request was interrupted.");
      if (error instanceof Error && /认证失败|模型服务或模型 ID|连接失败|模型未返回/.test(error.message)) throw error;
      const result = { kind: "network_failed" as const, message: "网络失败，无法调用专业代理模型。" };
      await this.reportUnavailable(connection, result, true);
      throw new Error(result.message);
    }
  }

  private async reportUnavailable(connection: ModelConnection, result: Exclude<ConnectionTestResult, { kind: "success" }>, notifyOnUnavailable: boolean): Promise<ConnectionTestResult> {
    if (notifyOnUnavailable) await this.onUnavailable?.(connection.id, result.message);
    return result;
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

function required(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(required(value, "A Base URL is required."));
  } catch {
    throw new Error("Base URL must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Base URL must be a valid HTTP(S) URL.");
  }
  return parsed.toString().replace(/\/$/, "");
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
