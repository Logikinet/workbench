/**
 * MCP tool policy: size limits, risk classification, permission inheritance,
 * redaction helpers for logs.
 */

import { redactJsonValue, redactSecrets } from "../model/redact.js";
import type {
  McpCallErrorKind,
  McpToolDescriptor,
  McpToolRisk,
  RolePermissionsLike
} from "./mcpTypes.js";
import {
  MCP_MAX_ARGS_BYTES,
  MCP_MAX_LOG_SNIPPET,
  MCP_MAX_RESULT_BYTES
} from "./mcpTypes.js";

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function measureJsonBytes(value: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(value) ?? "null");
  } catch {
    return utf8ByteLength(String(value));
  }
}

export function assertArgsWithinLimit(args: Record<string, unknown>): void {
  const bytes = measureJsonBytes(args);
  if (bytes > MCP_MAX_ARGS_BYTES) {
    const error = new McpPolicyError(
      `Tool arguments exceed size limit (${bytes} > ${MCP_MAX_ARGS_BYTES} bytes).`,
      "args_too_large"
    );
    throw error;
  }
}

export interface BoundedResult {
  content: unknown;
  resultBytes: number;
  truncated: boolean;
}

export function boundResult(content: unknown, maxBytes = MCP_MAX_RESULT_BYTES): BoundedResult {
  const resultBytes = measureJsonBytes(content);
  if (resultBytes <= maxBytes) {
    return { content: redactJsonValue(content), resultBytes, truncated: false };
  }
  // Truncate string representation for safety
  const raw = safeStringify(content);
  const truncatedText = raw.slice(0, Math.max(0, maxBytes - 64));
  return {
    content: {
      truncated: true,
      preview: redactSecrets(truncatedText),
      originalBytes: resultBytes,
      maxBytes
    },
    resultBytes,
    truncated: true
  };
}

export function redactForLog(value: unknown): unknown {
  if (typeof value === "string") {
    const redacted = redactSecrets(value);
    return redacted.length > MCP_MAX_LOG_SNIPPET
      ? `${redacted.slice(0, MCP_MAX_LOG_SNIPPET)}…`
      : redacted;
  }
  return redactJsonValue(value);
}

export function classifyToolRisk(tool: McpToolDescriptor): McpToolRisk {
  if (tool.risk) return tool.risk;
  const name = tool.name.toLowerCase();
  const description = (tool.description ?? "").toLowerCase();
  const blob = `${name} ${description}`;
  if (/\b(shell|exec|spawn|powershell|cmd|bash|terminal)\b/.test(blob)) return "shell";
  if (/\b(delete|rm\b|destroy|drop|format|danger|sudo|admin)\b/.test(blob)) return "dangerous";
  if (/\b(http|fetch|web|network|url|request|download|upload)\b/.test(blob)) return "network";
  if (/\b(write|create|update|edit|patch|put|mkdir|move|rename)\b/.test(blob)) return "write";
  return "read";
}

/**
 * MCP tools inherit Role workspace / network / shell / dangerous-op rules.
 * Returns a denial reason or undefined when allowed.
 */
export function checkToolPermissions(
  tool: McpToolDescriptor,
  permissions: RolePermissionsLike | undefined,
  options: { approvedDangerous?: boolean } = {}
): string | undefined {
  const risk = classifyToolRisk(tool);

  if (!permissions) {
    // No role permissions attached: allow read-only tools only.
    if (risk === "read") return undefined;
    return "缺少角色权限上下文；仅允许只读 MCP 工具。";
  }

  if (risk === "shell" && !permissions.shell) {
    return "当前角色未授予 Shell 权限，无法调用该 MCP 工具。";
  }
  if (risk === "network" && !permissions.network) {
    return "当前角色未授予网络权限，无法调用该 MCP 工具。";
  }
  if (risk === "write" && permissions.workspace === "read_only") {
    return "当前角色工作区为只读，无法调用写入类 MCP 工具。";
  }
  if (risk === "dangerous") {
    if (!permissions.shell && !permissions.externalSend) {
      return "当前角色未授予危险操作相关权限，无法调用该 MCP 工具。";
    }
    if (!options.approvedDangerous) {
      return "危险 MCP 工具需要用户审批后才能执行。";
    }
  }
  return undefined;
}

export function normalizeCallError(error: unknown): { kind: McpCallErrorKind; message: string; pauseRelatedSubtasks: boolean } {
  if (error instanceof McpPolicyError) {
    return {
      kind: error.kind,
      message: redactSecrets(error.message),
      pauseRelatedSubtasks: error.kind === "unavailable" || error.kind === "timeout"
    };
  }
  // Detect McpClientUnavailableError without hard import cycle risk
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error as Error).name === "McpClientUnavailableError"
  ) {
    return {
      kind: "unavailable",
      message: redactSecrets((error as Error).message) || "MCP Server 不可用。",
      pauseRelatedSubtasks: true
    };
  }
  if (error && typeof error === "object" && "name" in error && (error as Error).name === "AbortError") {
    return {
      kind: "cancelled",
      message: "MCP 工具调用已取消。",
      pauseRelatedSubtasks: false
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("unauthorized") || lower.includes("authentication") || lower.includes("401") || lower.includes("403")) {
    return {
      kind: "unavailable",
      message: redactSecrets(message) || "MCP 认证失败。",
      pauseRelatedSubtasks: true
    };
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("unavailable") ||
    lower.includes("mcp process") ||
    lower.includes("server is closed") ||
    lower.includes("server is unavailable")
  ) {
    return {
      kind: "unavailable",
      message: redactSecrets(message) || "MCP Server 不可用。",
      pauseRelatedSubtasks: true
    };
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
    // Abort from our timeout path is handled separately; leftover aborts map to timeout when not cancelled by user.
    if ((error as Error)?.name === "AbortError") {
      return {
        kind: "timeout",
        message: "MCP 工具调用超时。",
        pauseRelatedSubtasks: true
      };
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return {
        kind: "timeout",
        message: "MCP 工具调用超时。",
        pauseRelatedSubtasks: true
      };
    }
  }
  if (lower.includes("unknown tool") || lower.includes("not found")) {
    return {
      kind: "not_found",
      message: redactSecrets(message),
      pauseRelatedSubtasks: false
    };
  }
  return {
    kind: "tool_error",
    message: redactSecrets(message) || "MCP 工具调用失败。",
    pauseRelatedSubtasks: false
  };
}

export class McpPolicyError extends Error {
  readonly kind: McpCallErrorKind;

  constructor(message: string, kind: McpCallErrorKind) {
    super(message);
    this.name = "McpPolicyError";
    this.kind = kind;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
