import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  DoctorService,
  summarizeChecks,
  resolveDoctorExitCode,
  resolveHealthLevel,
  waitForHealth,
  type DoctorFs
} from "./doctorService.js";
import type { DoctorCheck } from "./doctorTypes.js";
import { DOCTOR_OPERATION_CONTRACT } from "./doctorTypes.js";

function createMemoryFs(initial: Record<string, string> = {}): DoctorFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();

  const ensureParent = (path: string) => {
    const parts = path.replace(/\\/g, "/").split("/");
    parts.pop();
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      // Preserve windows drive letters roughly as path keys we already use.
      dirs.add(acc);
      dirs.add(acc.replace(/\//g, "\\"));
    }
  };

  return {
    files,
    async access(path: string) {
      const normalized = path;
      if (files.has(normalized) || dirs.has(normalized)) return;
      // Also treat parent dirs of any file as existing
      for (const key of files.keys()) {
        if (key.startsWith(normalized.replace(/\\/g, "/")) || key.startsWith(normalized)) return;
        const parent = key.replace(/\\/g, "/");
        const needle = normalized.replace(/\\/g, "/");
        if (parent.startsWith(needle + "/") || parent === needle) return;
      }
      // directory exists if any file is under it
      const needle = normalized.replace(/\\/g, "/");
      for (const key of files.keys()) {
        if (key.replace(/\\/g, "/").startsWith(needle + "/")) return;
      }
      if (dirs.has(needle)) return;
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },
    async mkdir(path: string) {
      dirs.add(path);
      dirs.add(path.replace(/\\/g, "/"));
      ensureParent(path);
      return path;
    },
    async readFile(path: string) {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return files.get(path)!;
    },
    async writeFile(path: string, data: string) {
      ensureParent(path);
      files.set(path, data);
    },
    async rename(from: string, to: string) {
      if (!files.has(from)) throw Object.assign(new Error(`ENOENT: ${from}`), { code: "ENOENT" });
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    async unlink(path: string) {
      files.delete(path);
    },
    async readdir(path: string) {
      const needle = path.replace(/\\/g, "/").replace(/\/$/, "");
      const names = new Set<string>();
      for (const key of files.keys()) {
        const norm = key.replace(/\\/g, "/");
        if (!norm.startsWith(needle + "/")) continue;
        const rest = norm.slice(needle.length + 1);
        const name = rest.split("/")[0];
        if (name) names.add(name);
      }
      return [...names];
    },
    async stat(path: string) {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      const content = files.get(path)!;
      return {
        size: Buffer.byteLength(content, "utf8"),
        mtime: new Date("2026-07-15T12:00:00.000Z"),
        isDirectory: () => false,
        isFile: () => true
      };
    }
  };
}

describe("doctor helpers", () => {
  it("summarizes and resolves exit codes / health levels", () => {
    const checks: DoctorCheck[] = [
      {
        id: "a",
        name: "A",
        category: "service",
        status: "pass",
        code: "ok",
        detail: "ok"
      },
      {
        id: "b",
        name: "B",
        category: "disk",
        status: "warn",
        code: "warn",
        detail: "low"
      }
    ];
    expect(summarizeChecks(checks)).toEqual({ pass: 1, warn: 1, fail: 0, skip: 0, total: 2 });
    expect(resolveDoctorExitCode(checks)).toBe(1);
    expect(resolveHealthLevel({ serviceRunning: true, healthOk: true, checks })).toBe("degraded");
    expect(
      resolveHealthLevel({
        serviceRunning: true,
        healthOk: true,
        checks: checks.filter((c) => c.status === "pass")
      })
    ).toBe("healthy");
    expect(resolveHealthLevel({ serviceRunning: false, healthOk: false, checks: [] })).toBe("stopped");
  });

  it("waitForHealth polls until ok or timeout", async () => {
    let n = 0;
    const result = await waitForHealth("http://127.0.0.1:9/health", 2_000, {
      intervalMs: 10,
      probe: async () => {
        n += 1;
        if (n < 3) return { state: "unreachable", detail: "down" };
        return { state: "ok", detail: "up" };
      }
    });
    expect(result.state).toBe("ok");
    expect(n).toBeGreaterThanOrEqual(3);

    const timedOut = await waitForHealth("http://127.0.0.1:9/health", 40, {
      intervalMs: 10,
      probe: async () => ({ state: "unreachable", detail: "still down" })
    });
    expect(timedOut.state).toBe("unreachable");
    expect(timedOut.detail).toContain("health timeout");
  });
});

describe("DoctorService (Task 44)", () => {
  const dataDirectory = "C:\\paw-data";
  const logDirectory = join(dataDirectory, "logs");
  let fs: ReturnType<typeof createMemoryFs>;
  let clock: number;

  beforeEach(() => {
    clock = Date.parse("2026-07-15T12:00:00.000Z");
    fs = createMemoryFs({
      [join(dataDirectory, "state.json")]: "{}",
      [join(dataDirectory, "todos.json")]: "{}",
      [join(dataDirectory, "runs.json")]: "{}",
      [join(dataDirectory, "connections.json")]: "{}",
      [join(dataDirectory, "roles.json")]: "{}",
      [join(logDirectory, "service.log")]:
        "info boot\napiKey: sk-secret-should-redact\nAuthorization: Bearer tok_abc\n",
      [join(logDirectory, "crash.log")]: "crash: password=super-secret\n",
      [join(logDirectory, "service.2026-07-14.log")]: "old line\n"
    });
  });

  function createService(overrides: Partial<ConstructorParameters<typeof DoctorService>[0]> = {}) {
    return new DoctorService({
      version: "0.1.0-test",
      dataDirectory,
      logDirectory,
      bindHost: "127.0.0.1",
      port: 41731,
      servicePid: 4242,
      serviceStartedAt: "2026-07-15T11:00:00.000Z",
      now: () => new Date(clock),
      fs,
      disk: { freeBytes: async () => 8 * 1024 * 1024 * 1024 },
      healthProbe: async () => ({ state: "ok", detail: "health endpoint returned ok" }),
      portProbe: async () => ({ listening: true, detail: "port in use" }),
      tray: { present: true, pid: 100, detail: "tray running" },
      webRoot: "C:\\install\\web\\dist",
      credentialVaultProbe: async () => ({ available: true, detail: "vault ok" }),
      connections: {
        listPublic: async () => [
          {
            id: "c1",
            name: "OpenAI",
            enabled: true,
            credentialPresent: true,
            modelId: "gpt-4.1",
            lastTest: { kind: "success", message: "ok" }
          }
        ]
      },
      codex: {
        status: async () => ({ installed: true, authenticated: true, version: "0.1.0" })
      },
      mcp: {
        listPublic: async () => [
          { id: "m1", name: "fs", enabled: true, lastTest: { kind: "success" }, tools: [{ name: "read" }] }
        ]
      },
      git: {
        run: async () => ({ exitCode: 0, stdout: "git version 2.45.0", stderr: "" })
      },
      worktrees: {
        countActive: () => 1,
        statePath: join(dataDirectory, "worktrees.json")
      },
      runtimes: {
        list: () => [
          {
            harness: "api",
            capabilities: () => ({ streaming: true }),
            probe: async () => ({ ok: true, detail: "ready" })
          }
        ]
      },
      office: async () => ({ office: true, wps: false, detail: "Microsoft Office detected" }),
      ...overrides
    });
  }

  it("exposes a machine-readable operation contract for Firstmate", () => {
    const doctor = createService();
    const contract = doctor.contract();
    expect(contract.schemaVersion).toBe(1);
    expect(contract.name).toBe("paw.doctor");
    expect(contract.commands.some((c) => c.path === "/api/doctor/status")).toBe(true);
    expect(contract.commands.some((c) => c.requiresConfirm)).toBe(true);
    expect(contract.checkIds).toEqual(DOCTOR_OPERATION_CONTRACT.checkIds);
    expect(contract.notes.some((n) => n.includes("confirm"))).toBe(true);
  });

  it("returns healthy status and doctor pass when all checks green", async () => {
    // seed pwa + worktree state
    await fs.writeFile(join("C:\\install\\web\\dist", "index.html"), "<html></html>", "utf8");
    await fs.writeFile(join(dataDirectory, "worktrees.json"), "{}", "utf8");

    const doctor = createService();
    const report = await doctor.doctor({ verbose: true });
    expect(report.exitCode).toBe(0);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(report.status.level).toBe("healthy");
    expect(report.status.version).toBe("0.1.0-test");
    expect(report.status.endpoints.port).toBe(41731);
    expect(report.status.process.pid).toBe(4242);
    expect(report.checks.length).toBeGreaterThanOrEqual(10);
    expect(report.status.logTail.some((line) => line.includes("sk-secret"))).toBe(false);
    expect(report.status.logTail.some((line) => line.includes("[REDACTED]"))).toBe(true);

    const status = await doctor.status();
    expect(status.level).toBe("healthy");
    expect(status.summary.pass).toBeGreaterThan(0);
  });

  it("flags providers, disk, and codex with remediation", async () => {
    await fs.writeFile(join("C:\\install\\web\\dist", "index.html"), "<html></html>", "utf8");
    const doctor = createService({
      disk: { freeBytes: async () => 1024 },
      connections: {
        listPublic: async () => [
          {
            id: "c1",
            name: "Broken",
            enabled: true,
            credentialPresent: false,
            modelId: "x",
            lastTest: { kind: "authentication_failed" }
          }
        ]
      },
      codex: {
        status: async () => ({
          installed: true,
          authenticated: false,
          reason: "not logged in"
        })
      }
    });

    const report = await doctor.doctor();
    expect(report.exitCode).toBe(1);
    expect(report.status.level).toBe("degraded");

    const disk = report.checks.find((c) => c.id === "disk-space");
    expect(disk?.status).toBe("fail");
    expect(disk?.remediation).toBeTruthy();

    const providers = report.checks.find((c) => c.id === "providers");
    expect(providers?.status).toBe("fail");
    expect(providers?.code).toBe("providers_missing_credentials");

    const codex = report.checks.find((c) => c.id === "codex-cli");
    expect(codex?.status).toBe("warn");
    expect(codex?.remediation).toMatch(/login/i);
  });

  it("rejects auto-fix without confirm and applies safe fixes with confirm", async () => {
    // Remove log directory presence
    const bareFs = createMemoryFs({
      [join(dataDirectory, "state.json")]: "{}"
    });
    // data dir access via state file parent
    const doctor = createService({
      fs: bareFs,
      webRoot: undefined,
      tray: undefined,
      credentialVaultProbe: undefined,
      connections: undefined,
      codex: undefined,
      mcp: undefined,
      git: undefined,
      worktrees: undefined,
      runtimes: undefined,
      office: undefined
    });

    await expect(doctor.run({ fix: true })).rejects.toThrow(/confirm/i);
    await expect(doctor.fixAndRecheck({ confirm: false as unknown as true })).rejects.toThrow(/confirm/i);

    const fixed = await doctor.fixAndRecheck({ confirm: true, checkIds: ["log-directory"] });
    expect(fixed.fixActions.some((a) => a.includes("log directory"))).toBe(true);

    const logCheck = fixed.checks.find((c) => c.id === "log-directory");
    expect(logCheck?.status).toBe("pass");
  });

  it("reads redacted logs with size limits and lists archives", async () => {
    const doctor = createService();
    const serviceLogs = await doctor.getLogs({ kind: "service", lines: 50 });
    expect(serviceLogs.redacted).toBe(true);
    expect(serviceLogs.lines.join("\n")).not.toContain("sk-secret-should-redact");
    expect(serviceLogs.lines.join("\n")).toMatch(/REDACTED/i);

    const crash = await doctor.getLogs({ kind: "crash" });
    expect(crash.lines.join("\n")).not.toContain("super-secret");

    const archives = await doctor.listLogArchives();
    expect(archives.some((a) => a.name === "service.2026-07-14.log")).toBe(true);
  });

  it("exports a diagnostic pack without secrets", async () => {
    await fs.writeFile(join("C:\\install\\web\\dist", "index.html"), "<html></html>", "utf8");
    await fs.writeFile(join(dataDirectory, "worktrees.json"), "{}", "utf8");
    const doctor = createService();
    const pack = await doctor.exportDiagnosticPack();
    expect(pack.manifest.secretsExcluded).toBe(true);
    expect(pack.manifest.redacted).toBe(true);
    expect(pack.manifest.files).toContain("status.json");
    expect(pack.manifest.files).toContain("doctor.json");
    expect(pack.manifest.files).toContain("logs/service.log");
    expect(pack.manifest.files).toContain("manifest.json");

    const serviceLogPath = join(pack.manifest.directory, "logs", "service.log");
    const logText = await fs.readFile(serviceLogPath, "utf8");
    expect(logText).not.toContain("sk-secret-should-redact");
    expect(logText).not.toContain("Bearer tok_abc");

    const doctorJson = JSON.parse(await fs.readFile(join(pack.manifest.directory, "doctor.json"), "utf8"));
    expect(doctorJson.checks).toBeTruthy();
    expect(JSON.stringify(doctorJson)).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  it("detects orphan port when health fails but port is occupied", async () => {
    const doctor = createService({
      healthProbe: async () => ({ state: "unreachable", detail: "down" }),
      portProbe: async () => ({ listening: true, detail: "port in use" })
    });
    const report = await doctor.doctor();
    const port = report.checks.find((c) => c.id === "port-bind");
    expect(port?.status).toBe("fail");
    expect(port?.code).toBe("port_occupied_orphan");
    expect(report.status.level).not.toBe("healthy");
  });

  it("closed-loop run rechecks after fix creates data directory", async () => {
    const emptyFs = createMemoryFs();
    const doctor = createService({
      fs: emptyFs,
      dataDirectory: "C:\\new-data",
      logDirectory: "C:\\new-data\\logs",
      webRoot: undefined,
      tray: { present: false, detail: "tray not running" },
      credentialVaultProbe: undefined,
      connections: { listPublic: async () => [] },
      codex: undefined,
      mcp: undefined,
      git: undefined,
      worktrees: undefined,
      runtimes: undefined,
      office: undefined,
      healthProbe: async () => ({ state: "ok", detail: "ok" })
    });

    const before = await doctor.doctor();
    const dataCheck = before.checks.find((c) => c.id === "data-directory");
    expect(dataCheck?.status).toBe("fail");

    const after = await doctor.run({ fix: true, confirm: true, checkIds: ["data-directory", "log-directory"] });
    expect(after.fixActions.length).toBeGreaterThan(0);
    expect(after.checks.find((c) => c.id === "data-directory")?.status).toBe("pass");
  });
});
