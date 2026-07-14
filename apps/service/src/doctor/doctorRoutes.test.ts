import { join } from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { DoctorService, type DoctorFs } from "./doctorService.js";
import { createDoctorRouteApp } from "./doctorRoutes.js";

function createMemoryFs(initial: Record<string, string> = {}): DoctorFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();
  const ensureParent = (path: string) => {
    const parts = path.replace(/\\/g, "/").split("/");
    parts.pop();
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      dirs.add(acc);
      dirs.add(acc.replace(/\//g, "\\"));
    }
  };
  return {
    files,
    async access(path: string) {
      if (files.has(path) || dirs.has(path)) return;
      const needle = path.replace(/\\/g, "/");
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

describe("doctor routes (Task 44)", () => {
  const dataDirectory = "C:\\paw-data";
  const logDirectory = join(dataDirectory, "logs");
  let fs: ReturnType<typeof createMemoryFs>;
  let doctor: DoctorService;
  let app: ReturnType<typeof createDoctorRouteApp>;

  beforeEach(async () => {
    fs = createMemoryFs({
      [join(dataDirectory, "state.json")]: "{}",
      [join(dataDirectory, "todos.json")]: "{}",
      [join(dataDirectory, "runs.json")]: "{}",
      [join(dataDirectory, "connections.json")]: "{}",
      [join(dataDirectory, "roles.json")]: "{}",
      [join(logDirectory, "service.log")]: "hello apiKey=sk-test-secret-key\n",
      [join(logDirectory, "crash.log")]: "boom token=abc123secret\n",
      [join("C:\\install\\web\\dist", "index.html")]: "<html></html>"
    });

    doctor = new DoctorService({
      version: "0.1.0-test",
      dataDirectory,
      logDirectory,
      servicePid: 7,
      fs,
      disk: { freeBytes: async () => 4 * 1024 * 1024 * 1024 },
      healthProbe: async () => ({ state: "ok", detail: "ok" }),
      portProbe: async () => ({ listening: true, detail: "in use" }),
      tray: { present: true, detail: "tray ok" },
      webRoot: "C:\\install\\web\\dist",
      credentialVaultProbe: async () => ({ available: true, detail: "ok" }),
      connections: {
        listPublic: async () => [
          {
            id: "c1",
            name: "Local",
            enabled: true,
            credentialPresent: true,
            modelId: "gpt-test",
            lastTest: { kind: "success" }
          }
        ]
      },
      codex: { status: async () => ({ installed: false, authenticated: false, reason: "missing" }) },
      mcp: { listPublic: async () => [] },
      git: { run: async () => ({ exitCode: 0, stdout: "git version 2.0", stderr: "" }) },
      worktrees: { countActive: () => 0 },
      runtimes: {
        list: () => [{ harness: "api", probe: async () => ({ ok: true }) }]
      },
      office: async () => ({ office: false, wps: false, detail: "not found" })
    });
    app = createDoctorRouteApp({ doctor });
  });

  it("serves contract, status, doctor, logs, archives, and export", async () => {
    const contract = await request(app).get("/api/doctor/contract").expect(200);
    expect(contract.body.name).toBe("paw.doctor");
    expect(contract.body.commands.length).toBeGreaterThan(0);

    const status = await request(app).get("/api/doctor/status").expect(200);
    expect(status.body.version).toBe("0.1.0-test");
    expect(status.body.level).toBeDefined();
    expect(status.body.endpoints.healthUrl).toContain("/api/health");
    expect(status.body.summary).toBeTruthy();

    const doctorRes = await request(app).get("/api/doctor").expect(200);
    expect(Array.isArray(doctorRes.body.checks)).toBe(true);
    expect(doctorRes.body.status).toBeTruthy();
    expect(typeof doctorRes.body.exitCode).toBe("number");

    const logs = await request(app).get("/api/doctor/logs?lines=20").expect(200);
    expect(logs.body.redacted).toBe(true);
    expect(logs.body.lines.join("\n")).not.toContain("sk-test-secret-key");

    const crash = await request(app).get("/api/doctor/logs/crash").expect(200);
    expect(crash.body.kind).toBe("crash");

    const archives = await request(app).get("/api/doctor/logs/archives").expect(200);
    expect(Array.isArray(archives.body.archives)).toBe(true);

    const exported = await request(app).post("/api/doctor/export").expect(201);
    expect(exported.body.manifest.secretsExcluded).toBe(true);
    expect(exported.body.manifest.directory).toContain("diagnostics");
    expect(exported.body.summary).toBeTruthy();
  });

  it("rejects fix without confirm and accepts fix with confirm", async () => {
    const denied = await request(app).post("/api/doctor/fix").send({}).expect(400);
    expect(denied.body.error).toMatch(/confirm/i);

    const denied2 = await request(app).post("/api/doctor/run").send({ fix: true }).expect(400);
    expect(denied2.body.error).toMatch(/confirm/i);

    // Make log dir fail so fix has work: use a new doctor with missing logs
    const bareFs = createMemoryFs({ [join(dataDirectory, "state.json")]: "{}" });
    const fixDoctor = new DoctorService({
      version: "0.1.0-test",
      dataDirectory,
      logDirectory: join(dataDirectory, "logs-missing"),
      fs: bareFs,
      disk: { freeBytes: async () => 4 * 1024 * 1024 * 1024 },
      healthProbe: async () => ({ state: "ok", detail: "ok" }),
      portProbe: async () => ({ listening: true, detail: "in use" })
    });
    const fixApp = createDoctorRouteApp({ doctor: fixDoctor });

    const fixed = await request(fixApp)
      .post("/api/doctor/fix")
      .send({ confirm: true, checkIds: ["log-directory"] })
      .expect(200);
    expect(fixed.body.fixActions.length).toBeGreaterThan(0);
    expect(fixed.body.checks.find((c: { id: string }) => c.id === "log-directory")?.status).toBe("pass");
  });

  it("POST /api/doctor/run rechecks without inventing status from UI text", async () => {
    const rerun = await request(app).post("/api/doctor/run").send({ verbose: true }).expect(200);
    expect(rerun.body.generatedAt).toBeTruthy();
    expect(Array.isArray(rerun.body.checks)).toBe(true);
    expect(rerun.body.status.level).toMatch(/healthy|degraded|stopped|unknown/);
    // machine fields present
    for (const check of rerun.body.checks) {
      expect(check.id).toBeTruthy();
      expect(check.code).toBeTruthy();
      expect(["pass", "warn", "fail", "skip"]).toContain(check.status);
    }
  });
});
