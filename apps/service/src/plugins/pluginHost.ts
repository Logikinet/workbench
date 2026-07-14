/**
 * Plugin process isolation host (Task 46).
 * Third-party extensions run out-of-process (stdio JSON-lines) so a crash
 * cannot take down the workbench. In-process mode is for tests / trusted seeds
 * and is still wrapped in try/catch with permission-scoped handlers.
 *
 * Inspired by NextClaw ExtensionLifecycleService (spawn + parent PID watch).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  InprocessPluginModule,
  PluginHostRequest,
  PluginHostResponse,
  ResolvedPluginManifest,
  RunningPluginHandle
} from "./pluginTypes.js";

export type PluginCrashHandler = (pluginId: string, detail: string) => void;

export interface PluginHostOptions {
  /** Injected for tests — default spawns a real child. */
  spawnImpl?: typeof spawn;
  onCrash?: PluginCrashHandler;
  /** Request timeout ms (default 10s). */
  requestTimeoutMs?: number;
  parentPid?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeRequestId(): string {
  return `preq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class PluginHostError extends Error {
  constructor(
    message: string,
    readonly code: "timeout" | "crashed" | "not_running" | "protocol" | "handler"
  ) {
    super(message);
    this.name = "PluginHostError";
  }
}

/**
 * Manages isolated plugin runtimes. Host process never loads untrusted plugin
 * code into its own heap when entry.type === "stdio".
 */
export class PluginHost {
  private readonly running = new Map<string, InternalHandle>();
  private readonly spawnImpl: typeof spawn;
  private readonly onCrash?: PluginCrashHandler;
  private readonly requestTimeoutMs: number;
  private readonly parentPid: number;

  constructor(options: PluginHostOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.onCrash = options.onCrash;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.parentPid = options.parentPid ?? process.pid;
  }

  isRunning(pluginId: string): boolean {
    return this.running.has(pluginId);
  }

  getHandle(pluginId: string): RunningPluginHandle | undefined {
    const internal = this.running.get(pluginId);
    return internal?.publicHandle;
  }

  listRunning(): RunningPluginHandle[] {
    return [...this.running.values()].map((h) => h.publicHandle);
  }

  async start(manifest: ResolvedPluginManifest): Promise<RunningPluginHandle> {
    const existing = this.running.get(manifest.id);
    if (existing) {
      return existing.publicHandle;
    }
    if (manifest.entry.type === "inprocess") {
      return this.startInprocess(manifest);
    }
    return this.startStdio(manifest);
  }

  async stop(pluginId: string): Promise<void> {
    const handle = this.running.get(pluginId);
    if (!handle) return;
    this.running.delete(pluginId);
    await handle.stopInternal();
  }

  async stopAll(): Promise<void> {
    const ids = [...this.running.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /**
   * Simulate a child crash (tests). Invokes the same path as a real exit.
   */
  simulateCrash(pluginId: string, detail = "simulated crash"): void {
    const handle = this.running.get(pluginId);
    if (!handle) return;
    this.running.delete(pluginId);
    handle.markCrashed(detail);
    this.onCrash?.(pluginId, detail);
  }

  private async startInprocess(manifest: ResolvedPluginManifest): Promise<RunningPluginHandle> {
    const modulePath = join(manifest.rootDir, manifest.entry.main);
    const mod = await loadInprocessModule(modulePath);
    if (mod.onStart) {
      await mod.onStart();
    }

    const pending = new Map<
      string,
      { resolve: (v: PluginHostResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
    >();

    const stopInternal = async (): Promise<void> => {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new PluginHostError("Plugin stopped.", "not_running"));
      }
      pending.clear();
      if (mod.onStop) {
        try {
          await mod.onStop();
        } catch {
          // ignore stop errors
        }
      }
    };

    const markCrashed = (detail: string): void => {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new PluginHostError(detail, "crashed"));
      }
      pending.clear();
    };

    const request = async <T = unknown>(
      kind: string,
      payload?: Record<string, unknown>
    ): Promise<T> => {
      if (!this.running.has(manifest.id)) {
        throw new PluginHostError(`Plugin "${manifest.id}" is not running.`, "not_running");
      }
      const requestId = makeRequestId();
      const hostRequest: PluginHostRequest = {
        requestId,
        pluginId: manifest.id,
        kind,
        payload: payload ?? {}
      };
      try {
        let data: unknown;
        if (kind === "plugin.contributions" && mod.contributions) {
          data = { contributes: mod.contributions };
        } else if (kind === "plugin.ping") {
          data = { pong: true, pluginId: manifest.id };
        } else if (mod.handle) {
          data = await mod.handle(hostRequest);
        } else {
          throw new PluginHostError(`No handler for kind "${kind}".`, "handler");
        }
        return data as T;
      } catch (error) {
        if (error instanceof PluginHostError) throw error;
        throw new PluginHostError(
          error instanceof Error ? error.message : String(error),
          "handler"
        );
      }
    };

    const publicHandle: RunningPluginHandle = {
      pluginId: manifest.id,
      entryType: "inprocess",
      startedAt: nowIso(),
      stop: async () => this.stop(manifest.id),
      request
    };

    const internal: InternalHandle = {
      publicHandle,
      stopInternal,
      markCrashed
    };
    this.running.set(manifest.id, internal);
    return publicHandle;
  }

  private async startStdio(manifest: ResolvedPluginManifest): Promise<RunningPluginHandle> {
    const mainPath = join(manifest.rootDir, manifest.entry.main);
    const command =
      !manifest.entry.command ||
      manifest.entry.command === "node" ||
      manifest.entry.command === "node.exe"
        ? process.execPath
        : manifest.entry.command;
    const args = manifest.entry.args?.length ? manifest.entry.args : [mainPath];

    const child = this.spawnImpl(command, args, {
      cwd: manifest.rootDir,
      env: {
        ...process.env,
        ...manifest.entry.env,
        PAW_PLUGIN_ID: manifest.id,
        PAW_PLUGIN_PARENT_PID: String(this.parentPid),
        PAW_PLUGIN_API_VERSION: manifest.apiVersion
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const pending = new Map<
      string,
      { resolve: (v: PluginHostResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
    >();
    let buffer = "";
    let crashedDetail: string | undefined;

    const rejectAll = (error: Error): void => {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pending.clear();
    };

    const onLine = (line: string): void => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const record = message as Record<string, unknown>;
      if (record.type !== "response" || typeof record.requestId !== "string") return;
      const waiter = pending.get(record.requestId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(record.requestId);
      waiter.resolve({
        requestId: record.requestId,
        ok: record.ok === true,
        data: record.data,
        error:
          record.error && typeof record.error === "object"
            ? (record.error as PluginHostResponse["error"])
            : undefined
      });
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) onLine(line);
      }
    });

    child.once("exit", (code, signal) => {
      const detail = `Plugin process exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      crashedDetail = detail;
      if (this.running.get(manifest.id)?.publicHandle.pid === child.pid) {
        this.running.delete(manifest.id);
        rejectAll(new PluginHostError(detail, "crashed"));
        this.onCrash?.(manifest.id, detail);
      }
    });

    child.once("error", (error) => {
      const detail = `Plugin process error: ${error.message}`;
      crashedDetail = detail;
      this.running.delete(manifest.id);
      rejectAll(new PluginHostError(detail, "crashed"));
      this.onCrash?.(manifest.id, detail);
    });

    const stopInternal = async (): Promise<void> => {
      rejectAll(new PluginHostError("Plugin stopped.", "not_running"));
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise<void>((resolvePromise) => {
        const t = setTimeout(() => resolvePromise(), 1000);
        child.once("exit", () => {
          clearTimeout(t);
          resolvePromise();
        });
      });
    };

    const markCrashed = (detail: string): void => {
      rejectAll(new PluginHostError(detail, "crashed"));
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    };

    const request = async <T = unknown>(
      kind: string,
      payload?: Record<string, unknown>
    ): Promise<T> => {
      if (!this.running.has(manifest.id) || crashedDetail) {
        throw new PluginHostError(
          crashedDetail ?? `Plugin "${manifest.id}" is not running.`,
          "not_running"
        );
      }
      const requestId = makeRequestId();
      const envelope = {
        type: "request",
        requestId,
        pluginId: manifest.id,
        kind,
        payload: payload ?? {}
      };
      const response = await new Promise<PluginHostResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new PluginHostError(`Plugin request "${kind}" timed out.`, "timeout"));
        }, this.requestTimeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        try {
          child.stdin?.write(`${JSON.stringify(envelope)}\n`);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(
            new PluginHostError(
              error instanceof Error ? error.message : String(error),
              "protocol"
            )
          );
        }
      });
      if (!response.ok) {
        throw new PluginHostError(
          response.error?.message ?? `Plugin request "${kind}" failed.`,
          "handler"
        );
      }
      return response.data as T;
    };

    const publicHandle: RunningPluginHandle = {
      pluginId: manifest.id,
      entryType: "stdio",
      pid: child.pid,
      startedAt: nowIso(),
      stop: async () => this.stop(manifest.id),
      request
    };

    this.running.set(manifest.id, {
      publicHandle,
      stopInternal,
      markCrashed,
      child
    });
    return publicHandle;
  }
}

