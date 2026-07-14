import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { FakeModelProvider } from "../model/fakeProvider.js";
import { ModelRuntime } from "../model/modelRuntime.js";
import { RoleService } from "../roles/roleService.js";
import { assertRuntimeAdapter, type RuntimeAdapter } from "./adapter.js";
import { ApiAgentAdapter } from "./apiAgentAdapter.js";
import {
  CodexCliAdapter,
  FakeCodexCliPort,
  createCodexCliPortFromRunner,
  normalizeCodexCliFailure
} from "./codexCliAdapter.js";
import { drainRuntimeSend, runtimeEventToLog } from "./orchestration.js";
import {
  assertCapabilitiesShape,
  assertEventsPersistable,
  assertMonotonicSequences,
  assertRuntimeEventShape,
  isTerminalRuntimeEvent,
  RUNTIME_CAPABILITY_KEYS,
  RUNTIME_ERROR_KINDS,
  RUNTIME_EVENT_KINDS
} from "./contract.js";
import {
  createApproval,
  createArtifact,
  createAskUser,
  createComplete,
  createFail,
  createInterrupt,
  createTextDelta,
  createToolRequest,
  createToolResult,
  createUsage,
  persistEvent,
  restoreEvent
} from "./events.js";
import { normalizeRuntimeError } from "./errors.js";
import { RuntimeAdapterRegistry } from "./registry.js";
import { StubRuntimeAdapter } from "./stubAdapter.js";
import type { RuntimeEvent, RuntimeSession, RuntimeStartInput } from "./types.js";

class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();
  async read(reference: string): Promise<string | undefined> {
    return this.values.get(reference);
  }
  async write(reference: string, secret: string): Promise<void> {
    this.values.set(reference, secret);
  }
  async remove(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

export async function collectRuntimeEvents(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

export interface RuntimeAdapterContractFactoryResult {
  adapter: RuntimeAdapter;
  startInput: RuntimeStartInput;
  sendText?: string;
  expectReadyProbe?: boolean;
  cleanup?: () => Promise<void>;
}

/**
 * Contract suite every harness adapter must pass.
 * New harnesses (Claude Code, etc.) register a factory here — same assertions apply.
 *
 * Usage:
 *   defineRuntimeAdapterContract("claude-code", async () => ({
 *     adapter: new ClaudeCodeAdapter(...),
 *     startInput: { roleId, workspacePath }
 *   }));
 */
export function defineRuntimeAdapterContract(
  name: string,
  factory: () => Promise<RuntimeAdapterContractFactoryResult>
): void {
  describe(`Runtime Adapter contract: ${name}`, () => {
    let adapter: RuntimeAdapter;
    let startInput: RuntimeStartInput;
    let sendText: string;
    let expectReadyProbe: boolean;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const built = await factory();
      adapter = built.adapter;
      startInput = built.startInput;
      sendText = built.sendText ?? "hello from contract test";
      expectReadyProbe = built.expectReadyProbe ?? true;
      cleanup = built.cleanup;
    });

    afterEach(async () => {
      await cleanup?.();
    });

    it("exposes the adapter surface and capability flags", () => {
      assertRuntimeAdapter(adapter);
      assertCapabilitiesShape(adapter.capabilities());
      for (const key of RUNTIME_CAPABILITY_KEYS) {
        expect(typeof adapter.capabilities()[key]).toBe("boolean");
      }
    });

    it("probes readiness without starting a session", async () => {
      const probe = await adapter.probe();
      expect(probe.harness).toBe(adapter.harness);
      expect(probe.capabilities).toEqual(adapter.capabilities());
      if (expectReadyProbe) expect(probe.ready).toBe(true);
    });

    it("returns a stable session id and accepts checkpoint summary injection on rebuild", async () => {
      const first = await adapter.start({ ...startInput, sessionId: "stable-session-1" });
      expect(first.sessionId).toBe("stable-session-1");
      expect(first.harness).toBe(adapter.harness);

      const rebuilt = await adapter.start({
        ...startInput,
        sessionId: "stable-session-1",
        checkpointSummary: "Completed steps: 1,2; interrupted at write_file:a.ts"
      });
      expect(rebuilt.sessionId).toBe("stable-session-1");
      expect(rebuilt.checkpointSummary).toContain("interrupted");

      const resumed = await adapter.resume("stable-session-1", {
        checkpointSummary: "Resumed after restart; fingerprint matched."
      });
      expect(resumed.sessionId).toBe("stable-session-1");
      expect(resumed.checkpointSummary).toContain("Resumed after restart");

      await adapter.dispose("stable-session-1");
    });

    it("emits unified stream events ending in complete|fail|interrupt", async () => {
      const session = await adapter.start(startInput);
      const events = await collectRuntimeEvents(adapter.send(session.sessionId, { text: sendText }));
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.sessionId === session.sessionId)).toBe(true);

      for (const event of events) {
        assertRuntimeEventShape(event);
        expect(RUNTIME_EVENT_KINDS).toContain(event.kind);
      }

      assertMonotonicSequences(events);
      assertEventsPersistable(events);

      const terminal = events.at(-1);
      expect(terminal && isTerminalRuntimeEvent(terminal)).toBe(true);

      await adapter.dispose(session.sessionId);
    });

    it("supports cancel without throwing harness-private errors to the caller", async () => {
      const session = await adapter.start(startInput);
      await expect(adapter.cancel(session.sessionId)).resolves.toBeUndefined();
      await expect(adapter.dispose(session.sessionId)).resolves.toBeUndefined();
    });

    it("dispose releases the session; subsequent send/resume fail with protocol_error", async () => {
      const session = await adapter.start({ ...startInput, sessionId: `dispose-${name}` });
      await adapter.dispose(session.sessionId);

      await expect(adapter.resume(session.sessionId)).rejects.toMatchObject({ kind: "protocol_error" });
      await expect(collectRuntimeEvents(adapter.send(session.sessionId, { text: sendText }))).rejects.toMatchObject({
        kind: "protocol_error"
      });
    });
  });
}

