/**
 * Multi-turn API Professional Agent tool loop (Task 23).
 *
 * The loop is harness-agnostic: the host supplies model invocation and tool
 * implementations. Limits on turns, tokens, wall-clock time, and output size
 * prevent unbounded iteration.
 */

import type { ModelMessage } from "../model/types.js";

// ── Tool contract (local stub until apps/service tools module lands) ─────────

export type ToolRisk = "read" | "write" | "shell" | "network" | "dangerous";

export interface ToolResult {
  ok: boolean;
  /** Compact summary fed back to the next model turn (never secrets). */
  summary: string;
  /** Optional structured payload for artifact/evidence registration. */
  data?: unknown;
  /** Truncated when exceeding maxOutputBytes. */
  truncated?: boolean;
  /** When set, the loop pauses for user confirmation instead of continuing. */
  needsApproval?: {
    kind: string;
    summary: string;
  };
  /** When set, the loop raises structured AskUser / AskReplan. */
  needsUserInput?: {
    kind: "ask_user" | "ask_replan";
    prompt: string;
    reason: string;
    options?: Array<{ id: string; label: string }>;
  };
  /** Artifacts produced by this tool call. */
  artifacts?: Array<{ path: string; kind: string; summary?: string }>;
}

export interface ToolContext {
  runId: string;
  workspacePath: string;
  signal: AbortSignal;
  /** Remaining output budget for this call (bytes). */
  maxOutputBytes: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  risk: ToolRisk;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ── Agent turn protocol ──────────────────────────────────────────────────────

export type AgentTurnKind = "tool_call" | "final" | "ask_user" | "ask_approval" | "ask_replan";

export interface AgentToolCallTurn {
  type: "tool_call";
  tool: string;
  toolCallId?: string;
  arguments: Record<string, unknown>;
}

export interface AgentFinalTurn {
  type: "final";
  summary: string;
  /** Legacy single-shot write actions still accepted. */
  actions?: Array<Record<string, unknown>>;
}

export interface AgentAskUserTurn {
  type: "ask_user";
  prompt: string;
  reason: string;
  options?: Array<{ id?: string; label: string }>;
}

export interface AgentAskApprovalTurn {
  type: "ask_approval";
  kind: string;
  summary: string;
  arguments?: Record<string, unknown>;
}

export interface AgentAskReplanTurn {
  type: "ask_replan";
  prompt: string;
  reason: string;
}

export type AgentTurn =
  | AgentToolCallTurn
  | AgentFinalTurn
  | AgentAskUserTurn
  | AgentAskApprovalTurn
  | AgentAskReplanTurn;

// ── Limits ───────────────────────────────────────────────────────────────────

export interface ToolLoopLimits {
  /** Max model turns (each model response counts as one). */
  maxTurns: number;
  /** Soft token budget across all model usage reports. */
  maxTokens: number;
  /** Wall-clock budget for the entire loop (ms). */
  maxDurationMs: number;
  /** Max bytes of tool output kept in the conversation summary. */
  maxOutputBytes: number;
}

export const DEFAULT_TOOL_LOOP_LIMITS: ToolLoopLimits = {
  maxTurns: 12,
  maxTokens: 100_000,
  maxDurationMs: 5 * 60_000,
  maxOutputBytes: 32_000
};

// ── Host / events ────────────────────────────────────────────────────────────

export interface ModelTurnResult {
  content: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface ToolLoopHost {
  runId: string;
  workspacePath: string;
  tools: Map<string, ToolDefinition> | ToolDefinition[];
  limits?: Partial<ToolLoopLimits>;
  signal: AbortSignal;
  /**
   * Invoke the model with a compact message list (system + necessary context only).
   * Host is responsible for Role/connection selection and secret hygiene.
   */
  invokeModel(messages: ModelMessage[], signal: AbortSignal): Promise<ModelTurnResult>;
  /** Optional clock for tests. */
  now?: () => number;
  /** Observability hooks (logging / timeline). */
  onEvent?: (event: ToolLoopEvent) => void | Promise<void>;
}

export type ToolLoopEvent =
  | { kind: "turn_start"; turn: number }
  | { kind: "model_response"; turn: number; contentSummary: string; usage?: ModelTurnResult["usage"] }
  | { kind: "tool_request"; turn: number; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
  | { kind: "tool_result"; turn: number; toolCallId: string; toolName: string; ok: boolean; summary: string }
  | { kind: "artifact"; path: string; artifactKind: string; summary?: string }
  | { kind: "limit"; limit: "turns" | "tokens" | "time" | "output"; message: string }
  | { kind: "paused"; reason: "ask_user" | "ask_approval" | "ask_replan" | "approval"; detail: string };

export type ToolLoopStatus =
  | "completed"
  | "paused_approval"
  | "paused_ask_user"
  | "paused_ask_replan"
  | "failed_limit"
  | "failed"
  | "interrupted";

export interface ToolLoopResult {
  status: ToolLoopStatus;
  summary: string;
  turns: number;
  totalTokens: number;
  /** Sum of API-reported or estimated prompt tokens across turns. */
  promptTokens: number;
  /** Sum of API-reported or estimated completion tokens across turns. */
  completionTokens: number;
  /** True when any turn fell back to content-length estimation. */
  tokensEstimated: boolean;
  durationMs: number;
  /** Final agent summary when status is completed. */
  finalSummary?: string;
  /** Legacy actions from a final turn (host may still execute them). */
  finalActions?: Array<Record<string, unknown>>;
  /** Pause payloads */
  approval?: { kind: string; summary: string };
  askUser?: {
    kind: "ask_user" | "ask_replan";
    prompt: string;
    reason: string;
    options?: Array<{ id: string; label: string }>;
  };
  /** Tool transcripts for evidence (summaries only). */
  toolTrace: Array<{
    toolCallId: string;
    toolName: string;
    ok: boolean;
    summary: string;
  }>;
  artifacts: Array<{ path: string; kind: string; summary?: string }>;
  error?: string;
}

export interface ToolLoopSeed {
  /** Compact system instruction (role + tool inventory). */
  systemInstruction: string;
  /** Initial user task payload (plan, checkpoint, constraints) — not the whole repo. */
  taskPayload: string;
  /** Prior tool results reconstructed after retry/interrupt (summaries only). */
  priorToolSummaries?: string[];
}

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse model output into a structured AgentTurn.
 * Accepts:
 * - multi-turn: { type: "tool_call" | "final" | "ask_*", ... }
 * - legacy single-shot: { summary, actions: [...] } → final
 */
export function parseAgentTurn(raw: string): AgentTurn {
  const candidate = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("Professional Agent output must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Professional Agent output must be a JSON object.");
  }
  const obj = parsed as Record<string, unknown>;

  // Legacy single-shot { summary, actions }
  if (obj.type === undefined && typeof obj.summary === "string") {
    if (!Array.isArray(obj.actions)) {
      throw new Error("Professional Agent final output needs a summary and actions array (or type:final).");
    }
    return {
      type: "final",
      summary: obj.summary.trim(),
      actions: obj.actions as Array<Record<string, unknown>>
    };
  }

  const type = typeof obj.type === "string" ? obj.type.trim() : "";
  if (type === "tool_call" || type === "tool") {
    const tool = typeof obj.tool === "string" ? obj.tool.trim()
      : typeof obj.name === "string" ? obj.name.trim()
        : "";
    if (!tool) throw new Error("tool_call requires a tool name.");
    const args = (obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments))
      ? obj.arguments as Record<string, unknown>
      : (obj.args && typeof obj.args === "object" && !Array.isArray(obj.args))
        ? obj.args as Record<string, unknown>
        : {};
    return {
      type: "tool_call",
      tool,
      toolCallId: typeof obj.toolCallId === "string" ? obj.toolCallId.trim() : undefined,
      arguments: args
    };
  }

