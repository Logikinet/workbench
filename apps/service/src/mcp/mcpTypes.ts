/**
 * MCP connection types (Task 24 + Task 40 catalog lifecycle).
 * Secret values live in a CredentialVault; persisted state never stores raw env/auth.
 */

/** Supported transport kinds. `fake` is for injectable tests only. */
export type McpTransportKind = "stdio" | "http" | "fake";

export type McpToolRisk = "read" | "write" | "network" | "shell" | "dangerous";

export type McpCatalogTrustLevel = "official" | "community";

export type McpInstallStatus =
  | "not_installed"
  | "installed"
  | "update_available"
  | "disabled"
  | "untrusted";

export type McpTestKind =
  | "success"
  | "authentication_failed"
  | "network_failed"
  | "server_unavailable"
  | "disabled";

export interface McpTestResult {
  kind: McpTestKind;
  message: string;
  detail?: string;
  checkedAt: string;
  toolCount?: number;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Optional risk hint for policy checks (defaults derived from name/schema). */
  risk?: McpToolRisk;
}

export interface McpConnection {
  id: string;
  name: string;
  transport: McpTransportKind;
  enabled: boolean;
  /** stdio: executable */
  command?: string;
  /** stdio: argv (non-secret) */
  args?: string[];
  /** Names of env vars present in vault env blob (values never persisted). */
  envKeys?: string[];
  /** http: endpoint URL */
  url?: string;
  /** Opaque vault reference for auth token and/or env map JSON. */
  credentialRef: string;
  /** Non-secret flag only. */
  credentialPresent?: boolean;
  credentialUpdatedAt?: string;
  /** Last discovered tools (descriptions only; no secrets). */
  tools?: McpToolDescriptor[];
  lastTest?: McpTestResult;
  /** Catalog lifecycle (Task 40). */
  catalogId?: string;
  version?: string;
  source?: "manual" | "catalog";
  tags?: string[];
  description?: string;
  /** Operator trust gate — catalog installs start untrusted. */
  trusted?: boolean;
  trustedAt?: string;
  trustLevel?: McpCatalogTrustLevel;
  createdAt: string;
  updatedAt: string;
}

/** Public row for HTTP/UI — never includes secrets or vault refs. */
export interface PublicMcpConnection {
  id: string;
  name: string;
  transport: McpTransportKind;
  enabled: boolean;
  command?: string;
  args?: string[];
  envKeys?: string[];
  url?: string;
  credentialPresent: boolean;
  credentialUpdatedAt?: string;
  tools?: McpToolDescriptor[];
  lastTest?: McpTestResult;
  catalogId?: string;
  version?: string;
  source?: "manual" | "catalog";
  tags?: string[];
  description?: string;
  trusted: boolean;
  trustedAt?: string;
  trustLevel?: McpCatalogTrustLevel;
  installStatus?: McpInstallStatus;
  createdAt: string;
  updatedAt: string;
}

/** Discoverable MCP server template (local catalog — no third-party marketplace brand). */
export interface McpCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  recommended?: boolean;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  url?: string;
  /** Env key names the template expects (values supplied at install; never in catalog). */
  envKeys?: string[];
  /** Risk summary lines for first-run trust UI. */
  permissionSummary: string[];
  trustLevel: McpCatalogTrustLevel;
  /** Optional fake server id for tests. */
  fakeServerId?: string;
}

export interface McpCatalogSearchQuery {
  query?: string;
  tags?: string[];
  recommendedOnly?: boolean;
  notInstalledOnly?: boolean;
}

export interface McpCatalogSearchResult {
  catalogAvailable: boolean;
  entries: Array<
    McpCatalogEntry & {
      installed: boolean;
      installedConnectionId?: string;
      installedVersion?: string;
      recommended: boolean;
    }
  >;
  installedCount: number;
}

export interface McpConnectionSnapshot {
  version: string;
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  catalogId?: string;
  capturedAt: string;
}

