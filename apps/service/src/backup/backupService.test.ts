import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionService, type CredentialVault } from "../connections/connectionService.js";
import { createApp } from "../http/app.js";
import { ProjectService } from "../projects/projectService.js";
import { WorkspaceAuthorizer } from "../projects/workspaceAuthorization.js";
import { RoleService } from "../roles/roleService.js";
import { RunService } from "../runs/runService.js";
import { TodoService } from "../todos/todoService.js";
import {
  assertSerializedHasNoSecrets,
  BackupService,
  FileSettingsWorkbenchStore,
  parseAndValidatePackage
} from "./backupService.js";
import { createBackupService } from "./createBackupWiring.js";
import type { BackupPackage } from "./backupTypes.js";

class MemoryCredentialVault implements CredentialVault {
  readonly values = new Map<string, string>();
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

describe("workbench backup and migration", () => {
  let root: string;
  let dataDirectory: string;
  let workspace: string;
  let vault: MemoryCredentialVault;
  let projects: ProjectService;
  let todos: TodoService;
  let runs: RunService;
  let connections: ConnectionService;
  let roles: RoleService;
  let backup: BackupService;
  const secretApiKey = "sk-live-super-secret-key-never-export-me";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-backup-"));
    dataDirectory = join(root, "data");
    workspace = join(root, "project-workspace");
    await mkdir(dataDirectory, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "large-source.bin"), "PROJECT_FILE_BODY_SHOULD_NOT_BE_IN_BACKUP");

    vault = new MemoryCredentialVault();
    const authorizer = new WorkspaceAuthorizer({ pick: async (requestedPath) => requestedPath });
    projects = await ProjectService.open(join(dataDirectory, "state.json"), authorizer);
    todos = await TodoService.open(join(dataDirectory, "todos.json"), projects);
    runs = await RunService.open(join(dataDirectory, "runs.json"), todos);
    connections = await ConnectionService.open(join(dataDirectory, "connections.json"), vault);
    roles = await RoleService.open(join(dataDirectory, "roles.json"), connections);

    const settingsStore = new FileSettingsWorkbenchStore(
      join(dataDirectory, "settings.json"),
      join(dataDirectory, "workbench-records.json")
    );
    await settingsStore.importSettings({ locale: "zh-CN", theme: "dark" });
    await settingsStore.importWorkbenchRecords([
      {
        id: "wb-1",
        kind: "project-index-note",
        projectId: "pending",
        path: ".workbench/meta.json",
        data: { label: "local-note" },
        updatedAt: new Date().toISOString()
      }
    ]);

    backup = createBackupService({
      dataDirectory,
      projects,
      todos,
      runs,
      roles,
      connections,
      appVersion: "0.1.0-test"
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedWorkbench() {
    const project = await projects.create({
      name: "Demo Project",
      workspacePath: workspace,
      authorizationGrantId: (await projects.requestWorkspaceAuthorization(workspace)).id,
      summary: "seed"
    });
    const todo = await todos.create({ title: "Ship backup", projectId: project.id });
    const run = await runs.create(todo.id, "start planning");
    const connection = await connections.create({
      name: "Router",
      baseUrl: "https://api.example.test/v1",
      apiKey: secretApiKey,
      modelId: "gpt-test"
    });
    const role = await roles.create({
      name: "Implementer",
      responsibility: "code",
      systemInstruction: "be careful",
      connectionId: connection.id,
      modelId: "gpt-test",
      harness: "api",
      reasoningEffort: "medium",
      skills: ["implement"],
      tools: ["filesystem"],
      permissions: { workspace: "project_only", network: false, shell: false, externalSend: false },
      allowFirstmateAutoInvoke: false
    });
    const settingsStore = new FileSettingsWorkbenchStore(
      join(dataDirectory, "settings.json"),
      join(dataDirectory, "workbench-records.json")
    );
    await settingsStore.importWorkbenchRecords([
      {
        id: "wb-1",
        kind: "project-index-note",
        projectId: project.id,
        path: ".workbench/meta.json",
        data: { label: "local-note" },
        updatedAt: new Date().toISOString()
      }
    ]);
    return { project, todo, run, connection, role };
  }

  it("exports Project index, Todos, Runs, Roles, non-sensitive settings and .workbench records", async () => {
    const seeded = await seedWorkbench();
    const { package: pkg, json } = await backup.exportPackage();

    expect(pkg.schemaVersion).toBe(1);
    expect(pkg.kind).toBe("personal-ai-workbench-backup");
    expect(pkg.projects).toEqual([
      expect.objectContaining({ id: seeded.project.id, name: "Demo Project", workspacePath: workspace })
    ]);
    expect(pkg.todos).toEqual([expect.objectContaining({ id: seeded.todo.id, title: "Ship backup" })]);
    expect(pkg.runs).toEqual([expect.objectContaining({ id: seeded.run.id, todoId: seeded.todo.id })]);
    expect(pkg.roles).toEqual([expect.objectContaining({ id: seeded.role.id, name: "Implementer" })]);
    expect(pkg.settings).toMatchObject({ locale: "zh-CN", theme: "dark" });
    expect(pkg.workbenchRecords).toEqual([
      expect.objectContaining({
        id: "wb-1",
        kind: "project-index-note",
        projectId: seeded.project.id,
        path: ".workbench/meta.json"
      })
    ]);
    expect(pkg.manifest.includesProjectFiles).toBe(false);
    expect(json).toContain("personal-ai-workbench-backup");
  });

  it("does not copy large project files and lists external workspaces the user must back up", async () => {
    await seedWorkbench();
    const { package: pkg, json } = await backup.exportPackage();

    expect(json).not.toContain("PROJECT_FILE_BODY_SHOULD_NOT_BE_IN_BACKUP");
    expect(pkg.manifest.includesProjectFiles).toBe(false);
    expect(pkg.manifest.externalWorkspaces).toEqual([
      expect.objectContaining({
        workspacePath: workspace,
        projectName: "Demo Project",
        note: expect.stringMatching(/自行备份/)
      })
    ]);
  });

  it("never puts API keys, passwords, or harness credentials into a normal backup package", async () => {
    await seedWorkbench();
    const vaultRead = vi.spyOn(vault, "read");
    const { package: pkg, json } = await backup.exportPackage();

    expect(vaultRead).not.toHaveBeenCalled();
    expect(json).not.toContain(secretApiKey);
    expect(json).not.toMatch(/"apiKey"\s*:/);
    expect(pkg.manifest.secretsExcluded).toBe(true);
    expect(pkg.connections).toEqual([
      expect.objectContaining({
        name: "Router",
        secretsExcluded: true,
        credentialRef: expect.stringMatching(/^PersonalAIWorkbench:connection:/)
      })
    ]);
    expect(pkg.connections[0]).not.toHaveProperty("apiKey");
    assertSerializedHasNoSecrets(json);
  });

  it("restores workbench data on the same machine and re-links existing local workspaces", async () => {
    const seeded = await seedWorkbench();
    const exported = await backup.exportPackage();

    // Wipe live data + vault to simulate recovery on another Windows PC.
    const priorCredentialRef = seeded.connection.credentialRef;
    await projects.importSnapshot({ schemaVersion: 1, projects: [] });
    await todos.importSnapshot({ schemaVersion: 1, todos: [] });
    await runs.importSnapshot({ schemaVersion: 1, runs: [] });
    await roles.importSnapshot({ schemaVersion: 1, roles: [] });
    await connections.importSnapshot({ schemaVersion: 1, connections: [] });
    vault.values.clear();

    const result = await backup.importPackage(exported.package);
    expect(result.relinkedWorkspaces).toBe(1);
    expect(result.needsRepairProjects).toEqual([]);
    expect(result.restored).toMatchObject({
      projects: 1,
      todos: 1,
      runs: 1,
      roles: 1,
      connections: 1,
      workbenchRecords: 1
    });

    expect(await projects.get(seeded.project.id)).toMatchObject({
      id: seeded.project.id,
      workspacePath: workspace,
      workspaceLinkStatus: "linked"
    });
    expect(await todos.get(seeded.todo.id)).toMatchObject({ title: "Ship backup" });
    expect(await runs.get(seeded.run.id)).toMatchObject({ todoId: seeded.todo.id });
    expect(await roles.get(seeded.role.id)).toMatchObject({ name: "Implementer" });
    expect(await connections.get(seeded.connection.id)).toMatchObject({ name: "Router" });
    // Secrets stay out of normal packages; vault is not re-hydrated from backup.
    expect(await vault.read(priorCredentialRef)).toBeUndefined();
    expect(await vault.read((await connections.get(seeded.connection.id)).credentialRef)).toBeUndefined();
    expect(result.warnings.some((warning) => /API Key/i.test(warning))).toBe(true);
  });

  it("marks missing workspace directories as needs-repair after import", async () => {
    const seeded = await seedWorkbench();
    const exported = await backup.exportPackage();
    const missingPath = join(root, "gone-workspace");
    exported.package.projects[0] = {
      ...exported.package.projects[0],
      workspacePath: missingPath
    };
    exported.package.manifest.externalWorkspaces[0] = {
      ...exported.package.manifest.externalWorkspaces[0],
      workspacePath: missingPath
    };

    const result = await backup.importPackage(exported.package);
    expect(result.relinkedWorkspaces).toBe(0);
    expect(result.needsRepairProjects).toEqual([
      {
        projectId: seeded.project.id,
        projectName: "Demo Project",
        workspacePath: missingPath
      }
    ]);
    expect(await projects.get(seeded.project.id)).toMatchObject({
      workspacePath: missingPath,
      workspaceLinkStatus: "needs_repair",
      workspaceRepairNote: expect.stringMatching(/不存在|不可访问/)
    });
  });

  it("does not corrupt current workbench data when import fails", async () => {
    const seeded = await seedWorkbench();
    const beforeProjects = await projects.exportSnapshot();
    const beforeTodos = await todos.exportSnapshot();
    const beforeRuns = await runs.exportSnapshot();
    const beforeRoles = await roles.exportSnapshot();
    const beforeConnections = await connections.exportSnapshot();

    const exported = await backup.exportPackage();
    const broken: BackupPackage = structuredClone(exported.package);
    // Mutate package content so a successful import would change titles — failure must roll back.
    broken.todos[0] = { ...broken.todos[0], title: "SHOULD NOT APPLY" };
    broken.projects[0] = { ...broken.projects[0], name: "SHOULD NOT APPLY PROJECT" };

    // Fail only while applying the poisoned package; rollback must still be able to write.
    let rejectPoisonedTodos = true;
    const failingBackup = new BackupService({
      source: {
        exportProjects: () => projects.exportSnapshot(),
        exportTodos: () => todos.exportSnapshot(),
        exportRuns: () => runs.exportSnapshot(),
        exportRoles: () => roles.exportSnapshot(),
        exportConnections: () => connections.exportSnapshot(),
        exportSettings: async () => ({ locale: "zh-CN" }),
        exportWorkbenchRecords: async () => []
      },
      sink: {
        importProjects: (snapshot) => projects.importSnapshot(snapshot),
        importTodos: async (snapshot) => {
          if (rejectPoisonedTodos && snapshot.todos.some((todo) => todo.title === "SHOULD NOT APPLY")) {
            rejectPoisonedTodos = false;
            throw new Error("simulated import failure");
          }
          await todos.importSnapshot(snapshot);
        },
        importRuns: (snapshot) => runs.importSnapshot(snapshot),
        importRoles: (snapshot) => roles.importSnapshot(snapshot),
        importConnections: (snapshot) => connections.importSnapshot(snapshot),
        importSettings: async () => undefined,
        importWorkbenchRecords: async () => undefined
      },
      workspaceChecker: { directoryExists: async () => true },
      stagingDirectory: join(dataDirectory, ".backup-import-staging-fail")
    });

    await expect(failingBackup.importPackage(broken)).rejects.toThrow(/simulated import failure/);

    expect(await projects.exportSnapshot()).toEqual(beforeProjects);
    expect(await todos.exportSnapshot()).toEqual(beforeTodos);
    expect(await runs.exportSnapshot()).toEqual(beforeRuns);
    expect(await roles.exportSnapshot()).toEqual(beforeRoles);
    expect(await connections.exportSnapshot()).toEqual(beforeConnections);
    expect(await projects.get(seeded.project.id)).toMatchObject({ name: "Demo Project" });
    expect(await todos.get(seeded.todo.id)).toMatchObject({ title: "Ship backup" });
  });

  it("rejects packages that smuggle secret values", async () => {
    await seedWorkbench();
    const exported = await backup.exportPackage();
    const smuggled = {
      ...exported.package,
      connections: [
        {
          ...exported.package.connections[0],
          apiKey: "evil-key",
          secretsExcluded: true
        }
      ]
    };
    await expect(backup.importPackage(smuggled)).rejects.toThrow(/API Key|secret/i);
    expect(await projects.list()).toHaveLength(1);
  });

  it("rejects unsupported schema versions without mutating live data", async () => {
    await seedWorkbench();
    await expect(
      backup.importPackage({
        schemaVersion: 999,
        kind: "personal-ai-workbench-backup",
        projects: [],
        todos: [],
        runs: [],
        roles: [],
        connections: [],
        settings: {},
        workbenchRecords: [],
        manifest: { secretsExcluded: true, includesProjectFiles: false, externalWorkspaces: [], notes: [] }
      })
    ).rejects.toThrow(/schema version/i);
    expect((await projects.list())[0]?.name).toBe("Demo Project");
  });

  it("exposes export and import over local HTTP without leaking secrets", async () => {
    await seedWorkbench();
    const app = createApp({
      version: "0.1.0",
      projects,
      todos,
      runs,
      roles,
      connections,
      backup
    });

    const exported = await request(app).get("/api/backup/export").expect(200);
    expect(exported.body.package.kind).toBe("personal-ai-workbench-backup");
    expect(JSON.stringify(exported.body)).not.toContain(secretApiKey);
    expect(exported.body.package.manifest.externalWorkspaces.length).toBe(1);

    await projects.importSnapshot({ schemaVersion: 1, projects: [] });
    await todos.importSnapshot({ schemaVersion: 1, todos: [] });
    await runs.importSnapshot({ schemaVersion: 1, runs: [] });
    await roles.importSnapshot({ schemaVersion: 1, roles: [] });
    await connections.importSnapshot({ schemaVersion: 1, connections: [] });

    const restored = await request(app)
      .post("/api/backup/import")
      .send({ package: exported.body.package })
      .expect(200);
    expect(restored.body.restored.projects).toBe(1);
    expect(restored.body.relinkedWorkspaces).toBe(1);
    expect((await projects.list())[0]?.workspaceLinkStatus).toBe("linked");
  });

  it("accepts backup import bodies larger than the default 1mb JSON limit", async () => {
    await seedWorkbench();
    const exported = await backup.exportPackage();
    // Inflate timeline payload past the 1mb default while staying under the 50mb import cap.
    exported.package.todos[0] = {
      ...exported.package.todos[0],
      description: "x".repeat(1.5 * 1024 * 1024)
    };
    const app = createApp({
      version: "0.1.0",
      projects,
      todos,
      runs,
      roles,
      connections,
      backup
    });
    const payloadBytes = Buffer.byteLength(JSON.stringify({ package: exported.package }), "utf8");
    expect(payloadBytes).toBeGreaterThan(1024 * 1024);

    const restored = await request(app)
      .post("/api/backup/import")
      .send({ package: exported.package })
      .expect(200);
    expect(restored.body.restored.todos).toBe(1);
    expect((await todos.get(exported.package.todos[0].id)).description?.length).toBe(1.5 * 1024 * 1024);
  });

  it("parseAndValidatePackage requires secretsExcluded and forbids project file payloads", () => {
    expect(() =>
      parseAndValidatePackage({
        schemaVersion: 1,
        kind: "personal-ai-workbench-backup",
        projects: [],
        todos: [],
        runs: [],
        roles: [],
        connections: [],
        settings: {},
        workbenchRecords: [],
        manifest: { secretsExcluded: false, includesProjectFiles: false, externalWorkspaces: [], notes: [] }
      })
    ).toThrow(/secretsExcluded/);

    expect(() =>
      parseAndValidatePackage({
        schemaVersion: 1,
        kind: "personal-ai-workbench-backup",
        projects: [],
        todos: [],
        runs: [],
        roles: [],
        connections: [],
        settings: {},
        workbenchRecords: [],
        manifest: { secretsExcluded: true, includesProjectFiles: true, externalWorkspaces: [], notes: [] }
      })
    ).toThrow(/project files/i);
  });

  it("FileSettingsWorkbenchStore persists settings and workbench records for migration", async () => {
    const store = new FileSettingsWorkbenchStore(
      join(dataDirectory, "settings2.json"),
      join(dataDirectory, "workbench2.json")
    );
    await store.importSettings({ locale: "en-US", apiKey: "must-strip" } as never);
    await store.importWorkbenchRecords([
      {
        id: "r1",
        kind: "note",
        data: { password: "nope", keep: true },
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ]);
    expect(await store.exportSettings()).toEqual({ locale: "en-US" });
    expect(await store.exportWorkbenchRecords()).toEqual([
      expect.objectContaining({
        id: "r1",
        data: { keep: true }
      })
    ]);
    expect(await readFile(join(dataDirectory, "settings2.json"), "utf8")).not.toContain("must-strip");
  });
});
