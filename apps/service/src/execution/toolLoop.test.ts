import { describe, expect, it, vi } from "vitest";
import { FakeModelProvider } from "../model/fakeProvider.js";
import type { ModelMessage, ModelProviderRequest } from "../model/types.js";
import { createFakeTools } from "./controlledTools.js";
import {
  DEFAULT_TOOL_LOOP_LIMITS,
  parseAgentTurn,
  runToolLoop,
  toolMapOf,
  type ToolLoopEvent,
  type ToolLoopHost
} from "./toolLoop.js";

function finalJson(summary: string, actions: unknown[] = [{ type: "write_file", path: "out.md", content: "ok" }]): string {
  return JSON.stringify({ summary, actions });
}

function toolCallJson(tool: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "tool_call", tool, arguments: args });
}

describe("parseAgentTurn", () => {
  it("accepts legacy single-shot summary+actions as final", () => {
    expect(parseAgentTurn(finalJson("done"))).toMatchObject({
      type: "final",
      summary: "done",
      actions: [expect.objectContaining({ type: "write_file" })]
    });
  });

  it("parses tool_call, ask_user, ask_approval, and ask_replan", () => {
    expect(parseAgentTurn(toolCallJson("read_file", { path: "a.ts" }))).toEqual({
      type: "tool_call",
      tool: "read_file",
      toolCallId: undefined,
      arguments: { path: "a.ts" }
    });
    expect(parseAgentTurn(JSON.stringify({
      type: "ask_user",
      prompt: "Which port?",
      reason: "missing input",
      options: ["3000", "8080"]
    }))).toMatchObject({ type: "ask_user", prompt: "Which port?" });
    expect(parseAgentTurn(JSON.stringify({
      type: "ask_approval",
      kind: "delete_file",
      summary: "delete tmp"
    }))).toMatchObject({ type: "ask_approval", kind: "delete_file" });
    expect(parseAgentTurn(JSON.stringify({
      type: "ask_replan",
      prompt: "Scope too large",
      reason: "plan gap"
    }))).toMatchObject({ type: "ask_replan", prompt: "Scope too large" });
  });
});

