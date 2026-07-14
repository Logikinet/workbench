/**
 * Plugin / Extension SDK types (Task 46).
 * Inspired by NextClaw extension-sdk + extension-runtime (manifest, stdio lifecycle,
 * contribution registry) — tailored to the local workbench, no chat channels.
 *
 * Extension surface: Provider, Harness, Tool, Skill Source, Artifact Renderer, Trigger.
 */

/** Current Plugin API contract version supported by the host. */
export const PLUGIN_API_VERSION = "1" as const;

/** Manifest filename discovered under a plugin package root. */
export const PLUGIN_MANIFEST_FILE = "paw.plugin.json" as const;

/** Permission tokens a plugin may declare and the operator may approve. */
export const PLUGIN_PERMISSIONS = [
  "fs.read",
  "fs.write",
  "network",
  "shell",
  "secrets.read",
  "secrets.write",
  "workspace.read",
  "workspace.write",
  "provider.register",
  "harness.register",
  "tool.register",
  "skill_source.register",
  "artifact_renderer.register",
  "trigger.register"
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** Contribution kinds registerable via extensions. */
export const PLUGIN_CONTRIBUTION_KINDS = [
  "provider",
  "harness",
  "tool",
  "skill_source",
  "artifact_renderer",
  "trigger"
] as const;

export type PluginContributionKind = (typeof PLUGIN_CONTRIBUTION_KINDS)[number];

export type PluginEntryType = "stdio" | "inprocess";

export type PluginInstallStatus =
  | "installed"
  | "enabled"
  | "disabled"
  | "crashed"
  | "incompatible"
  | "update_available";

export type PluginTriggerKind = "cron" | "webhook" | "event";

/** JSON-schema-like config description (not evaluated as code). */
export type PluginJsonSchema = Record<string, unknown>;

export interface PluginServerConfig {
  type: PluginEntryType;
  /**
   * Relative path to the main module under the package root
   * (required for both stdio and inprocess).
   */
  main: string;
  /** Override spawn command (default: process.execPath for node). */
  command?: string;
  args?: string[];
  /** Non-secret env defaults baked into the package. */
  env?: Record<string, string>;
}

export interface PluginEngineCompat {
  /** Inclusive lower bound of host core semver this plugin supports. */
  minCoreVersion: string;
  /** Exclusive upper bound; when omitted, no upper cap. */
  maxCoreVersion?: string;
}

export interface ProviderContribution {
  id: string;
  name: string;
  description?: string;
  providerKind?: string;
}

export interface HarnessContribution {
  id: string;
  name: string;
  description?: string;
  capabilities?: string[];
}

export interface ToolContribution {
  id: string;
  name: string;
  description?: string;
  category: "readonly" | "write" | "shell" | "network" | "dangerous";
  inputSchema?: PluginJsonSchema;
}

export interface SkillSourceContribution {
  id: string;
  name: string;
  description?: string;
  /** Directory hint relative to plugin root (optional). */
  rootHint?: string;
}

export interface ArtifactRendererContribution {
  id: string;
  name: string;
  description?: string;
  mimeTypes: string[];
  extensions?: string[];
}

export interface TriggerContribution {
  id: string;
  name: string;
  description?: string;
  kind: PluginTriggerKind;
}

export interface PluginContributes {
  providers?: ProviderContribution[];
  harnesses?: HarnessContribution[];
  tools?: ToolContribution[];
  skillSources?: SkillSourceContribution[];
  artifactRenderers?: ArtifactRendererContribution[];
  triggers?: TriggerContribution[];
}

/**
 * On-disk extension package contract.
 * Secrets are never listed as values — only key names via `secretsSchema`.
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** API contract the package targets (must match host PLUGIN_API_VERSION family). */
  apiVersion: string;
  engine: PluginEngineCompat;
  entry: PluginServerConfig;
  permissions: PluginPermission[];
  /** Non-secret operator configuration schema. */
  configSchema?: PluginJsonSchema;
  /** Secret key *names* only — values live in a CredentialVault. */
  secretsSchema?: {
    keys: string[];
  };
  contributes: PluginContributes;
}

/** Manifest plus resolved absolute package root after discovery/install. */
export interface ResolvedPluginManifest extends PluginManifest {
  rootDir: string;
}

export interface PluginVersionSnapshot {
  version: string;
  contentHash: string;
  /** Absolute path to archived package copy (under install history). */
  archivePath: string;
  capturedAt: string;
}