describe("normalizeRuntimeError taxonomy", () => {
  it("normalizes auth, quota, not logged in, timeout, process exit, protocol and user cancel", () => {
    expect(normalizeRuntimeError(new Error("认证失败，请检查 API Key。")).kind).toBe("authentication_failed");
    expect(normalizeRuntimeError(new Error("quota exceeded 429")).kind).toBe("quota_exceeded");
    expect(normalizeRuntimeError(new Error("Codex CLI 尚未登录或登录已失效。请在本机运行 codex login 后重试。")).kind).toBe(
      "not_logged_in"
    );
    expect(normalizeRuntimeError(new Error("request timed out")).kind).toBe("timeout");
    expect(normalizeRuntimeError(Object.assign(new Error("worker died"), { exitCode: 1 })).kind).toBe("process_exit");
    expect(normalizeRuntimeError(new Error("invalid protocol handshake")).kind).toBe("protocol_error");
    expect(normalizeRuntimeError(Object.assign(new Error("aborted"), { name: "AbortError" })).kind).toBe("user_cancel");
    expect(normalizeRuntimeError(new Error("user cancelled by user")).kind).toBe("user_cancel");
    expect(normalizeRuntimeError(new Error("network socket hang up")).kind).toBe("network_failed");
    expect(normalizeRuntimeError(new Error("model is unavailable")).kind).toBe("model_unavailable");
  });

  it("preserves already-normalized kinds and redacts secrets", () => {
    const pre = normalizeRuntimeError({ kind: "quota_exceeded", message: "quota", retryable: true, code: 429 });
    expect(pre.kind).toBe("quota_exceeded");
    expect(pre.code).toBe(429);

    const normalized = normalizeRuntimeError(new Error("Authorization: Bearer sk-abcdefghijklmnop failed"));
    expect(normalized.message).not.toContain("sk-abcdefghijklmnop");
    expect(RUNTIME_ERROR_KINDS).toContain(normalized.kind);
  });
});

