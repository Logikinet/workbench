import { describe, expect, it, vi } from "vitest";
import {
  ProcessManager,
  type ManagedChild,
  type ProcessKiller,
  type ProcessManagerFs,
  type ProcessSpawner
} from "./processManager.js";

function createMemoryFs(initial: Record<string, string> = {}): ProcessManagerFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async unlink(path) {
      files.delete(path);
    },
    async mkdir() {
      return undefined;
    }
  };
}

describe("service process manager", () => {
  it("starts the service on loopback env and waits for health", async () => {
    const fs = createMemoryFs();
    let healthCalls = 0;
    const fetchImpl = vi.fn(async () => {
      healthCalls += 1;
      if (healthCalls < 2) throw new TypeError("not ready");
      return new Response(JSON.stringify({ status: "online" }), { status: 200 });
    });

    let spawned: { env: NodeJS.ProcessEnv } | undefined;
    const child: ManagedChild = {
      pid: 4242,
      kill: () => true,
      once: () => undefined
    };
    const spawner: ProcessSpawner = {
      spawn(spec) {
        spawned = { env: spec.env };
        return child;
      }
    };
    const killer: ProcessKiller = { killTree: vi.fn(async () => undefined) };

    const manager = new ProcessManager({
      nodeExecutable: "node",
      serviceEntry: "C:\\Install\\service\\dist\\main.js",
      dataDirectory: "C:\\Data\\PersonalAIWorkbench",
      webDist: "C:\\Install\\web\\dist",
      pidFile: "C:\\Data\\PersonalAIWorkbench\\service.pid",
      port: 41731,
      spawner,
      fs,
      killer,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      startupTimeoutMs: 2000
    });

    const status = await manager.start();
    expect(status.state).toBe("running");
    expect(status.pid).toBe(4242);
    expect(status.healthOk).toBe(true);
    expect(spawned?.env.PAW_SERVICE_PORT).toBe("41731");
    expect(spawned?.env.PAW_DATA_DIR).toBe("C:\\Data\\PersonalAIWorkbench");
    expect(spawned?.env.PAW_WEB_DIST).toBe("C:\\Install\\web\\dist");
    expect(spawned?.env.PAW_BIND_HOST).toBe("127.0.0.1");
    expect(fs.files.get("C:\\Data\\PersonalAIWorkbench\\service.pid")).toBe("4242\n");
  });

  it("is a no-op start when health is already ok", async () => {
    const spawner: ProcessSpawner = {
      spawn: () => {
        throw new Error("should not spawn");
      }
    };
    const manager = new ProcessManager({
      nodeExecutable: "node",
      serviceEntry: "main.js",
      dataDirectory: "C:\\Data",
      pidFile: "C:\\Data\\service.pid",
      spawner,
      fs: createMemoryFs(),
      killer: { killTree: async () => undefined },
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
    });
    const status = await manager.start();
    expect(status.detail).toMatch(/已在运行/);
  });

  it("stops via killTree and clears the pid file", async () => {
    const fs = createMemoryFs({ "C:\\Data\\service.pid": "99\n" });
    let healthy = true;
    const killer = { killTree: vi.fn(async (pid: number) => {
      expect(pid).toBe(99);
      healthy = false;
    }) };
    const manager = new ProcessManager({
      nodeExecutable: "node",
      serviceEntry: "main.js",
      dataDirectory: "C:\\Data",
      pidFile: "C:\\Data\\service.pid",
      spawner: { spawn: () => ({ pid: 99, kill: () => true, once: () => undefined }) },
      fs,
      killer,
      fetchImpl: (async () => {
        if (!healthy) throw new TypeError("down");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
      sleep: async () => undefined
    });

    const status = await manager.stop();
    expect(status.state).toBe("stopped");
    expect(killer.killTree).toHaveBeenCalledWith(99);
    expect(fs.files.has("C:\\Data\\service.pid")).toBe(false);
  });

  it("restart stops then starts", async () => {
    const fs = createMemoryFs();
    let healthy = false;
    let pid = 0;
    const spawner: ProcessSpawner = {
      spawn() {
        pid += 1;
        healthy = true;
        return { pid, kill: () => true, once: () => undefined };
      }
    };
    const killer: ProcessKiller = {
      async killTree() {
        healthy = false;
      }
    };
    const manager = new ProcessManager({
      nodeExecutable: "node",
      serviceEntry: "main.js",
      dataDirectory: "C:\\Data",
      pidFile: "C:\\Data\\service.pid",
      spawner,
      fs,
      killer,
      fetchImpl: (async () => {
        if (!healthy) throw new TypeError("down");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
      sleep: async () => undefined
    });

    await manager.start();
    const restarted = await manager.restart();
    expect(restarted.state).toBe("running");
    expect(restarted.pid).toBe(2);
  });

  it("reports stopped when there is no pid and health fails", async () => {
    const manager = new ProcessManager({
      nodeExecutable: "node",
      serviceEntry: "main.js",
      dataDirectory: "C:\\Data",
      pidFile: "C:\\Data\\service.pid",
      spawner: { spawn: () => ({ kill: () => true, once: () => undefined }) },
      fs: createMemoryFs(),
      killer: { killTree: async () => undefined },
      fetchImpl: (async () => {
        throw new TypeError("down");
      }) as unknown as typeof fetch
    });
    await expect(manager.status()).resolves.toMatchObject({ state: "stopped", healthOk: false });
  });
});
