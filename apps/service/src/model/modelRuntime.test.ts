import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { RoleService } from "../roles/roleService.js";
import { FakeModelProvider } from "./fakeProvider.js";
import { validateAgainstSchema, parseAndValidateJson } from "./jsonSchema.js";
import { ModelRuntime } from "./modelRuntime.js";
import { redactSecrets } from "./redact.js";

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

const roleBase = {
  name: "实现者",
  responsibility: "实现",
  systemInstruction: "Return structured results only.",
  harness: "api" as const,
  reasoningEffort: "medium" as const,
  skills: ["implement"],
  tools: ["filesystem", "model-api"],
  permissions: { workspace: "project_only" as const, network: false, shell: false, externalSend: false },
  allowFirstmateAutoInvoke: false
};

const sampleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "value"],
  properties: {
    summary: { type: "string", minLength: 1 },
    value: { type: "integer", minimum: 0 }
  }
} as const;

describe("JSON Schema structured output helpers", () => {
  it("validates required object shapes and rejects extra properties when additionalProperties is false", () => {
    expect(validateAgainstSchema({ summary: "ok", value: 1 }, sampleSchema)).toEqual({ valid: true, errors: [] });
    expect(validateAgainstSchema({ summary: "ok" }, sampleSchema).valid).toBe(false);
    expect(validateAgainstSchema({ summary: "ok", value: 1, secret: "x" }, sampleSchema).valid).toBe(false);
  });

  it("parses fenced JSON and surfaces format errors clearly", () => {
    expect(parseAndValidateJson('```json\n{"summary":"ok","value":2}\n```', sampleSchema)).toEqual({
      ok: true,
      value: { summary: "ok", value: 2 }
    });
    expect(parseAndValidateJson("not-json", sampleSchema).ok).toBe(false);
  });
});

describe("secret redaction for model logs", () => {
  it("redacts API keys, Authorization headers, cookies and credential-like assignments", () => {
    const raw = [
      "Authorization: Bearer sk-abcdefghijklmnop",
      "Cookie: session=very-secret-cookie",
      "api_key=super-secret-value",
      "normal text stays"
    ].join("\n");
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain("sk-abcdefghijklmnop");
    expect(redacted).not.toContain("very-secret-cookie");
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).toContain("normal text stays");
    expect(redacted).toMatch(/Authorization:\s*\[REDACTED\]/i);
  });
});