interface InternalHandle {
  publicHandle: RunningPluginHandle;
  stopInternal: () => Promise<void>;
  markCrashed: (detail: string) => void;
  child?: ChildProcess;
}

async function loadInprocessModule(modulePath: string): Promise<InprocessPluginModule> {
  // Prefer dynamic import (ESM); fall back to createRequire for CJS test doubles.
  try {
    const href = pathToFileURL(modulePath).href;
    const loaded = await import(href);
    const mod = (loaded.default ?? loaded) as InprocessPluginModule;
    return mod;
  } catch {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(modulePath) as InprocessPluginModule | { default: InprocessPluginModule };
    return (loaded as { default?: InprocessPluginModule }).default ?? (loaded as InprocessPluginModule);
  }
}

/**
 * Minimal stdio plugin runtime helper used by sample plugins.
 * Plugins call this from main to serve JSON-line requests on stdin/stdout.
 */
export function createStdioPluginRuntime(handlers: {
  pluginId?: string;
  contributions?: InprocessPluginModule["contributions"];
  handle?: InprocessPluginModule["handle"];
}): { start: () => void } {
  return {
    start: () => {
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          void (async () => {
            let request: PluginHostRequest | null = null;
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed.type !== "request" || typeof parsed.requestId !== "string") return;
              request = {
                requestId: parsed.requestId,
                pluginId: typeof parsed.pluginId === "string" ? parsed.pluginId : "",
                kind: typeof parsed.kind === "string" ? parsed.kind : "",
                payload:
                  parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
                    ? (parsed.payload as Record<string, unknown>)
                    : {}
              };
              let data: unknown;
              if (request.kind === "plugin.ping") {
                data = { pong: true, pluginId: handlers.pluginId ?? request.pluginId };
              } else if (request.kind === "plugin.contributions" && handlers.contributions) {
                data = { contributes: handlers.contributions };
              } else if (handlers.handle) {
                data = await handlers.handle(request);
              } else {
                throw new Error(`Unhandled kind "${request.kind}".`);
              }
              process.stdout.write(
                `${JSON.stringify({
                  type: "response",
                  requestId: request.requestId,
                  ok: true,
                  data
                })}\n`
              );
            } catch (error) {
              if (!request) return;
              process.stdout.write(
                `${JSON.stringify({
                  type: "response",
                  requestId: request.requestId,
                  ok: false,
                  error: {
                    message: error instanceof Error ? error.message : String(error)
                  }
                })}\n`
              );
            }
          })();
        }
      });

      // Exit when parent dies (NextClaw-style).
      const parentRaw = process.env.PAW_PLUGIN_PARENT_PID?.trim();
      const parentPid = parentRaw ? Number(parentRaw) : NaN;
      if (Number.isInteger(parentPid) && parentPid > 0) {
        setInterval(() => {
          try {
            process.kill(parentPid, 0);
          } catch {
            process.exit(0);
          }
        }, 1000).unref();
      }
    }
  };
}
