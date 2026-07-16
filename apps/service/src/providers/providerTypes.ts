/**
 * Unified Provider Connection model (task 05 / cli修改.md).
 * Secrets never appear on these public types.
 */

export type ProviderType = "builtin" | "custom" | "local";

export type ProviderAdapterKind =
  | "openai-compatible"
  | "anthropic"
  | "gemini"
  | "ollama";

export type ProviderAuthMode = "api-key" | "oauth" | "environment" | "none";

export type ProviderStatus =
  | "unknown"
  | "ready"
  | "missing_credentials"
  | "auth_failed"
  | "unreachable"
  | "rate_limited"
  | "misconfigured"
  | "model_not_found";

export interface ProviderConnection {
  id: string;
  name: string;
  providerType: ProviderType;
  adapter: ProviderAdapterKind;
  baseUrl?: string;
  apiProtocol: string;
  authMode: ProviderAuthMode;
  /** Opaque vault reference only — never a secret value. */
  credentialRef?: string;
  credentialConfigured: boolean;
  /** When authMode=environment, the env var name (not the value). */
  credentialEnvVar?: string;
  enabled: boolean;
  status: ProviderStatus;
  /** Default / selected model id for roles. */
  defaultModelId?: string;
  lastTestedAt?: string;
  lastTestMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModel {
  id: string;
  providerConnectionId: string;
  remoteModelId: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoning: boolean;
  supportedThinkingLevels: string[];
  enabled: boolean;
}

export interface ProviderTestResult {
  status: ProviderStatus;
  message: string;
  detail?: string;
  httpStatus?: number;
  checkedAt: string;
  modelCount?: number;
}

export interface ProviderModelInput {
  remoteModelId: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoning?: boolean;
}

export interface CreateProviderInput {
  name: string;
  adapter: ProviderAdapterKind;
  providerType?: ProviderType;
  baseUrl?: string;
  apiProtocol?: string;
  authMode: ProviderAuthMode;
  /** Never logged; written only to CredentialStore. */
  apiKey?: string;
  credentialEnvVar?: string;
  defaultModelId?: string;
  enabled?: boolean;
  discoverModels?: boolean;
  /**
   * When true, api-key auth may be created without a key (configure later).
   * Matches todos CLI custom provider "empty to skip" behavior.
   */
  allowDeferredCredential?: boolean;
  /** Explicit model registry entries (todos CLI multi-model add). */
  models?: ProviderModelInput[];
}

export interface UpdateProviderInput {
  name?: string;
  baseUrl?: string;
  authMode?: ProviderAuthMode;
  apiKey?: string;
  credentialEnvVar?: string;
  defaultModelId?: string;
  enabled?: boolean;
  status?: ProviderStatus;
}

export interface ProviderPresetChoice {
  id: string;
  name: string;
  /** Search/display label (todos-style). */
  label: string;
  /** Short hint under the label. */
  hint: string;
  adapter: ProviderAdapterKind;
  providerType: ProviderType;
  defaultBaseUrl?: string;
  /** Protocol string from pi-ai / todos (openai-completions, anthropic-messages, …). */
  apiProtocol: string;
  authModes: ProviderAuthMode[];
  requiresCredential: boolean;
  /** Allow empty API key and configure later (custom providers). */
  allowDeferredCredential: boolean;
  description: string;
  /** Suggested env var name for $ENV indirection (never the secret). */
  credentialEnvVar?: string;
  /** Suggested default model id when discovering is unavailable. */
  defaultModelId?: string;
}

/** Full catalog lives in providerCatalog.ts (todos/pi-ai parity). */
export { PROVIDER_CLI_PRESETS } from "./providerCatalog.js";