describe("persistable redacted events (all kinds)", () => {
  const sessionId = "sess-persist";

  it("redacts and restores text_delta for timeline display", () => {
    const event = createTextDelta(sessionId, "Authorization: Bearer sk-abcdefghijklmnop\nok", 1);
    const persisted = persistEvent(event);
    expect(persisted.redacted).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain("sk-abcdefghijklmnop");
    const restored = restoreEvent(persisted);
    expect(restored.kind).toBe("text_delta");
    expect(restored.sessionId).toBe(sessionId);
    if (restored.kind === "text_delta") {
      expect(restored.text).not.toContain("sk-abcdefghijklmnop");
      expect(restored.text).toContain("ok");
    }
  });

  it("persists tool, ask_user, approval, artifact, usage, complete, fail, interrupt", () => {
    const events: RuntimeEvent[] = [
      createToolRequest(sessionId, 1, {
        toolCallId: "t1",
        toolName: "shell",
        arguments: { cmd: "echo", apiKey: "sk-abcdefghijklmnop" }
      }),
      createToolResult(sessionId, 2, {
        toolCallId: "t1",
        toolName: "shell",
        ok: true,
        resultSummary: "Authorization: Bearer sk-abcdefghijklmnop done"
      }),
      createAskUser(sessionId, 3, { prompt: "token sk-abcdefghijklmnop ok?", options: ["yes"] }),
      createApproval(sessionId, 4, {
        approvalKind: "shell",
        summary: "run with secret sk-abcdefghijklmnop",
        status: "requested"
      }),
      createArtifact(sessionId, 5, {
        path: "out.txt",
        artifactKind: "file",
        summary: "Bearer sk-abcdefghijklmnop"
      }),
      createUsage(sessionId, 6, { promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
      createComplete(sessionId, 7, "done with sk-abcdefghijklmnop"),
      createFail(sessionId, 8, normalizeRuntimeError(new Error("auth sk-abcdefghijklmnop failed"))),
      createInterrupt(sessionId, 9, "cancelled sk-abcdefghijklmnop")
    ];

    assertEventsPersistable(events);
    for (const event of events) {
      assertRuntimeEventShape(event);
      const wire = JSON.stringify(persistEvent(event));
      expect(wire).not.toContain("sk-abcdefghijklmnop");
    }
  });

  it("rejects un-restorable envelopes", () => {
    expect(() => restoreEvent({ redacted: true, event: {} as RuntimeEvent })).toThrow(/not restorable/i);
  });
});

describe("RuntimeAdapterRegistry", () => {
  it("selects adapters by harness without leaking private types", async () => {
    const port = new FakeCodexCliPort();
    const codex = new CodexCliAdapter({ port });
    const apiStub = new StubRuntimeAdapter({ harness: "api-like" });
    const registry = new RuntimeAdapterRegistry();
    registry.register(codex);
    registry.register(apiStub);
    expect(registry.has("codex-cli")).toBe(true);
    expect(registry.has("api-like")).toBe(true);
    expect(registry.get("codex-cli").harness).toBe("codex-cli");
    expect(registry.list().map((entry) => entry.harness).sort()).toEqual(["api-like", "codex-cli"]);
    expect(registry.tryGet("missing")).toBeUndefined();
    expect(() => registry.get("missing")).toThrow(/No RuntimeAdapter/);
  });

  it("rejects adapters without harness id", () => {
    const registry = new RuntimeAdapterRegistry();
    expect(() =>
      registry.register({ harness: "  " } as unknown as RuntimeAdapter)
    ).toThrow(/without harness/i);
  });
});

describe("assertRuntimeAdapter", () => {
  it("requires harness string and all contract methods", () => {
    expect(() => assertRuntimeAdapter({} as RuntimeAdapter)).toThrow(/harness/);
    expect(() =>
      assertRuntimeAdapter({
        harness: "broken",
        capabilities: () => ({
          reasoning: false,
          images: false,
          tools: false,
          resume: false,
          workspace: false,
          network: false,
          structuredOutput: false
        })
      } as RuntimeAdapter)
    ).toThrow(/missing method/);
  });
});

// --- API Agent factory ---
defineRuntimeAdapterContract("api", async () => {
  const root = await mkdtemp(join(tmpdir(), "paw-runtime-api-"));
  const vault = new MemoryCredentialVault();
  const connections = await ConnectionService.open(
    join(root, "connections.json"),
    vault,
    async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }))
  );
  const roles = await RoleService.open(join(root, "roles.json"), connections);
  const connection = await connections.create({
    baseUrl: "https://api.example.test/v1",
    apiKey: "contract-secret-key",
    modelId: "gpt-5"
  });
  const role = await roles.create({
    name: "API Contract Role",
    responsibility: "test",
    systemInstruction: "Be brief.",
    connectionId: connection.id,
    modelId: "gpt-5",
    harness: "api",
    reasoningEffort: "low",
    skills: ["implement"],
    tools: ["model-api"],
    permissions: { workspace: "project_only", network: false, shell: false, externalSend: false },
    allowFirstmateAutoInvoke: false
  });
  const provider = new FakeModelProvider({
    scenario: "success",
    successContent: "API adapter contract response"
  });
  const modelRuntime = new ModelRuntime({ roles, connections, provider });
  const adapter = new ApiAgentAdapter({ modelRuntime, defaultRoleId: role.id });
  return {
    adapter,
    startInput: { roleId: role.id, workspacePath: root },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
});

// --- Codex CLI factory ---
defineRuntimeAdapterContract("codex-cli", async () => {
  const port = new FakeCodexCliPort();
  port.turnResult = { exitCode: 0, stdout: "Codex adapter contract response", stderr: "" };
  const adapter = new CodexCliAdapter({ port });
  return {
    adapter,
    startInput: { roleId: "role-codex", workspacePath: "C:\\projects\\demo", checkpointSummary: undefined },
    sendText: "implement the feature"
  };
});