describe("runToolLoop", () => {
  it("completes a multi-turn read→write loop with FakeModelProvider and fake tools", async () => {
    const provider = new FakeModelProvider({
      successContents: [
        toolCallJson("read_file", { path: "src/a.ts" }),
        toolCallJson("write_file", { path: "src/a.ts", content: "fixed" }),
        JSON.stringify({ type: "final", summary: "patched after reading" })
      ]
    });
    const reads: string[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    const events: ToolLoopEvent[] = [];
    const tools = createFakeTools({
      read_file: (args) => {
        reads.push(String(args.path));
        return { ok: true, summary: `contents of ${args.path}: line1` };
      },
      write_file: (args) => {
        writes.push({ path: String(args.path), content: String(args.content) });
        return {
          ok: true,
          summary: `wrote ${args.path}`,
          artifacts: [{ path: String(args.path), kind: "file" }]
        };
      }
    });

    const host = hostWithProvider(provider, tools, events);
    const result = await runToolLoop(host, {
      systemInstruction: "You are a test agent.",
      taskPayload: JSON.stringify({ task: "fix a.ts" })
    });

    expect(result.status).toBe("completed");
    expect(result.turns).toBe(3);
    expect(reads).toEqual(["src/a.ts"]);
    expect(writes).toEqual([{ path: "src/a.ts", content: "fixed" }]);
    expect(result.artifacts).toEqual([expect.objectContaining({ path: "src/a.ts", kind: "file" })]);
    expect(result.toolTrace.map((entry) => entry.toolName)).toEqual(["read_file", "write_file"]);
    expect(provider.calls).toHaveLength(3);
    // Later turns include prior tool result summaries, not a full repo dump.
    const lastUser = provider.calls[2]!.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
    expect(lastUser).toContain("tool_result");
    expect(lastUser).not.toContain("ENTIRE_REPOSITORY_BLOB");
    expect(events.some((event) => event.kind === "tool_request")).toBe(true);
    expect(events.some((event) => event.kind === "tool_result")).toBe(true);
  });

  it("enforces turn, token, time, and output limits", async () => {
    const infinite = new FakeModelProvider({
      handler: async () => ({ content: toolCallJson("noop"), usage: { totalTokens: 1 } })
    });
    const tools = createFakeTools({
      noop: () => ({ ok: true, summary: "ok" })
    });
    const turnLimited = await runToolLoop(
      hostWithProvider(infinite, tools, [], { maxTurns: 3, maxTokens: 1_000_000, maxDurationMs: 60_000, maxOutputBytes: 1000 }),
      { systemInstruction: "sys", taskPayload: "task" }
    );
    expect(turnLimited.status).toBe("failed_limit");
    expect(turnLimited.error).toMatch(/max turns/i);

    const tokenProvider = new FakeModelProvider({
      handler: async () => ({ content: toolCallJson("noop"), usage: { totalTokens: 500 } })
    });
    const tokenLimited = await runToolLoop(
      hostWithProvider(tokenProvider, tools, [], { maxTurns: 20, maxTokens: 400, maxDurationMs: 60_000, maxOutputBytes: 1000 }),
      { systemInstruction: "sys", taskPayload: "task" }
    );
    expect(tokenLimited.status).toBe("failed_limit");
    expect(tokenLimited.error).toMatch(/token/i);

    let clock = 0;
    const timeProvider = new FakeModelProvider({
      handler: async () => {
        clock += 1000;
        return { content: toolCallJson("noop"), usage: { totalTokens: 1 } };
      }
    });
    const timeLimited = await runToolLoop(
      {
        ...hostWithProvider(timeProvider, tools, [], { maxTurns: 50, maxTokens: 1_000_000, maxDurationMs: 1500, maxOutputBytes: 1000 }),
        now: () => clock
      },
      { systemInstruction: "sys", taskPayload: "task" }
    );
    expect(timeLimited.status).toBe("failed_limit");
    expect(timeLimited.error).toMatch(/time limit/i);

    const fatProvider = new FakeModelProvider({
      successContents: [
        toolCallJson("fat"),
        JSON.stringify({ type: "final", summary: "done" })
      ]
    });
    const fatTools = createFakeTools({
      fat: () => ({ ok: true, summary: "x".repeat(5000) })
    });
    const fatEvents: ToolLoopEvent[] = [];
    const fatResult = await runToolLoop(
      hostWithProvider(fatProvider, fatTools, fatEvents, { maxTurns: 5, maxTokens: 1_000_000, maxDurationMs: 60_000, maxOutputBytes: 100 }),
      { systemInstruction: "sys", taskPayload: "task" }
    );
    expect(fatResult.status).toBe("completed");
    expect(fatResult.toolTrace[0]?.summary).toMatch(/truncated/i);
    expect(fatEvents.some((event) => event.kind === "limit" && event.limit === "output")).toBe(true);
  });

  it("pauses for AskApproval, AskUser, and AskReplan", async () => {
    const approvalProvider = new FakeModelProvider({
      successContent: JSON.stringify({ type: "ask_approval", kind: "delete_file", summary: "delete secrets" })
    });
    const approval = await runToolLoop(hostWithProvider(approvalProvider, [], []), {
      systemInstruction: "sys",
      taskPayload: "task"
    });
    expect(approval.status).toBe("paused_approval");
    expect(approval.approval).toEqual({ kind: "delete_file", summary: "delete secrets" });

    const toolApprovalProvider = new FakeModelProvider({
      successContent: toolCallJson("danger")
    });
    const dangerTools = createFakeTools({
      danger: () => ({
        ok: false,
        summary: "needs approval",
        needsApproval: { kind: "system_install", summary: "install pkg" }
      })
    });
    const toolApproval = await runToolLoop(hostWithProvider(toolApprovalProvider, dangerTools, []), {
      systemInstruction: "sys",
      taskPayload: "task"
    });
    expect(toolApproval.status).toBe("paused_approval");
    expect(toolApproval.approval?.kind).toBe("system_install");

    const askUser = await runToolLoop(
      hostWithProvider(new FakeModelProvider({
        successContent: JSON.stringify({ type: "ask_user", prompt: "API base URL?", reason: "missing config" })
      }), [], []),
      { systemInstruction: "sys", taskPayload: "task" }
    );
    expect(askUser.status).toBe("paused_ask_user");
    expect(askUser.askUser?.prompt).toBe("API base URL?");

    const replan = await runToolLoop(
      hostWithProvider(new FakeModelProvider({
        successContent: JSON.stringify({ type: "ask_replan", prompt: "Need broader scope", reason: "blocked" })
      }), [], []),
      { systemInstruction: "sys", taskPayload: "task" }
    );
    expect(replan.status).toBe("paused_ask_replan");
  });

  it("stops cleanly when the AbortSignal fires mid-loop", async () => {
    const controller = new AbortController();
    const provider = new FakeModelProvider({
      handler: async () => {
        controller.abort();
        return { content: toolCallJson("noop"), usage: { totalTokens: 1 } };
      }
    });
    const tools = createFakeTools({
      noop: async (_args, ctx) => {
        if (ctx.signal.aborted) throw new Error("Professional Agent request was interrupted.");
        return { ok: true, summary: "ok" };
      }
    });
    const result = await runToolLoop(
      { ...hostWithProvider(provider, tools, []), signal: controller.signal },
      { systemInstruction: "sys", taskPayload: "task" }
    );
    expect(["interrupted", "failed"]).toContain(result.status);
  });

  it("feeds only compact tool summaries into subsequent model turns", async () => {
    const provider = new FakeModelProvider({
      successContents: [
        toolCallJson("search_files", { query: "TODO" }),
        JSON.stringify({ type: "final", summary: "found" })
      ]
    });
    const tools = createFakeTools({
      search_files: () => ({
        ok: true,
        summary: "Found 1 match: src/a.ts:3: // TODO fix"
      })
    });
    await runToolLoop(hostWithProvider(provider, tools, []), {
      systemInstruction: "sys",
      taskPayload: JSON.stringify({ task: "find todos", note: "do not load entire repo" })
    });
    expect(provider.calls).toHaveLength(2);
    const second = provider.calls[1]!.messages.map((message: ModelMessage) => message.content).join("\n");
    expect(second).toContain("Found 1 match");
    expect(second.length).toBeLessThan(20_000);
  });
});

function hostWithProvider(
  provider: FakeModelProvider,
  tools: ReturnType<typeof createFakeTools> | [],
  events: ToolLoopEvent[],
  limits: Partial<typeof DEFAULT_TOOL_LOOP_LIMITS> = {}
): ToolLoopHost {
  return {
    runId: "run-test",
    workspacePath: "C:\\tmp\\workspace",
    tools: toolMapOf(...tools),
    limits,
    signal: new AbortController().signal,
    async invokeModel(messages, signal) {
      const response = await provider.complete({
        connectionId: "conn",
        modelId: "fake",
        messages,
        signal
      } satisfies ModelProviderRequest);
      return { content: response.content, usage: response.usage };
    },
    onEvent: (event) => {
      events.push(event);
    }
  };
}