  if (type === "final" || type === "complete" || type === "done") {
    if (typeof obj.summary !== "string" || !obj.summary.trim()) {
      throw new Error("final turn needs a non-empty summary.");
    }
    return {
      type: "final",
      summary: obj.summary.trim(),
      actions: Array.isArray(obj.actions) ? obj.actions as Array<Record<string, unknown>> : undefined
    };
  }

  if (type === "ask_user") {
    const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : "Agent needs more information.";
    if (!prompt) throw new Error("ask_user requires a prompt.");
    return {
      type: "ask_user",
      prompt,
      reason,
      options: Array.isArray(obj.options)
        ? obj.options.map((option, index) => {
          if (typeof option === "string") return { id: `opt-${index + 1}`, label: option };
          if (option && typeof option === "object" && typeof (option as { label?: unknown }).label === "string") {
            const entry = option as { id?: string; label: string };
            return { id: entry.id, label: entry.label };
          }
          throw new Error("ask_user options must be strings or {id,label} objects.");
        })
        : undefined
    };
  }

  if (type === "ask_approval") {
    const kind = typeof obj.kind === "string" ? obj.kind.trim() : "unsupported_operation";
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (!summary) throw new Error("ask_approval requires a summary.");
    return {
      type: "ask_approval",
      kind,
      summary,
      arguments: (obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments))
        ? obj.arguments as Record<string, unknown>
        : undefined
    };
  }