// --- Future harness template (proves contract suite is reusable) ---
defineRuntimeAdapterContract("stub-future-harness", async () => {
  const adapter = new StubRuntimeAdapter({ harness: "claude-code-future" });
  return {
    adapter,
    startInput: {
      roleId: "role-future",
      workspacePath: "C:\\projects\\future",
      checkpointSummary: "prior steps done"
    },
    sendText: "continue from checkpoint"
  };
});

describe("API Agent adapter failure normalization", () => {
  let root: string;
  let adapter: ApiAgentAdapter;
  let roleId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-runtime-api-fail-"));
    const vault = new MemoryCredentialVault();
    const connections = await ConnectionService.open(
      join(root, "connections.json"),
      vault,
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }))
    );
    const roles = await RoleService.open(join(root, "roles.json"), connections);
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "secret",
      modelId: "gpt-5"
    });
    const role = await roles.create({
      name: "fail role",
      responsibility: "test",
      systemInstruction: "x",
      connectionId: connection.id,
      modelId: "gpt-5",
      harness: "api",
      reasoningEffort: "low",
      skills: ["implement"],
      tools: ["model-api"],
      permissions: { workspace: "project_only", network: false, shell: false, externalSend: false },
      allowFirstmateAutoInvoke: false
    });
    roleId = role.id;
    const provider = new FakeModelProvider({ scenario: "auth_fail" });
    adapter = new ApiAgentAdapter({
      modelRuntime: new ModelRuntime({ roles, connections, provider }),
      defaultRoleId: role.id
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("emits fail events with normalized auth errors (no harness-private payload)", async () => {
    const session = await adapter.start({ roleId });
    const events = await collectRuntimeEvents(adapter.send(session.sessionId, { text: "hi" }));
    const fail = events.find((event) => event.kind === "fail");
    expect(fail?.kind).toBe("fail");
    if (fail?.kind !== "fail") return;
    expect(fail.error.kind).toBe("authentication_failed");
    expect(JSON.stringify(events)).not.toMatch(/apiKey|Authorization|secret/i);
  });

  it("requires roleId and emits protocol_error fail without private payloads", async () => {
    const session = await adapter.start({});
    const events = await collectRuntimeEvents(adapter.send(session.sessionId, { text: "hi" }));
    const fail = events.find((event) => event.kind === "fail");
    expect(fail?.kind).toBe("fail");
    if (fail?.kind === "fail") {
      expect(fail.error.kind).toBe("protocol_error");
    }
  });
});

describe("Codex CLI adapter failure normalization", () => {
  it("maps not-logged-in probe failures to fail events", async () => {
    const port = new FakeCodexCliPort();
    port.statusResult = {
      installed: true,
      authenticated: false,
      reason: "Codex CLI 尚未登录或登录已失效。请在本机运行 codex login 后重试。"
    };
    const adapter = new CodexCliAdapter({ port });
    const session = await adapter.start({ workspacePath: "C:\\ws" });
    const events = await collectRuntimeEvents(adapter.send(session.sessionId, { text: "go" }));
    expect(events.some((event) => event.kind === "fail")).toBe(true);
    const fail = events.find((event) => event.kind === "fail");
    if (fail?.kind === "fail") {
      expect(fail.error.kind).toBe("not_logged_in");
    }
  });

  it("maps non-zero process exit to process_exit", async () => {
    const port = new FakeCodexCliPort();
    port.turnResult = { exitCode: 2, stdout: "", stderr: "fatal: worker crashed" };
    const adapter = new CodexCliAdapter({ port });
    const session = await adapter.start({});
    const events = await collectRuntimeEvents(adapter.send(session.sessionId, { text: "go" }));
    const fail = events.find((event) => event.kind === "fail");
    expect(fail?.kind).toBe("fail");
    if (fail?.kind === "fail") {
      expect(fail.error.kind).toBe("process_exit");
      expect(fail.error.code).toBe(2);
    }
  });

  it("injects checkpoint summary into the codex prompt on rebuild", async () => {
    const port = new FakeCodexCliPort();
    const adapter = new CodexCliAdapter({ port });
    const session: RuntimeSession = await adapter.start({
      sessionId: "codex-rebuild",
      checkpointSummary: "Steps done: parse; next: write tests"
    });
    await collectRuntimeEvents(adapter.send(session.sessionId, { text: "continue" }));
    expect(port.turns[0]?.prompt).toContain("Steps done: parse");
    expect(port.turns[0]?.prompt).toContain("continue");
  });

  it("maps cancel during turn to interrupt (user_cancel taxonomy via interrupt event)", async () => {
    const port = new FakeCodexCliPort();
    port.delayMs = 40;
    port.turnResult = { exitCode: 0, stdout: "late", stderr: "" };
    const adapter = new CodexCliAdapter({ port });
    const session = await adapter.start({ sessionId: "codex-cancel" });
    const pending = collectRuntimeEvents(adapter.send(session.sessionId, { text: "go" }));
    await adapter.cancel(session.sessionId);
    const events = await pending;
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("interrupt");
    if (terminal?.kind === "interrupt") {
      expect(terminal.reason).toMatch(/取消/);
    }
  });

  it("maps AbortSignal during turn to interrupt", async () => {
    const port = new FakeCodexCliPort();
    port.delayMs = 80;
    const adapter = new CodexCliAdapter({ port });
    const session = await adapter.start({ sessionId: "codex-abort" });
    const controller = new AbortController();
    const pending = collectRuntimeEvents(
      adapter.send(session.sessionId, { text: "go", signal: controller.signal })
    );
    controller.abort();
    const events = await pending;
    expect(events.at(-1)?.kind).toBe("interrupt");
  });
});

