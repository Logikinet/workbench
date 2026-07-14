import type {
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeHarnessId,
  RuntimeProbeResult,
  RuntimeResumeInput,
  RuntimeSendInput,
  RuntimeSession,
  RuntimeStartInput
} from "./types.js";

/**
 * Runtime Adapter contract.
 * Every harness (API Agent, Codex CLI, future Claude Code, etc.) implements this surface.
 * Orchestration must not parse harness-private formats.
 */
export interface RuntimeAdapter {
  readonly harness: RuntimeHarnessId;

  /** Static capability declaration (may be refined after probe). */
  capabilities(): RuntimeCapabilities;

  /** Health / login / readiness probe without starting a session. */
  probe(): Promise<RuntimeProbeResult>;

  /** Open a session with a stable session ID; may inject checkpoint summary on rebuild. */
  start(input: RuntimeStartInput): Promise<RuntimeSession>;

  /**
   * Send a user turn and yield unified stream events until terminal complete/fail/interrupt.
   * Implementations may buffer and return an array when true streaming is unavailable.
   */
  send(sessionId: string, input: RuntimeSendInput): AsyncIterable<RuntimeEvent>;

  /** Resume a prior session, optionally re-injecting checkpoint summary. */
  resume(sessionId: string, input?: RuntimeResumeInput): Promise<RuntimeSession>;

  /** Cancel an in-flight send/session. */
  cancel(sessionId: string): Promise<void>;

  /** Release session resources; subsequent send/resume must fail until start again. */
  dispose(sessionId: string): Promise<void>;
}

const RUNTIME_ADAPTER_METHODS = [
  "capabilities",
  "probe",
  "start",
  "send",
  "resume",
  "cancel",
  "dispose"
] as const satisfies ReadonlyArray<Exclude<keyof RuntimeAdapter, "harness">>;

/** Type guard helper for contract tests and future harness registration. */
export function assertRuntimeAdapter(adapter: RuntimeAdapter): void {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("RuntimeAdapter must be an object.");
  }
  if (typeof adapter.harness !== "string" || !adapter.harness.trim()) {
    throw new Error("RuntimeAdapter.harness must be a non-empty string.");
  }
  for (const key of RUNTIME_ADAPTER_METHODS) {
    if (typeof adapter[key] !== "function") {
      throw new Error(`RuntimeAdapter missing method: ${String(key)}`);
    }
  }
}
