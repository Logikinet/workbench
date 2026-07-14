import type { ModelProvider, ModelProviderRequest, ModelProviderResponse } from "./types.js";

export type FakeProviderScenario =
  | "success"
  | "timeout"
  | "format_error"
  | "format_error_then_success"
  | "auth_fail"
  | "model_unavailable"
  | "network_failed"
  | "cancel";

export interface FakeProviderOptions {
  scenario?: FakeProviderScenario;
  /** Content returned on success (or after format repair). */
  successContent?: string;
  /**
   * Multi-turn success queue: each complete() shifts the next content.
   * When exhausted, falls back to successContent.
   */
  successContents?: string[];
  /** Invalid content returned for format_error scenarios. */
  invalidContent?: string;
  /** Artificial delay before responding (ms). */
  delayMs?: number;
  /** How many format failures before success when using format_error_then_success. */
  formatFailuresBeforeSuccess?: number;
  /**
   * Full multi-turn control: when set, invoked for every complete() after bookkeeping.
   * Return value / thrown errors override scenario handling when provided.
   */
  handler?: (request: ModelProviderRequest, callIndex: number) => Promise<ModelProviderResponse> | ModelProviderResponse;
}

/**
 * Injectable Fake Provider covering success, timeout, format error, auth fail, and cancel.
 * Used by unit tests and future orchestration harness tests — no network, no secrets.
 * Supports multi-turn tool loops via successContents queue or a custom handler.
 */
export class FakeModelProvider implements ModelProvider {
  scenario: FakeProviderScenario;
  successContent: string;
  successContents: string[];
  invalidContent: string;
  delayMs: number;
  formatFailuresBeforeSuccess: number;
  handler?: FakeProviderOptions["handler"];
  readonly calls: ModelProviderRequest[] = [];
  private formatFailureCount = 0;
  private successQueueIndex = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.scenario = options.scenario ?? "success";
    this.successContent = options.successContent ?? JSON.stringify({ summary: "ok", value: 1 });
    this.successContents = options.successContents ? [...options.successContents] : [];
    this.invalidContent = options.invalidContent ?? "not-json";
    this.delayMs = options.delayMs ?? 0;
    this.formatFailuresBeforeSuccess = options.formatFailuresBeforeSuccess ?? 1;
    this.handler = options.handler;
  }

  reset(): void {
    this.calls.length = 0;
    this.formatFailureCount = 0;
    this.successQueueIndex = 0;
  }

  /** Push additional success responses for multi-turn tool-loop tests. */
  enqueueSuccess(...contents: string[]): void {
    this.successContents.push(...contents);
  }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.calls.push({
      connectionId: request.connectionId,
      modelId: request.modelId,
      messages: request.messages.map((message) => ({ ...message })),
      reasoningEffort: request.reasoningEffort,
      jsonSchema: request.jsonSchema,
      signal: request.signal
    });

    if (request.signal?.aborted) {
      throw cancelError();
    }

    if (this.scenario === "cancel") {
      throw cancelError();
    }

    if (this.delayMs > 0) {
      await delay(this.delayMs, request.signal);
    }

    if (request.signal?.aborted) {
      throw cancelError();
    }

    if (this.handler) {
      return this.handler(request, this.calls.length - 1);
    }

    switch (this.scenario) {
      case "timeout":
        throw Object.assign(new Error("Model invocation timed out."), { code: "ETIMEDOUT", kind: "timeout" as const });
      case "auth_fail":
        throw Object.assign(new Error("认证失败，请检查 API Key。"), { kind: "authentication_failed" as const });
      case "model_unavailable":
        throw Object.assign(new Error("模型服务或模型 ID 不可用。"), { kind: "model_unavailable" as const });
      case "network_failed":
        throw Object.assign(new Error("网络失败，无法连接模型服务。"), { kind: "network_failed" as const });
      case "format_error":
        return { content: this.invalidContent };
      case "format_error_then_success": {
        this.formatFailureCount += 1;
        if (this.formatFailureCount <= this.formatFailuresBeforeSuccess) {
          return { content: this.invalidContent };
        }
        return { content: this.nextSuccessContent(), usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
      }
      case "success":
      default:
        return { content: this.nextSuccessContent(), usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    }
  }

  private nextSuccessContent(): string {
    if (this.successQueueIndex < this.successContents.length) {
      const content = this.successContents[this.successQueueIndex]!;
      this.successQueueIndex += 1;
      return content;
    }
    return this.successContent;
  }
}

function cancelError(): Error {
  return Object.assign(new Error("Model invocation was cancelled."), { kind: "cancelled" as const, name: "AbortError" });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(cancelError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
