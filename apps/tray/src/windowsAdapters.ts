import { spawn as nodeSpawn, execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { AutostartStore } from "./autostart.js";
import type { ManagedChild, ProcessKiller, ProcessManagerFs, ProcessSpawner, SpawnSpec } from "./processManager.js";

const execFileAsync = promisify(execFile);

export const nodeProcessManagerFs: ProcessManagerFs = {
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data, encoding) => writeFile(path, data, encoding),
  unlink: (path) => unlink(path),
  mkdir: (path, options) => mkdir(path, options)
};

export const nodeProcessSpawner: ProcessSpawner = {
  spawn(spec: SpawnSpec): ManagedChild {
    const child = nodeSpawn(spec.command, spec.args, {
      env: spec.env,
      cwd: spec.cwd,
      stdio: "ignore",
      detached: true,
      windowsHide: true
    });
    child.unref();
    return child;
  }
};

export const windowsProcessKiller: ProcessKiller = {
  async killTree(pid: number): Promise<void> {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(
        (error: unknown) => {
          // taskkill exits non-zero when the process is already gone — treat as success if message matches.
          const message = error instanceof Error ? error.message : String(error);
          if (/not found|没有找到|no running instance/i.test(message)) return;
          // Node wraps exit code on execFile failure; retry soft signal path below.
          try {
            process.kill(pid);
          } catch {
            // already dead
          }
        }
      );
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already dead
    }
  }
};

/**
 * HKCU Run key via `reg.exe` so we avoid native addons.
 * Only used on Windows hosts; tests inject MemoryAutostartStore.
 */
export class WindowsRegistryRunKeyStore implements AutostartStore {
  constructor(
    private readonly runKeyPath = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    private readonly exec: typeof execFileAsync = execFileAsync
  ) {}

  async get(name: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.exec("reg", ["query", this.runKeyPath, "/v", name], {
        windowsHide: true
      });
      const match = stdout.match(new RegExp(`${escapeRegExp(name)}\\s+REG_SZ\\s+(.+)$`, "im"));
      return match?.[1]?.trim();
    } catch {
      return undefined;
    }
  }

  async set(name: string, command: string): Promise<void> {
    await this.exec("reg", ["add", this.runKeyPath, "/v", name, "/t", "REG_SZ", "/d", command, "/f"], {
      windowsHide: true
    });
  }

  async remove(name: string): Promise<void> {
    await this.exec("reg", ["delete", this.runKeyPath, "/v", name, "/f"], { windowsHide: true }).catch(
      () => undefined
    );
  }
}

export async function openInDefaultBrowser(url: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url], { windowsHide: true });
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  await execFileAsync(opener, [url]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