export interface McpInstallRecord {
  connectionId: string;
  catalogId?: string;
  version: string;
  installedAt: string;
  updatedAt: string;
  history: McpConnectionSnapshot[];
}

export interface McpPermissionSummary {
  connectionId: string;
  name: string;
  version?: string;
  source?: "manual" | "catalog";
  catalogId?: string;
  tools: Array<{ name: string; risk?: McpToolRisk; description?: string }>;
  permissionLines: string[];
  trusted: boolean;
  requiresTrustConfirmation: boolean;
}

export interface McpInstallPreview {
  catalogId: string;
  entry: McpCatalogEntry;
  permissionLines: string[];
  requiresConfirm: true;
  wouldReplaceConnectionId?: string;
}

export interface McpUpdatePreview {
  connectionId: string;
  catalogId: string;
  currentVersion: string;
  targetVersion: string;
  permissionLines: string[];
  requiresConfirm: true;
  configDiff: string;
}

export interface CreateMcpConnectionInput {
  name: string;
  transport: McpTransportKind;
  enabled?: boolean;
  command?: string;
  args?: string[];
  /** Secret env map (stdio). Stored in vault only. */
  env?: Record<string, string>;
  url?: string;
  /** Bearer/API token for http transport. Stored in vault only. */
  authToken?: string;
  /** Test-only client key for Fake registry. */
  fakeServerId?: string;
}

export interface UpdateMcpConnectionInput {
  name?: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  authToken?: string;
  /** When true, clears vault secrets for this connection. */
  clearSecrets?: boolean;
  fakeServerId?: string;
}

/** Explicit per-tool binding — never whole-server by default. */
export interface McpToolRef {
  connectionId: string;
  toolName: string;
}

export interface RoleMcpBinding {
  roleId: string;
  tools: McpToolRef[];
  updatedAt: string;
}

export interface RolePermissionsLike {
  workspace: "project_only" | "read_only";
  network: boolean;
  shell: boolean;
  externalSend: boolean;
}

export interface McpCallContext {
  roleId?: string;
  permissions?: RolePermissionsLike;
  /** User has approved dangerous / high-risk tool use for this call. */
  approvedDangerous?: boolean;
  workspacePath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type McpCallErrorKind =
  | "unavailable"
  | "disabled"
  | "not_bound"
  | "untrusted"
  | "permission_denied"
  | "timeout"
  | "cancelled"
  | "invalid_args"
  | "result_too_large"
  | "args_too_large"
  | "tool_error"
  | "not_found";

export interface McpToolCallSuccess {
  ok: true;
  connectionId: string;
  toolName: string;
  /** Redacted content suitable for logs/timeline. */
  content: unknown;
  /** Raw size before truncation (bytes, UTF-8). */
  resultBytes: number;
  truncated: boolean;
  durationMs: number;
}

export interface McpToolCallFailure {
  ok: false;
  connectionId: string;
  toolName: string;
  kind: McpCallErrorKind;
  message: string;
  /** Soft failure: pause related subtask only — do not crash workbench. */
  pauseRelatedSubtasks: boolean;
  durationMs: number;
}

export type McpToolCallResult = McpToolCallSuccess | McpToolCallFailure;

export interface McpVaultSecrets {
  authToken?: string;
  env?: Record<string, string>;
  fakeServerId?: string;
}

export interface McpConnectionStateSnapshot {
  schemaVersion: 1;
  connections: McpConnection[];
  roleBindings: RoleMcpBinding[];
  installs?: Record<string, McpInstallRecord>;
  secretsExcluded: true;
}

/** Size / timeout policy applied to every tool call. */
export const MCP_DEFAULT_TIMEOUT_MS = 30_000;
export const MCP_MAX_ARGS_BYTES = 64 * 1024;
export const MCP_MAX_RESULT_BYTES = 256 * 1024;
export const MCP_MAX_LOG_SNIPPET = 2_048;
