import { DEFAULT_BIND_HOST, DEFAULT_SERVICE_PORT } from "./paths.js";

export type ServiceLifecycleState = "stopped" | "starting" | "running" | "stopping" | "unknown";

export interface ServiceStatus {
  state: ServiceLifecycleState;
  pid?: number;
  port: number;
  healthOk: boolean;
  detail: string;
}

export interface ManagedChild {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  unref?: () => void;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ProcessSpawner {
  spawn(spec: SpawnSpec): ManagedChild;
}

export interface ProcessManagerFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
}

export interface ProcessKiller {
  /** Best-effort terminate of a PID (and children on Windows). */
  killTree(pid: number): Promise<void>;
}

export interface ProcessManagerOptions {
  nodeExecutable: string;
  serviceEntry: string;
  port?: number;
  dataDirectory: string;
  webDist?: string;
  pidFile: string;
  host?: string;
  fetchImpl?: typeof fetch;
  spawner: ProcessSpawner;
  fs: ProcessManagerFs;
  killer: ProcessKiller;
  sleep?: (ms: number) => Promise<void>;
  healthTimeoutMs?: number;
  startupTimeoutMs?: number;
  /** Extra env merged into the service process (must not inject secrets from installer). */
  extraEnv?: NodeJS.ProcessEnv;
}

export class ProcessManager {
  private readonly port: number;
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly healthTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private child: ManagedChild | null = null;

  constructor(private readonly options: ProcessManagerOptions) {
    this.port = options.port ?? DEFAULT_SERVICE_PORT;
    this.host = options.host ?? DEFAULT_BIND_HOST;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.healthTimeoutMs = options.healthTimeoutMs ?? 1500;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  }

  healthUrl(): string {
    return `http://${this.host}:${this.port}/api/health`;
  }

  async status(): Promise<ServiceStatus> {
    const pid = await this.readPid();
    const healthOk = await this.probeHealth();
    if (healthOk) {
      return {
        state: "running",
        pid: pid ?? this.child?.pid,
        port: this.port,
        healthOk: true,
        detail: `服务在线（${this.host}:${this.port}）`
      };
    }
    if (pid || this.child?.pid) {
      return {
        state: "unknown",
        pid: pid ?? this.child?.pid,
        port: this.port,
        healthOk: false,
        detail: "记录了进程但健康检查失败。可尝试重启服务。"
      };
    }
    return {
      state: "stopped",
      port: this.port,
      healthOk: false,
      detail: "服务已停止"
    };
  }

  async start(): Promise<ServiceStatus> {
    const current = await this.status();
    if (current.healthOk) {
      return { ...current, detail: "服务已在运行，无需重复启动。" };
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.extraEnv,
      PAW_SERVICE_PORT: String(this.port),
      PAW_DATA_DIR: this.options.dataDirectory,
      // Force loopback-only bind is enforced inside the service listen() call.
      PAW_BIND_HOST: this.host
    };
    if (this.options.webDist) {
      env.PAW_WEB_DIST = this.options.webDist;
    }

    let child: ManagedChild;
    try {
      child = this.options.spawner.spawn({
        command: this.options.nodeExecutable,
        args: [this.options.serviceEntry],
        env,
        cwd: undefined
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `无法启动本地 Agent Service。请确认 Node.js 与 service 构建产物可用。详情：${detail}`
      );
    }

    this.child = child;
    if (child.pid) {
      await this.writePid(child.pid);
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.probeHealth()) {
        return {
          state: "running",
          pid: child.pid,
          port: this.port,
          healthOk: true,
          detail: `服务已启动（pid ${child.pid ?? "?"}，${this.host}:${this.port}）`
        };
      }
      await this.sleep(200);
    }

    throw new Error(
      `服务启动超时（${this.startupTimeoutMs}ms），未能通过 ${this.healthUrl()} 健康检查。请查看服务日志或执行 restart。`
    );
  }

  async stop(): Promise<ServiceStatus> {
    const pid = (await this.readPid()) ?? this.child?.pid;
    if (!pid && !(await this.probeHealth())) {
      await this.clearPid();
      this.child = null;
      return {
        state: "stopped",
        port: this.port,
        healthOk: false,
        detail: "服务已处于停止状态。"
      };
    }

    if (pid) {
      try {
        await this.options.killer.killTree(pid);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`停止服务失败（pid ${pid}）。请手动结束进程后重试。详情：${detail}`);
      }
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.probeHealth())) break;
      await this.sleep(150);
    }

    await this.clearPid();
    this.child = null;

    if (await this.probeHealth()) {
      throw new Error(
        `已请求停止服务，但 ${this.healthUrl()} 仍可访问。请检查是否有其他实例占用端口 ${this.port}。`
      );
    }

    return {
      state: "stopped",
      port: this.port,
      healthOk: false,
      detail: pid ? `服务已停止（原 pid ${pid}）` : "服务已停止"
    };
  }

  async restart(): Promise<ServiceStatus> {
    await this.stop().catch(() => undefined);
    return this.start();
  }

  private async probeHealth(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    try {
      const response = await this.fetchImpl(this.healthUrl(), { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readPid(): Promise<number | undefined> {
    try {
      const raw = (await this.options.fs.readFile(this.options.pidFile, "utf8")).trim();
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  private async writePid(pid: number): Promise<void> {
    const dir = this.options.pidFile.replace(/[\\/][^\\/]+$/u, "");
    if (dir && dir !== this.options.pidFile) {
      await this.options.fs.mkdir(dir, { recursive: true });
    }
    await this.options.fs.writeFile(this.options.pidFile, `${pid}\n`, "utf8");
  }

  private async clearPid(): Promise<void> {
    try {
      await this.options.fs.unlink(this.options.pidFile);
    } catch {
      // ignore missing pid file
    }
  }
}