  if (type === "ask_replan") {
    const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "Plan revision required.";
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : "Agent cannot continue under the current plan.";
    return { type: "ask_replan", prompt, reason };
  }

  throw new Error(`Unknown Professional Agent turn type: ${type || "(missing)"}`);
}

// ── Loop engine ──────────────────────────────────────────────────────────────

export async function runToolLoop(host: ToolLoopHost, seed: ToolLoopSeed): Promise<ToolLoopResult> {
  const limits: ToolLoopLimits = { ...DEFAULT_TOOL_LOOP_LIMITS, ...host.limits };
  const tools = normalizeToolMap(host.tools);
  const now = host.now ?? (() => Date.now());
  const startedAt = now();
  const toolTrace: ToolLoopResult["toolTrace"] = [];
  const artifacts: ToolLoopResult["artifacts"] = [];
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let tokensEstimated = false;
  let turns = 0;
  let toolCallCounter = 0;

  const history: Array<{ role: "assistant" | "user"; content: string }> = [];
  if (seed.priorToolSummaries?.length) {
    history.push({
      role: "user",
      content: `Prior tool results (checkpoint rebuild, summaries only):\n${seed.priorToolSummaries.join("\n")}`
    });
  }

  const emit = async (event: ToolLoopEvent): Promise<void> => {
    if (host.onEvent) await host.onEvent(event);
  };

  try {
    while (true) {
      if (host.signal.aborted) {
        return {
          status: "interrupted",
          summary: "Professional Agent tool loop was interrupted.",
          turns,
          totalTokens,
          promptTokens,
          completionTokens,
          tokensEstimated,
          durationMs: now() - startedAt,
          toolTrace,
          artifacts,
          error: "Professional Agent request was interrupted."
        };
      }

      const elapsed = now() - startedAt;
      if (elapsed >= limits.maxDurationMs) {
        const message = `Tool loop exceeded time limit (${limits.maxDurationMs}ms).`;
        await emit({ kind: "limit", limit: "time", message });
        return failLimit(message, turns, totalTokens, promptTokens, completionTokens, tokensEstimated, elapsed, toolTrace, artifacts);
      }

      if (turns >= limits.maxTurns) {
        const message = `Tool loop exceeded max turns (${limits.maxTurns}).`;
        await emit({ kind: "limit", limit: "turns", message });
        return failLimit(message, turns, totalTokens, promptTokens, completionTokens, tokensEstimated, elapsed, toolTrace, artifacts);
      }

      if (totalTokens >= limits.maxTokens) {
        const message = `Tool loop exceeded token budget (${limits.maxTokens}).`;
        await emit({ kind: "limit", limit: "tokens", message });
        return failLimit(message, turns, totalTokens, promptTokens, completionTokens, tokensEstimated, elapsed, toolTrace, artifacts);
      }

      turns += 1;
      await emit({ kind: "turn_start", turn: turns });

      const messages = buildCompactMessages(seed, history, tools);
      const modelResult = await host.invokeModel(messages, host.signal);
      const turnUsage = measureTurnUsage(modelResult);
      totalTokens += turnUsage.totalTokens;
      promptTokens += turnUsage.promptTokens;
      completionTokens += turnUsage.completionTokens;
      if (turnUsage.estimated) tokensEstimated = true;
      await emit({
        kind: "model_response",
        turn: turns,
        contentSummary: clip(modelResult.content, 300),
        usage: modelResult.usage ?? {
          promptTokens: turnUsage.promptTokens,
          completionTokens: turnUsage.completionTokens,
          totalTokens: turnUsage.totalTokens
        }
      });

      if (totalTokens >= limits.maxTokens) {
        const message = `Tool loop exceeded token budget (${limits.maxTokens}).`;
        await emit({ kind: "limit", limit: "tokens", message });
        return failLimit(message, turns, totalTokens, promptTokens, completionTokens, tokensEstimated, now() - startedAt, toolTrace, artifacts);
      }

      let turn: AgentTurn;
      try {
        turn = parseAgentTurn(modelResult.content);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid agent turn.";
        return {
          status: "failed",
          summary: message,
          turns,
          totalTokens,
          promptTokens,
          completionTokens,
          tokensEstimated,
          durationMs: now() - startedAt,
          toolTrace,
          artifacts,
          error: message
        };
      }

      if (turn.type === "final") {
        return {
          status: "completed",
          summary: turn.summary,
          finalSummary: turn.summary,
          finalActions: turn.actions,
          turns,
          totalTokens,
          promptTokens,
          completionTokens,
          tokensEstimated,
          durationMs: now() - startedAt,
          toolTrace,
          artifacts
        };
      }

      if (turn.type === "ask_user") {
        await emit({ kind: "paused", reason: "ask_user", detail: turn.prompt });
        return {
          status: "paused_ask_user",
          summary: turn.prompt,
          turns,
          totalTokens,
          promptTokens,
          completionTokens,
          tokensEstimated,
          durationMs: now() - startedAt,
          toolTrace,
          artifacts,
          askUser: {
            kind: "ask_user",
            prompt: turn.prompt,
            reason: turn.reason,
            options: turn.options?.map((option, index) => ({
              id: option.id?.trim() || `opt-${index + 1}`,
              label: option.label
            }))
          }
        };
      }

      if (turn.type === "ask_replan") {
        await emit({ kind: "paused", reason: "ask_replan", detail: turn.prompt });
        return {
          status: "paused_ask_replan",
          summary: turn.prompt,
          turns,
          totalTokens,
          promptTokens,
          completionTokens,
          tokensEstimated,
          durationMs: now() - startedAt,
          toolTrace,
          artifacts,
          askUser: {
            kind: "ask_replan",
            prompt: turn.prompt,
            reason: turn.reason
          }
        };
      }

      if (turn.type === "ask_approval") {
        await emit({ kind: "paused", reason: "ask_approval", detail: turn.summary });
        return {
          status: "paused_approval",
          summary: turn.summary,
          turns,
          totalTokens,
          promptTokens,
          completionTokens,
          tokensEstimated,
          durationMs: now() - startedAt,
          toolTrace,
          artifacts,
          approval: { kind: turn.kind, summary: turn.summary }
        };
      }

      // tool_call
      const toolName = turn.tool;
      const tool = tools.get(toolName);
      toolCallCounter += 1;
      const toolCallId = turn.toolCallId?.trim() || `call-${turns}-${toolCallCounter}`;
      await emit({
        kind: "tool_request",
        turn: turns,
        toolCallId,
        toolName,
        arguments: turn.arguments
      });

      history.push({
        role: "assistant",
        content: JSON.stringify({
          type: "tool_call",
          tool: toolName,
          toolCallId,
          arguments: redactArgsForHistory(turn.arguments)
        })
      });

      if (!tool) {
        const summary = `Unknown or unauthorized tool: ${toolName}`;
        await emit({ kind: "tool_result", turn: turns, toolCallId, toolName, ok: false, summary });
        toolTrace.push({ toolCallId, toolName, ok: false, summary });
        history.push({
          role: "user",
          content: toolResultMessage(toolCallId, toolName, false, summary)
        });
        continue;
      }

      if (host.signal.aborted) {
        return {
          status: "interrupted",
          summary: "Professional Agent tool loop was interrupted.",
          turns,
          totalTokens,
          promptTokens,
          completionTokens,
          tokensEstimated,
          durationMs: now() - startedAt,
          toolTrace,
          artifacts,
          error: "Professional Agent request was interrupted."
        };
      }

      let result: ToolResult;
      try {
        result = await tool.execute(turn.arguments, {
          runId: host.runId,
          workspacePath: host.workspacePath,
          signal: host.signal,
          maxOutputBytes: limits.maxOutputBytes
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool execution failed.";
        result = { ok: false, summary: message };
      }

      const clipped = clipToolResult(result, limits.maxOutputBytes);
      if (clipped.truncated) {
        await emit({
          kind: "limit",
          limit: "output",
          message: `Tool ${toolName} output truncated to ${limits.maxOutputBytes} bytes.`
        });
      }

      await emit({
        kind: "tool_result",
        turn: turns,
        toolCallId,
        toolName,
        ok: clipped.ok,
        summary: clipped.summary
      });
      toolTrace.push({
        toolCallId,
        toolName,
        ok: clipped.ok,
        summary: clipped.summary
      });

      for (const artifact of clipped.artifacts ?? []) {
        artifacts.push(artifact);
        await emit({
          kind: "artifact",
          path: artifact.path,
          artifactKind: artifact.kind,
          summary: artifact.summary
        });
      }

      if (clipped.needsApproval) {
        await emit({ kind: "paused", reason: "approval", detail: clipped.needsApproval.summary });
        history.push({
          role: "user",
          content: toolResultMessage(toolCallId, toolName, false, clipped.needsApproval.summary)
        });
        return {
          status: "paused_approval",
          summary: clipped.needsApproval.summary,
          turns,
          totalTokens,
          promptTokens,
          completionTokens,
          tokensEstimated,
          durationMs: now() - startedAt,
          toolTrace,
          artifacts,
          approval: clipped.needsApproval
        };
      }

      if (clipped.needsUserInput) {
        await emit({
          kind: "paused",
          reason: clipped.needsUserInput.kind,
          detail: clipped.needsUserInput.prompt
        });
        return {
          status: clipped.needsUserInput.kind === "ask_replan" ? "paused_ask_replan" : "paused_ask_user",
          summary: clipped.needsUserInput.prompt,
          turns,
          totalTokens,
          promptTokens,
          completionTokens,
          tokensEstimated,
          durationMs: now() - startedAt,
          toolTrace,
          artifacts,
          askUser: clipped.needsUserInput
        };
      }

      history.push({
        role: "user",
        content: toolResultMessage(toolCallId, toolName, clipped.ok, clipped.summary)
      });

      // Bound history growth: keep only the latest N tool exchanges in full form.
      compactHistory(history, 8);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool loop failed.";
    if (host.signal.aborted || /interrupt|abort|cancel/i.test(message)) {
      return {
        status: "interrupted",
        summary: message,
        turns,
        totalTokens,
        promptTokens,
        completionTokens,
        tokensEstimated,
        durationMs: now() - startedAt,
        toolTrace,
        artifacts,
        error: message
      };
    }
    return {
      status: "failed",
      summary: message,
      turns,
      totalTokens,
      promptTokens,
      completionTokens,
      tokensEstimated,
      durationMs: now() - startedAt,
      toolTrace,
      artifacts,
      error: message
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeToolMap(tools: Map<string, ToolDefinition> | ToolDefinition[]): Map<string, ToolDefinition> {
  if (tools instanceof Map) return tools;
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function buildCompactMessages(
  seed: ToolLoopSeed,
  history: Array<{ role: "assistant" | "user"; content: string }>,
  tools: Map<string, ToolDefinition>
): ModelMessage[] {
  const toolCatalog = [...tools.values()]
    .map((tool) => `- ${tool.name} [${tool.risk}]: ${tool.description}`)
    .join("\n");

  const system = [
    seed.systemInstruction,
    "",
    "You are in a multi-turn controlled tool loop. Respond with JSON only.",
    "Turn types:",
    '{"type":"tool_call","tool":"<name>","arguments":{...}}',
    '{"type":"final","summary":"...","actions":[...optional legacy write_file actions...]}',
    '{"type":"ask_user","prompt":"...","reason":"...","options":[{"id":"a","label":"..."}]}',
    '{"type":"ask_approval","kind":"...","summary":"..."}',
    '{"type":"ask_replan","prompt":"...","reason":"..."}',
    "",
    "Available tools:",
    toolCatalog || "(none)",
    "",
    "Rules:",
    "- Prefer reading/searching before writing.",
    "- Do not request shell/network/delete unless authorized.",
    "- Keep arguments minimal; never load the entire repository into one response.",
    "- When done, emit type:final with a short summary."
  ].join("\n");

  const messages: ModelMessage[] = [
    { role: "system", content: system },
    { role: "user", content: seed.taskPayload }
  ];
  for (const entry of history) {
    messages.push({ role: entry.role, content: entry.content });
  }
  return messages;
}

function toolResultMessage(toolCallId: string, toolName: string, ok: boolean, summary: string): string {
  return JSON.stringify({
    type: "tool_result",
    toolCallId,
    tool: toolName,
    ok,
    summary
  });
}

function clipToolResult(result: ToolResult, maxOutputBytes: number): ToolResult {
  const summary = result.summary ?? "";
  const bytes = Buffer.byteLength(summary, "utf8");
  if (bytes <= maxOutputBytes) return result;
  const clipped = Buffer.from(summary, "utf8").subarray(0, maxOutputBytes).toString("utf8");
  return {
    ...result,
    summary: `${clipped}\n…[truncated ${bytes - maxOutputBytes} bytes]`,
    truncated: true
  };
}

function compactHistory(
  history: Array<{ role: "assistant" | "user"; content: string }>,
  keepPairs: number
): void {
  // Each tool exchange is assistant+user (2 entries). Keep last keepPairs exchanges.
  const maxEntries = keepPairs * 2;
  if (history.length <= maxEntries) return;
  const dropped = history.length - maxEntries;
  history.splice(0, dropped);
  history.unshift({
    role: "user",
    content: `[${dropped} earlier tool-loop messages compacted; continue from latest tool results only.]`
  });
}

function redactArgsForHistory(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 500) {
      out[key] = `${value.slice(0, 500)}…[truncated]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function measureTurnUsage(result: ModelTurnResult): {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
} {
  const prompt = Math.max(0, result.usage?.promptTokens ?? 0);
  const completion = Math.max(0, result.usage?.completionTokens ?? 0);
  if (result.usage?.totalTokens && result.usage.totalTokens > 0) {
    return {
      totalTokens: result.usage.totalTokens,
      promptTokens: prompt > 0 ? prompt : result.usage.totalTokens,
      completionTokens: completion,
      estimated: prompt <= 0 && completion <= 0
    };
  }
  if (prompt + completion > 0) {
    return {
      totalTokens: prompt + completion,
      promptTokens: prompt,
      completionTokens: completion,
      estimated: false
    };
  }
  // Rough fallback: ~4 chars per token on content only.
  const estimated = Math.max(1, Math.ceil(result.content.length / 4));
  return {
    totalTokens: estimated,
    promptTokens: estimated,
    completionTokens: 0,
    estimated: true
  };
}

function failLimit(
  message: string,
  turns: number,
  totalTokens: number,
  promptTokens: number,
  completionTokens: number,
  tokensEstimated: boolean,
  durationMs: number,
  toolTrace: ToolLoopResult["toolTrace"],
  artifacts: ToolLoopResult["artifacts"]
): ToolLoopResult {
  return {
    status: "failed_limit",
    summary: message,
    turns,
    totalTokens,
    promptTokens,
    completionTokens,
    tokensEstimated,
    durationMs,
    toolTrace,
    artifacts,
    error: message
  };
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

/** Build a stable tool map from definitions (helper for hosts). */
export function toolMapOf(...definitions: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(definitions.map((tool) => [tool.name, tool]));
}
