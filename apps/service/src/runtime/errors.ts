import type { NormalizedRuntimeError, NormalizedRuntimeErrorKind } from "./types.js";
import { redactSecrets } from "../model/redact.js";

/** Normalize harness-specific failures into the unified runtime error taxonomy. */
export function normalizeRuntimeError(error: unknown, fallback: NormalizedRuntimeErrorKind = "unknown"): NormalizedRuntimeError {
  if (error && typeof error === "object" && "kind" in error && "message" in error) {
    const record = error as { kind: string; message: string; retryable?: boolean; code?: string | number };
    if (isKnownKind(record.kind)) {
      return {
        kind: record.kind,
        message: redactSecrets(record.message),
        retryable: record.retryable ?? defaultRetryable(record.kind),
        code: record.code
      };
    }
  }

  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Runtime error.";
  const safe = redactSecrets(message);
  const lower = safe.toLowerCase();
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code: string | number }).code
      : error && typeof error === "object" && "exitCode" in error
        ? (error as { exitCode: string | number }).exitCode
        : undefined;

  if (/user cancel|cancelled by user|aborted by user/i.test(safe) || (error as { name?: string })?.name === "AbortError") {
    return { kind: "user_cancel", message: "用户取消了运行时会话。", retryable: false, code };
  }
  if (/not logged in|login status|尚未登录|login 已失效|请在本机运行 codex login/i.test(safe)) {
    return { kind: "not_logged_in", message: safe, retryable: true, code };
  }
  if (/quota|rate limit|429|额度|配额/i.test(lower)) {
    return { kind: "quota_exceeded", message: safe, retryable: true, code };
  }
  if (/认证失败|api key|unauthori[sz]ed|forbidden|401|403/i.test(lower)) {
    return { kind: "authentication_failed", message: safe.includes("认证") ? safe : "认证失败，请检查凭据。", retryable: true, code };
  }
  if (/模型.*不可用|model.*unavail/i.test(safe)) {
    return { kind: "model_unavailable", message: safe, retryable: true, code };
  }
  if (/timed out|timeout|etimedout/i.test(lower)) {
    return { kind: "timeout", message: "运行时调用超时。", retryable: true, code };
  }
  if (/process exit|exit code|exited|进程退出/i.test(lower) || typeof code === "number") {
    return { kind: "process_exit", message: safe, retryable: true, code };
  }
  if (/protocol|invalid event|parse.*event|握手/i.test(lower)) {
    return { kind: "protocol_error", message: safe, retryable: false, code };
  }
  if (/网络失败|network|econn|enotfound|socket/i.test(lower)) {
    return { kind: "network_failed", message: safe, retryable: true, code };
  }
  return { kind: fallback, message: safe, retryable: defaultRetryable(fallback), code };
}

function isKnownKind(kind: string): kind is NormalizedRuntimeErrorKind {
  return [
    "authentication_failed",
    "quota_exceeded",
    "not_logged_in",
    "timeout",
    "process_exit",
    "protocol_error",
    "user_cancel",
    "model_unavailable",
    "network_failed",
    "unknown"
  ].includes(kind);
}

function defaultRetryable(kind: NormalizedRuntimeErrorKind): boolean {
  return kind !== "protocol_error" && kind !== "user_cancel";
}