export interface PluginInstallRecord {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  apiVersion: string;
  engine: PluginEngineCompat;
  /** Absolute path to the active package root. */
  installPath: string;
  contentHash: string;
  enabled: boolean;
  status: PluginInstallStatus;
  /** Permissions the operator approved (subset of manifest.permissions). */
  approvedPermissions: PluginPermission[];
  /** Manifest-declared permissions at install time (for UI). */
  declaredPermissions: PluginPermission[];
  config: Record<string, unknown>;
  /** Secret key names present in vault (values never persisted here). */
  secretKeys: string[];
  credentialRef?: string;
  history: PluginVersionSnapshot[];
  lastError?: string;
  processId?: number;
  installedAt: string;
  updatedAt: string;
}

/** Public row for HTTP/UI/backup — never includes secret values. */
export interface PublicPluginRecord {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  apiVersion: string;
  engine: PluginEngineCompat;
  enabled: boolean;
  status: PluginInstallStatus;
  approvedPermissions: PluginPermission[];
  declaredPermissions: PluginPermission[];
  config: Record<string, unknown>;
  secretKeys: string[];
  secretsPresent: boolean;
  secretsExcluded: true;
  contributes: PluginContributes;
  lastError?: string;
  installedAt: string;
  updatedAt: string;
}

export interface PluginState {
  schemaVersion: 1;
  /** Host core version used for last compatibility pass. */
  coreVersion: string;
  plugins: Record<string, PluginInstallRecord>;
}

/** Registered contribution bound to a plugin id (runtime registry entry). */
export interface RegisteredContribution<T = unknown> {
  pluginId: string;
  kind: PluginContributionKind;
  contributionId: string;
  contribution: T;
  registeredAt: string;
}

export interface PluginPermissionDenial {
  permission: PluginPermission;
  reason: string;
}

export interface PluginCompatResult {
  compatible: boolean;
  pluginId: string;
  pluginVersion: string;
  coreVersion: string;
  apiVersionOk: boolean;
  engineOk: boolean;
  reasons: string[];
}

export interface InstallPluginInput {
  /** Absolute path to a directory containing paw.plugin.json. */
  sourcePath: string;
  /**
   * Operator must approve every permission the package declares
   * (or a strict subset when partial approval is allowed).
   */
  approvedPermissions: PluginPermission[];
  /** Require full declaration coverage (default true). */
  requireAllDeclared?: boolean;
  confirm: true;
  config?: Record<string, unknown>;
  /** Secret values keyed by secretsSchema names — vault only. */
  secrets?: Record<string, string>;
}

export interface UpdatePluginInput {
  pluginId: string;
  sourcePath: string;
  confirm: true;
  /** When true, keep previous approvedPermissions if still a superset of new declarations. */
  preserveApprovals?: boolean;
  approvedPermissions?: PluginPermission[];
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export interface RollbackPluginInput {
  pluginId: string;
  confirm: true;
  /** Specific version to restore; defaults to most recent history entry. */
  version?: string;
}

export interface EnablePluginInput {
  pluginId: string;
  /** Optional extra permissions to approve at enable time. */
  approvedPermissions?: PluginPermission[];
}

export interface PluginBackupSlice {
  secretsExcluded: true;
  plugins: Array<{
    id: string;
    name: string;
    version: string;
    enabled: boolean;
    status: PluginInstallStatus;
    approvedPermissions: PluginPermission[];
    config: Record<string, unknown>;
    secretKeys: string[];
    credentialRef?: string;
  }>;
}

export interface PluginHostRequest {
  requestId: string;
  pluginId: string;
  kind: string;
  payload?: Record<string, unknown>;
}

export interface PluginHostResponse {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: { message: string; code?: string };
}

export type PluginMessageHandler = (
  request: PluginHostRequest
) => unknown | Promise<unknown>;

/** In-process plugin module contract (tests + lightweight packages). */
export interface InprocessPluginModule {
  handle?: PluginMessageHandler;
  contributions?: PluginContributes;
  onStart?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
}

export interface RunningPluginHandle {
  pluginId: string;
  entryType: PluginEntryType;
  pid?: number;
  startedAt: string;
  stop: () => Promise<void>;
  request: <T = unknown>(kind: string, payload?: Record<string, unknown>) => Promise<T>;
}
