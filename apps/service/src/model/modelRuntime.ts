import type { ConnectionService } from "../connections/connectionService.js";
import type { AgentRole, RoleService } from "../roles/roleService.js";
import { ConnectionModelProvider } from "./connectionProvider.js";
import { parseAndValidateJson, type JsonSchema } from "./jsonSchema.js";
import { redactSecrets } from "./redact.js";
import {
  DEFAULT_FORMAT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  MAX_FORMAT_RETRIES_CAP,
  type ModelErrorKind,
  type ModelInvocationConfig,
  type ModelInvokeFailure,
  type ModelInvokeInput,
  type ModelInvokeResult,
  type ModelMessage,
  type ModelProvider,
  type ModelRuntimeRunHooks
} from "./types.js";

export interface ModelRuntimeOptions {
  roles: RoleService;
  connections: ConnectionService;
  /** Injectable provider; defaults to ConnectionModelProvider. */
  provider?: ModelProvider;
  runHooks?: ModelRuntimeRunHooks;
  defaultTimeoutMs?: number;
}

/**
 * Unified model invocation runtime: resolve Role → connection/model/harness/reasoning,
 * call a real or fake provider, validate structured JSON Schema output with bounded retries,
 * and fail-pause without auto-switching models or paid connections.
 */
export class ModelRuntime {
  private readonly provider: ModelProvider;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly options: ModelRuntimeOptions) {
    this.provider = options.provider ?? new ConnectionModelProvider(options.connections);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Resolve secret-free invocation config from an enabled Agent Role (backward-compatible Role fields). */
  async resolveConfig(roleId: string): Promise<ModelInvocationConfig> {
    const role = await this.options.roles.get(roleId);
    return this.configFromRole(role);
  }

  /**
   * Invoke a model using the Role's connection/model/reasoning settings.
   * Never auto-switches connections or models on failure.
   */
  async invoke(input: ModelInvokeInput): Promise<ModelInvokeResult> {
    let config: ModelInvocationConfig;
    try {
      config = await this.resolveConfig(input.roleId);
    } catch (error) {
      return this.failure("provider_error", errorMessage(error, "Agent Role was not found."), 0, false);
    }

    if (!config.enabled) {
      return this.failure("role_disabled", "Role 已停用。", 0, false, config);
    }

    if (config.harness !== "api") {
      return this.failure(
        "harness_unsupported",
        `Role harness "${config.harness}" is not invoked through the API model runtime; use the matching Agent Runtime adapter.`,
        0,
        false,
        config
      );
    }

    if (!config.connectionId) {
      return this.failure("missing_connection", "API Harness 需要模型连接。", 0, true, config, input.runId);
    }

    try {
      const connection = await this.options.connections.get(config.connectionId);
      if (!connection.enabled) {
        return this.failure("connection_disabled", "模型连接已停用。", 0, true, config, input.runId, config.connectionId);
      }
      // Prefer Role modelId, then connection modelId — never silently switch to another connection.
      config = {
        ...config,
        modelId: config.modelId || connection.modelId,
        baseUrl: connection.baseUrl
      };
    } catch {
      return this.failure("missing_connection", "模型连接不存在或已删除。", 0, true, config, input.runId);
    }

    const maxFormatRetries = clamp(
      input.maxFormatRetries ?? DEFAULT_FORMAT_RETRIES,
      0,
      MAX_FORMAT_RETRIES_CAP
    );
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const baseMessages = this.buildMessages(config, input);
    let attempts = 0;
    let lastFormatMessage = "Model output failed format validation.";

    while (attempts <= maxFormatRetries) {
      if (input.signal?.aborted) {
        return this.failure("cancelled", "Model invocation was cancelled.", attempts, false, config);
      }

      attempts += 1;
      const attemptMessages =
        attempts === 1
          ? baseMessages
          : [
              ...baseMessages,
              {
                role: "user" as const,
                content: [
                  "Your previous response did not match the required structured output format.",
                  `Error: ${lastFormatMessage}`,
                  "Return JSON only that satisfies the schema. Do not include secrets or credentials."
                ].join("\n")
              }
            ];

      try {
        const content = await this.completeWithTimeout(
          {
            connectionId: config.connectionId!,
            modelId: config.modelId!,
            messages: attemptMessages,
            reasoningEffort: config.reasoningEffort,
            jsonSchema: input.schema,
            signal: input.signal
          },
          timeoutMs,
          input.signal
        );

        if (!input.schema) {
          await this.safeLog(input.runId, "info", `模型调用成功（attempt ${attempts}）。`);
          return {
            ok: true,
            content,
            attempts,
            config,
            usage: undefined
          };
        }

        const parsed = parseAndValidateJson(content, input.schema);
        if (parsed.ok) {
          await this.safeLog(input.runId, "info", `结构化模型输出校验通过（attempt ${attempts}）。`);
          return {
            ok: true,
            content,
            parsed: parsed.value,
            attempts,
            config
          };
        }

        lastFormatMessage = parsed.message;
        if (attempts > maxFormatRetries) {
          return this.failure("format_error", redactSecrets(lastFormatMessage), attempts, false, config);
        }
        await this.safeLog(input.runId, "warn", `结构化输出格式错误，将重试（attempt ${attempts}/${maxFormatRetries + 1}）：${redactSecrets(lastFormatMessage)}`);
      } catch (error) {
        const classified = classifyProviderError(error);
        if (classified.kind === "format_error") {
          lastFormatMessage = classified.message;
          if (attempts > maxFormatRetries) {
            return this.failure("format_error", classified.message, attempts, false, config);
          }
          continue;
        }
        const shouldPause =
          classified.kind === "authentication_failed"
          || classified.kind === "model_unavailable"
          || classified.kind === "network_failed"
          || classified.kind === "connection_disabled";
        return this.failure(
          classified.kind,
          classified.message,
          attempts,
          shouldPause,
          config,
          input.runId,
          shouldPause ? config.connectionId : undefined
        );
      }
    }

    return this.failure("format_error", redactSecrets(lastFormatMessage), attempts, false, config);
  }

  private async configFromRole(role: AgentRole): Promise<ModelInvocationConfig> {
    const config: ModelInvocationConfig = {
      roleId: role.id,
      roleName: role.name,
      harness: role.harness,
      connectionId: role.connectionId,
      modelId: role.modelId,
      reasoningEffort: role.reasoningEffort,
      systemInstruction: role.systemInstruction,
      enabled: role.enabled
    };
    if (role.connectionId) {
      try {
        const connection = await this.options.connections.get(role.connectionId);
        config.baseUrl = connection.baseUrl;
        if (!config.modelId) config.modelId = connection.modelId;
      } catch {
        // Connection may have been deleted; leave baseUrl unset.
      }
    }
    return config;
  }

  private buildMessages(config: ModelInvocationConfig, input: ModelInvokeInput): ModelMessage[] {
    const system = input.overrideSystem?.trim() || config.systemInstruction;
    const messages: ModelMessage[] = [{ role: "system", content: system }];
    for (const message of input.messages) {
      if (message.role === "system") continue;
      messages.push({ role: message.role, content: message.content });
    }
    if (input.schema) {
      messages.push({
        role: "user",
        content: `Respond with JSON only that validates against this JSON Schema:\n${JSON.stringify(input.schema)}`
      });
    }
    return messages;
  }

  private async completeWithTimeout(
    request: Parameters<ModelProvider["complete"]>[0],
    timeoutMs: number,
    outerSignal?: AbortSignal
  ): Promise<string> {
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    if (outerSignal?.aborted) controller.abort();
    else outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.provider.complete({ ...request, signal: controller.signal });
      if (controller.signal.aborted && outerSignal?.aborted) {
        throw Object.assign(new Error("Model invocation was cancelled."), { kind: "cancelled" as const, name: "AbortError" });
      }
      return response.content;
    } catch (error) {
      // Prefer outer cancel over timeout when both may have fired.
      if (outerSignal?.aborted) {
        throw Object.assign(new Error("Model invocation was cancelled."), { kind: "cancelled" as const, name: "AbortError" });
      }
      if (controller.signal.aborted) {
        throw Object.assign(new Error("Model invocation timed out."), { kind: "timeout" as const, code: "ETIMEDOUT" });
      }
      if (isCancelError(error)) {
        throw Object.assign(new Error("Model invocation was cancelled."), { kind: "cancelled" as const, name: "AbortError" });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
    }
  }

  private async failure(
    kind: ModelErrorKind,
    message: string,
    attempts: number,
    pauseRun: boolean,
    config?: ModelInvocationConfig,
    runId?: string,
    connectionId?: string
  ): Promise<ModelInvokeFailure> {
    const safeMessage = redactSecrets(message);
    const retryable = kind === "timeout" || kind === "network_failed" || kind === "format_error" || kind === "model_unavailable";
    if (pauseRun && runId) {
      await this.safeLog(runId, "error", safeMessage);
      if (connectionId && this.options.runHooks?.pauseForConnection) {
        await this.options.runHooks.pauseForConnection(connectionId, safeMessage);
      } else if (this.options.runHooks?.pause) {
        await this.options.runHooks.pause(runId, safeMessage);
      }
    } else if (runId) {
      await this.safeLog(runId, kind === "cancelled" ? "warn" : "error", safeMessage);
    }
    return {
      ok: false,
      error: { kind, message: safeMessage, retryable, pauseRun },
      attempts,
      config
    };
  }

  private async safeLog(runId: string | undefined, level: "info" | "warn" | "error", message: string): Promise<void> {
    if (!runId || !this.options.runHooks?.recordLog) return;
    try {
      await this.options.runHooks.recordLog(runId, { level, message: redactSecrets(message) });
    } catch {
      // Logging must never break invocation.
    }
  }
}

