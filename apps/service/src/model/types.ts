import type { Harness, ReasoningEffort } from "../roles/roleService.js";
import type { JsonSchema } from "./jsonSchema.js";

/** Resolved, secret-free configuration derived from an enabled Agent Role. */
export interface ModelInvocationConfig {
  roleId: string;
  roleName: string;
  harness: Harness;
  connectionId?: string;
  modelId?: string;
  reasoningEffort: ReasoningEffort;
  systemInstruction: string;
  /** Connection base URL when harness is API — never includes credentials. */
  baseUrl?: string;
  enabled: boolean;
}

export type ModelErrorKind =
  | "authentication_failed"
  | "model_unavailable"
  | "network_failed"
  | "timeout"
  | "cancelled"
  | "format_error"
  | "role_disabled"
  | "connection_disabled"
  | "missing_connection"
  | "harness_unsupported"
  | "provider_error";

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelProviderRequest {
  connectionId: string;
  modelId: string;
  messages: ModelMessage[];
  reasoningEffort?: ReasoningEffort;
  /** Optional structured-output hint; providers may ignore if unsupported. */
  jsonSchema?: JsonSchema;
  signal?: AbortSignal;
}

export interface ModelProviderResponse {
  content: string;
  /** Optional usage metrics (never secrets). */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Pluggable model completion provider.
 * Implementations must never put API keys into returned content or throw messages that embed credentials.
 */
export interface ModelProvider {
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse>;
}

export interface ModelInvokeInput {
  roleId: string;
  /** User/assistant turns; system instruction is taken from the Role unless overrideSystem is set. */
  messages: ModelMessage[];
  /** When set, replaces Role systemInstruction for this call. */
  overrideSystem?: string;
  /** JSON Schema for structured output validation + repair retries. */
  schema?: JsonSchema;
  /** Max additional attempts after the first when format/schema fails. Default 2 (3 total). */
  maxFormatRetries?: number;
  /** Wall-clock timeout for a single provider attempt (ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * When provided with run hooks, model-unavailable / auth failures pause the Run
   * instead of auto-switching models or paid connections.
   */
  runId?: string;
}

export interface ModelInvokeSuccess {
  ok: true;
  content: string;
  parsed?: unknown;
  attempts: number;
  config: ModelInvocationConfig;
  usage?: ModelProviderResponse["usage"];
}

export interface ModelInvokeFailure {
  ok: false;
  error: {
    kind: ModelErrorKind;
    /** User-facing, secret-free reason. */
    message: string;
    retryable: boolean;
    /** True when the Run should be paused and the operator must fix the connection/model. */
    pauseRun: boolean;
  };
  attempts: number;
  config?: ModelInvocationConfig;
}

export type ModelInvokeResult = ModelInvokeSuccess | ModelInvokeFailure;

/** Optional Run integration for fail-pause and safe logging. */
export interface ModelRuntimeRunHooks {
  recordLog?(runId: string, input: { level: "info" | "warn" | "error"; message: string }): Promise<unknown>;
  pause?(runId: string, reason: string): Promise<unknown>;
  pauseForConnection?(connectionId: string, reason: string): Promise<unknown>;
}

export const DEFAULT_FORMAT_RETRIES = 2;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_FORMAT_RETRIES_CAP = 5;