describe("StubRuntimeAdapter future-harness event coverage", () => {
  it("can emit tool_request/tool_result under the unified contract", async () => {
    const adapter = new StubRuntimeAdapter({ harness: "claude-code", scenario: "tools" });
    const session = await adapter.start({
      sessionId: "stub-tools",
      checkpointSummary: "cp",
      systemInstruction: "be careful"
    });
    const events = await collectRuntimeEvents(adapter.send(session.sessionId, { text: "use tools" }));
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("tool_request");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("usage");
    expect(kinds.at(-1)).toBe("complete");
    assertMonotonicSequences(events);
    assertEventsPersistable(events);
    const text = events.find((event) => event.kind === "text_delta");
    if (text?.kind === "text_delta") {
      expect(text.text).toContain("checkpoint:cp");
      expect(text.text).toContain("instructions:be careful");
    }
  });

  it("emits ask_user, approval, and artifact kinds for orchestration coverage", async () => {
    const adapter = new StubRuntimeAdapter({ harness: "other-harness", scenario: "approval_artifact" });
    const session = await adapter.start({});
    const events = await collectRuntimeEvents(adapter.send(session.sessionId, { text: "plan" }));
    const kinds = new Set(events.map((event) => event.kind));
    expect(kinds.has("approval")).toBe(true);
    expect(kinds.has("artifact")).toBe(true);
    expect(kinds.has("complete")).toBe(true);

    adapter.scenarioBySession.set(session.sessionId, "ask_user");
    const askEvents = await collectRuntimeEvents(adapter.send(session.sessionId, { text: "ask" }));
    expect(askEvents.some((event) => event.kind === "ask_user")).toBe(true);
  });
});

describe("production orchestration helpers", () => {
  it("drains RuntimeAdapter.send into text + terminal events for orchestration", async () => {
    const adapter = new StubRuntimeAdapter({ harness: "orch", scenario: "success" });
    const session = await adapter.start({ sessionId: "orch-1" });
    const drained = await drainRuntimeSend(adapter, session.sessionId, { text: "hello" });
    expect(drained.text.length).toBeGreaterThan(0);
    expect(drained.terminal?.kind).toBe("complete");
    expect(drained.persisted.every((entry) => entry.redacted)).toBe(true);
    const completeLog = runtimeEventToLog(drained.terminal!);
    expect(completeLog?.message).toMatch(/^runtime:complete/);
  });

  it("creates a production Codex port that shares status messaging with the harness", async () => {
    const calls: string[][] = [];
    const port = createCodexCliPortFromRunner({
      run: async (args) => {
        calls.push(args);
        if (args[0] === "--version") return { exitCode: 0, stdout: "codex 9.9", stderr: "" };
        if (args[0] === "login") return { exitCode: 0, stdout: "ok", stderr: "" };
        return { exitCode: 0, stdout: "turn ok", stderr: "" };
      }
    });
    await expect(port.status()).resolves.toMatchObject({
      installed: true,
      authenticated: true,
      version: "codex 9.9"
    });
    const turn = await port.runTurn({ prompt: "do work", workspacePath: "C:\\ws" });
    expect(turn.stdout).toBe("turn ok");
    expect(calls.some((args) => args[0] === "exec")).toBe(true);
    expect(normalizeCodexCliFailure("authentication failed: please login", 1).kind).toBe("not_logged_in");
    expect(normalizeCodexCliFailure("boom", 7).kind).toBe("process_exit");
  });
});