describe("ModelRuntime unified invocation", () => {
  let root: string;
  let connections: ConnectionService;
  let roles: RoleService;
  let vault: MemoryCredentialVault;
  let logs: Array<{ runId: string; level: string; message: string }>;
  let pauses: Array<{ runId: string; reason: string }>;
  let connectionPauses: Array<{ connectionId: string; reason: string }>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-model-runtime-"));
    vault = new MemoryCredentialVault();
    logs = [];
    pauses = [];
    connectionPauses = [];
    connections = await ConnectionService.open(
      join(root, "connections.json"),
      vault,
      async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }))
    );
    roles = await RoleService.open(join(root, "roles.json"), connections);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createApiRole(modelId = "gpt-5") {
    const connection = await connections.create({
      name: "local-proxy",
      baseUrl: "https://api.example.test/v1",
      apiKey: "very-secret-api-key-should-never-log",
      modelId
    });
    const role = await roles.create({
      ...roleBase,
      connectionId: connection.id,
      modelId
    });
    return { connection, role };
  }

  function runtimeWith(provider: FakeModelProvider): ModelRuntime {
    return new ModelRuntime({
      roles,
      connections,
      provider,
      runHooks: {
        recordLog: async (runId, input) => {
          logs.push({ runId, level: input.level, message: input.message });
        },
        pause: async (runId, reason) => {
          pauses.push({ runId, reason });
        },
        pauseForConnection: async (connectionId, reason) => {
          connectionPauses.push({ connectionId, reason });
        }
      }
    });
  }

  it("resolves connection, model, harness and reasoning from an enabled Agent Role without credentials", async () => {
    const { connection, role } = await createApiRole("gpt-5");
    const runtime = runtimeWith(new FakeModelProvider({ scenario: "success" }));
    const config = await runtime.resolveConfig(role.id);
    expect(config).toMatchObject({
      roleId: role.id,
      harness: "api",
      connectionId: connection.id,
      modelId: "gpt-5",
      reasoningEffort: "medium",
      baseUrl: "https://api.example.test/v1",
      enabled: true
    });
    expect(JSON.stringify(config)).not.toContain("very-secret");
    expect(config).not.toHaveProperty("apiKey");
    expect(config).not.toHaveProperty("credentialRef");
  });

  it("invokes successfully and validates structured JSON Schema output", async () => {
    const { role } = await createApiRole();
    const provider = new FakeModelProvider({
      scenario: "success",
      successContent: JSON.stringify({ summary: "done", value: 3 })
    });
    const runtime = runtimeWith(provider);
    const result = await runtime.invoke({
      roleId: role.id,
      messages: [{ role: "user", content: "plan the work" }],
      schema: sampleSchema,
      runId: "run-1"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed).toEqual({ summary: "done", value: 3 });
    expect(result.attempts).toBe(1);
    expect(result.config.modelId).toBe("gpt-5");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.reasoningEffort).toBe("medium");
    expect(logs.some((entry) => entry.message.includes("校验通过"))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("very-secret");
  });

  it("retries bounded times on format errors then fails without switching models", async () => {
    const { role, connection } = await createApiRole("gpt-5");
    const provider = new FakeModelProvider({
      scenario: "format_error",
      invalidContent: "definitely-not-json"
    });
    const runtime = runtimeWith(provider);
    const result = await runtime.invoke({
      roleId: role.id,
      messages: [{ role: "user", content: "return json" }],
      schema: sampleSchema,
      maxFormatRetries: 2
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("format_error");
    expect(result.attempts).toBe(3);
    expect(result.config?.connectionId).toBe(connection.id);
    expect(result.config?.modelId).toBe("gpt-5");
    expect(provider.calls.every((call) => call.connectionId === connection.id && call.modelId === "gpt-5")).toBe(true);
  });

  it("recovers when format error is fixed within the retry budget", async () => {
    const { role } = await createApiRole();
    const provider = new FakeModelProvider({
      scenario: "format_error_then_success",
      formatFailuresBeforeSuccess: 1,
      invalidContent: "{",
      successContent: JSON.stringify({ summary: "repaired", value: 9 })
    });
    const runtime = runtimeWith(provider);
    const result = await runtime.invoke({
      roleId: role.id,
      messages: [{ role: "user", content: "return json" }],
      schema: sampleSchema,
      maxFormatRetries: 2
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed).toEqual({ summary: "repaired", value: 9 });
    expect(result.attempts).toBe(2);
  });

  it("maps auth failure to pause-run without auto-switching connections", async () => {
    const { role, connection } = await createApiRole();
    const provider = new FakeModelProvider({ scenario: "auth_fail" });
    const runtime = runtimeWith(provider);
    const result = await runtime.invoke({
      roleId: role.id,
      messages: [{ role: "user", content: "hi" }],
      runId: "run-auth"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("authentication_failed");
    expect(result.error.pauseRun).toBe(true);
    expect(connectionPauses).toEqual([expect.objectContaining({ connectionId: connection.id })]);
    expect(JSON.stringify(connectionPauses)).not.toContain("very-secret");
    expect(provider.calls).toHaveLength(1);
  });

  it("maps model unavailable to pause-run and never switches paid models", async () => {
    const { role, connection } = await createApiRole("gpt-5");
    const other = await connections.create({
      baseUrl: "https://paid.example.test/v1",
      apiKey: "other-secret",
      modelId: "expensive-model"
    });
    const provider = new FakeModelProvider({ scenario: "model_unavailable" });
    const runtime = runtimeWith(provider);
    const result = await runtime.invoke({
      roleId: role.id,
      messages: [{ role: "user", content: "hi" }],
      runId: "run-unavail"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("model_unavailable");
    expect(result.error.pauseRun).toBe(true);
    expect(result.config?.connectionId).toBe(connection.id);
    expect(result.config?.modelId).toBe("gpt-5");
    expect(provider.calls[0]?.connectionId).not.toBe(other.id);
    expect(provider.calls[0]?.modelId).not.toBe("expensive-model");
  });

  it("supports timeout via Fake Provider", async () => {
    const { role } = await createApiRole();
    const provider = new FakeModelProvider({ scenario: "timeout" });
    const runtime = runtimeWith(provider);
    const result = await runtime.invoke({
      roleId: role.id,
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 50
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
  });

  it("supports cancel via AbortSignal", async () => {
    const { role } = await createApiRole();
    const provider = new FakeModelProvider({ scenario: "success", delayMs: 200 });
    const runtime = runtimeWith(provider);
    const controller = new AbortController();
    const pending = runtime.invoke({
      roleId: role.id,
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
      timeoutMs: 5_000
    });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("cancelled");
  });

  it("supports cancel scenario from Fake Provider", async () => {
    const { role } = await createApiRole();
    const provider = new FakeModelProvider({ scenario: "cancel" });
    const runtime = runtimeWith(provider);
    const result = await runtime.invoke({
      roleId: role.id,
      messages: [{ role: "user", content: "hi" }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("cancelled");
  });

  it("rejects disabled roles and missing API connections with clear errors", async () => {
    const { role } = await createApiRole();
    await roles.update(role.id, { enabled: false });
    const runtime = runtimeWith(new FakeModelProvider());
    const disabled = await runtime.invoke({
      roleId: role.id,
      messages: [{ role: "user", content: "hi" }]
    });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.kind).toBe("role_disabled");

    const codexRole = await roles.create({
      ...roleBase,
      name: "Codex Role",
      harness: "codex-cli",
      connectionId: null,
      modelId: null
    });
    const harness = await runtime.invoke({
      roleId: codexRole.id,
      messages: [{ role: "user", content: "hi" }]
    });
    expect(harness.ok).toBe(false);
    if (!harness.ok) expect(harness.error.kind).toBe("harness_unsupported");
  });

  it("remains backward compatible with Role records that omit modelId (falls back to connection model)", async () => {
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      modelId: "fallback-model"
    });
    const role = await roles.create({
      ...roleBase,
      connectionId: connection.id,
      modelId: null
    });
    const provider = new FakeModelProvider({
      scenario: "success",
      successContent: "plain text ok"
    });
    const runtime = runtimeWith(provider);
    const result = await runtime.invoke({
      roleId: role.id,
      messages: [{ role: "user", content: "hi" }]
    });
    expect(result.ok).toBe(true);
    expect(provider.calls[0]?.modelId).toBe("fallback-model");
  });

  it("uses ConnectionModelProvider against ConnectionService for a real injectable network path", async () => {
    let sawAuth = false;
    connections = await ConnectionService.open(
      join(root, "connections-live.json"),
      vault,
      async (_url, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        const auth = headers?.Authorization ?? "";
        if (auth.includes("live-secret-key")) sawAuth = true;
        // Ensure credential never leaks into response body that runtime would persist as content.
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "live", value: 1 }) } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );
    roles = await RoleService.open(join(root, "roles-live.json"), connections);
    const connection = await connections.create({
      baseUrl: "https://api.example.test/v1",
      apiKey: "live-secret-key",
      modelId: "gpt-5"
    });
    const role = await roles.create({ ...roleBase, connectionId: connection.id, modelId: "gpt-5" });
    const runtime = new ModelRuntime({ roles, connections });
    const result = await runtime.invoke({
      roleId: role.id,
      messages: [{ role: "user", content: "hi" }],
      schema: sampleSchema
    });
    expect(sawAuth).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed).toEqual({ summary: "live", value: 1 });
    expect(JSON.stringify(result)).not.toContain("live-secret-key");
  });
});
