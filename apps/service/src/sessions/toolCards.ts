/**
 * Pure Tool Card helpers (Task 41).
 * Builds ACP-inspired tool cards from tool_request / tool_result / tool_update events.
 */

import { redactJsonValue, redactSecrets } from "../model/redact.js";
import {
  LONG_LOG_COLLAPSE_CHARS,
  MAX_ARGS_SUMMARY_CHARS,
  MAX_LOG_BODY_CHARS,
  MAX_OUTPUT_SUMMARY_CHARS,
  type ArtifactLink,
  type EvidenceLink,
  type SessionCard,
  type ToolCardPayload,
  type ToolCardPermission,
  type ToolCardStatus
} from "./sessionTypes.js";

const PERMISSIONS: readonly ToolCardPermission[] = [
  "readonly",
  "write",
  "shell",
  "network",
  "dangerous",
  "unknown"
];

/** Infer a permission category from tool name heuristics when not provided. */
export function inferToolPermission(toolName: string): ToolCardPermission {
  const name = toolName.trim().toLowerCase();
  if (!name) return "unknown";
  if (/(danger|rm\b|delete|format|drop|exec)/i.test(name)) return "dangerous";
  if (/(shell|bash|cmd|terminal|powershell|pwsh)/i.test(name)) return "shell";
  if (/(http|fetch|web|network|browser|url)/i.test(name)) return "network";
  if (/(write|edit|patch|create|apply|filesystem|fs_write)/i.test(name)) return "write";
  if (/(read|list|glob|search|cat|open|stat)/i.test(name)) return "readonly";
  return "unknown";
}

export function isToolCardPermission(value: unknown): value is ToolCardPermission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** Compact redacted argument summary for Tool Card list rows. */
export function summarizeArguments(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "(no args)";
  const redacted = redactJsonValue(args);
  let text: string;
  try {
    text = JSON.stringify(redacted);
  } catch {
    text = String(redacted);
  }
  return truncate(text, MAX_ARGS_SUMMARY_CHARS);
}

export function summarizeOutput(text: string | undefined): string {
  if (!text?.trim()) return "";
  return truncate(redactSecrets(text.trim()), MAX_OUTPUT_SUMMARY_CHARS);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function maybeTruncateLogBody(text: string): { body: string; truncated: boolean; collapsed: boolean } {
  const redacted = redactSecrets(text);
  if (redacted.length <= LONG_LOG_COLLAPSE_CHARS) {
    return { body: redacted, truncated: false, collapsed: false };
  }
  if (redacted.length <= MAX_LOG_BODY_CHARS) {
    return { body: redacted, truncated: false, collapsed: true };
  }
  return {
    body: `${redacted.slice(0, MAX_LOG_BODY_CHARS)}\n…[truncated ${redacted.length - MAX_LOG_BODY_CHARS} chars]`,
    truncated: true,
    collapsed: true
  };
}

export interface CreateToolCardInput {
  toolCallId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  permission?: ToolCardPermission;
  title?: string;
  status?: ToolCardStatus;
  startedAt?: string;
}

/** Create a new ToolCardPayload from a tool_request. */
export function createToolCardPayload(input: CreateToolCardInput): ToolCardPayload {
  const toolName = input.toolName.trim() || "unknown";
  const permission =
    input.permission && isToolCardPermission(input.permission)
      ? input.permission
      : inferToolPermission(toolName);
  const args = input.arguments ? (redactJsonValue(input.arguments) as Record<string, unknown>) : undefined;
  return {
    toolCallId: input.toolCallId,
    toolName,
    title: (input.title?.trim() || toolName),
    argumentsSummary: summarizeArguments(args),
    arguments: args,
    permission,
    status: input.status ?? "pending",
    startedAt: input.startedAt,
    artifactLinks: [],
    evidenceLinks: []
  };
}

export interface ApplyToolResultInput {
  ok: boolean;
  resultSummary: string;
  durationMs?: number;
  completedAt?: string;
  artifacts?: ArtifactLink[];
  evidence?: EvidenceLink[];
}

/** Fold a tool_result into an existing tool payload. */
export function applyToolResult(payload: ToolCardPayload, input: ApplyToolResultInput): ToolCardPayload {
  const completedAt = input.completedAt ?? new Date().toISOString();
  let durationMs = input.durationMs;
  if (durationMs === undefined && payload.startedAt) {
    const start = Date.parse(payload.startedAt);
    const end = Date.parse(completedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      durationMs = end - start;
    }
  }
  return {
    ...payload,
    status: input.ok ? "completed" : "failed",
    ok: input.ok,
    outputSummary: summarizeOutput(input.resultSummary),
    completedAt,
    durationMs,
    artifactLinks: mergeArtifacts(payload.artifactLinks, input.artifacts),
    evidenceLinks: mergeEvidence(payload.evidenceLinks, input.evidence)
  };
}

export interface ApplyToolUpdateInput {
  status?: ToolCardStatus;
  outputSummary?: string;
  title?: string;
}

export function applyToolUpdate(payload: ToolCardPayload, input: ApplyToolUpdateInput): ToolCardPayload {
  return {
    ...payload,
    status: input.status ?? payload.status,
    outputSummary:
      input.outputSummary !== undefined ? summarizeOutput(input.outputSummary) : payload.outputSummary,
    title: input.title?.trim() || payload.title
  };
}

/** Compact a card for virtualized list responses (strip heavy bodies). */
export function compactCard(card: SessionCard): SessionCard {
  const next: SessionCard = { ...card };
  if (next.logBody && next.logBody.length > LONG_LOG_COLLAPSE_CHARS) {
    next.collapsed = true;
    next.logBody = undefined;
    if (!next.summary) {
      next.summary = truncate(card.logBody ?? card.summary, 160);
    }
  }
  if (next.text && next.text.length > LONG_LOG_COLLAPSE_CHARS) {
    next.collapsed = true;
    next.text = truncate(next.text, LONG_LOG_COLLAPSE_CHARS);
  }
  if (next.tool?.arguments) {
    next.tool = {
      ...next.tool,
      arguments: undefined
    };
  }
  return next;
}

/** Human-readable one-line summary for a tool card. */
export function toolCardSummary(payload: ToolCardPayload): string {
  const status = payload.status;
  const duration =
    payload.durationMs !== undefined ? ` · ${formatDuration(payload.durationMs)}` : "";
  const out = payload.outputSummary ? ` → ${truncate(payload.outputSummary, 80)}` : "";
  return `${payload.toolName} [${status}/${payload.permission}]${duration}${out}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function mergeArtifacts(existing: ArtifactLink[], incoming?: ArtifactLink[]): ArtifactLink[] {
  if (!incoming?.length) return existing;
  const map = new Map(existing.map((entry) => [entry.path, entry]));
  for (const entry of incoming) {
    map.set(entry.path, {
      path: entry.path,
      kind: entry.kind,
      summary: entry.summary ? redactSecrets(entry.summary) : undefined
    });
  }
  return [...map.values()];
}

function mergeEvidence(existing: EvidenceLink[], incoming?: EvidenceLink[]): EvidenceLink[] {
  if (!incoming?.length) return existing;
  const map = new Map(existing.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    map.set(entry.id, {
      id: entry.id,
      summary: redactSecrets(entry.summary),
      path: entry.path
    });
  }
  return [...map.values()];
}