function classifyProviderError(error: unknown): { kind: ModelErrorKind; message: string } {
  if (isCancelError(error)) {
    return { kind: "cancelled", message: "Model invocation was cancelled." };
  }
  const kind = error && typeof error === "object" && "kind" in error && typeof (error as { kind: unknown }).kind === "string"
    ? (error as { kind: ModelErrorKind }).kind
    : undefined;
  const message = errorMessage(error, "Model provider error.");
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";

  if (kind === "timeout" || code === "ETIMEDOUT" || /timed out|timeout/i.test(message)) {
    return { kind: "timeout", message: "Model invocation timed out." };
  }
  if (kind === "authentication_failed" || /认证失败|API Key|unauthori[sz]ed|forbidden/i.test(message)) {
    return { kind: "authentication_failed", message: redactSecrets(message.includes("认证") ? message : "认证失败，请检查 API Key。") };
  }
  if (kind === "model_unavailable" || /模型.*不可用|model.*unavail/i.test(message)) {
    return { kind: "model_unavailable", message: message.includes("模型") ? message : "模型服务或模型 ID 不可用。" };
  }
  if (kind === "network_failed" || /网络失败|network|ECONN|ENOTFOUND|socket/i.test(message)) {
    return { kind: "network_failed", message: message.includes("网络") ? message : "网络失败，无法连接模型服务。" };
  }
  if (kind === "cancelled") {
    return { kind: "cancelled", message: "Model invocation was cancelled." };
  }
  return { kind: kind ?? "provider_error", message: redactSecrets(message) };
}

function isCancelError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: string; kind?: string; message?: string };
  return record.name === "AbortError" || record.kind === "cancelled" || /cancelled|interrupted|aborted/i.test(record.message ?? "");
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return redactSecrets(error.message);
  if (typeof error === "string" && error.trim()) return redactSecrets(error);
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export type { JsonSchema };
