import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelConnection } from "../connections/connectionService.js";
import type { Project } from "../projects/projectService.js";
import {
  BACKUP_PACKAGE_KIND,
  BACKUP_PACKAGE_SCHEMA_VERSION,
  type BackupConnection,
  type BackupDataSink,
  type BackupDataSource,
  type BackupPackage,
  type ExportBackupResult,
  type ImportBackupResult,
  type NonSensitiveSettings,
  type WorkbenchRecord,
  type WorkspacePresenceChecker
} from "./backupTypes.js";

const EXTERNAL_WORKSPACE_NOTE =
  "外部主工作区未打包进备份；请自行备份该目录下的大型项目文件。工作台仅保存索引与路径引用。";

const SECRET_KEY_PATTERN =
  /"(apiKey|password|passwd|secret|token|accessToken|refreshToken|authorization|credential|harnessPassword|officialPassword)"\s*:\s*"(?:[^"\\]|\\.)+"/i;

export interface BackupServiceOptions {
  source: BackupDataSource;
  sink: BackupDataSink;
  workspaceChecker: WorkspacePresenceChecker;
  appVersion?: string;
  /**
   * Optional durable staging directory for atomic import (temp write → validate → apply).
   * When set, failed imports leave the live workbench untouched and clean up staging.
   */
  stagingDirectory?: string;
}

export class BackupService {
  constructor(private readonly options: BackupServiceOptions) {}

  async exportPackage(): Promise<ExportBackupResult> {
    const [projectsSnap, todosSnap, runsSnap, rolesSnap, connectionsSnap, settings, workbenchRecords] =
      await Promise.all([
        this.options.source.exportProjects(),
        this.options.source.exportTodos(),
        this.options.source.exportRuns(),
        this.options.source.exportRoles(),
        this.options.source.exportConnections(),
        this.options.source.exportSettings(),
        this.options.source.exportWorkbenchRecords()
      ]);

    const projects = projectsSnap.projects.map((project) => sanitizeProjectForExport(project));
    const connections = connectionsSnap.connections.map((connection) => redactConnection(connection));
    const externalWorkspaces = projects.map((project) => ({
      projectId: project.id,
      projectName: project.name,
      workspacePath: project.workspacePath,
      note: EXTERNAL_WORKSPACE_NOTE
    }));

    const pkg: BackupPackage = {
      schemaVersion: BACKUP_PACKAGE_SCHEMA_VERSION,
      kind: BACKUP_PACKAGE_KIND,
      exportedAt: new Date().toISOString(),
      appVersion: this.options.appVersion,
      manifest: {
        secretsExcluded: true,
        includesProjectFiles: false,
        externalWorkspaces,
        notes: [
          "此备份不包含 API Key、官方账号密码或 Harness 登录凭据。",
          "此备份不包含大型项目文件；请按 manifest.externalWorkspaces 自行备份外部工作区。",
          "恢复到另一台 Windows 电脑后，请重新保存模型连接的 API Key，并确认缺失工作区路径。"
        ]
      },
      projects,
      todos: structuredClone(todosSnap.todos),
      runs: structuredClone(runsSnap.runs),
      roles: structuredClone(rolesSnap.roles),
      connections,
      settings: sanitizeSettings(settings),
      workbenchRecords: sanitizeWorkbenchRecords(workbenchRecords)
    };

    assertPackageHasNoSecrets(pkg);
    const json = `${JSON.stringify(pkg, null, 2)}\n`;
    assertSerializedHasNoSecrets(json);
    return { package: pkg, json };
  }

  /**
   * Import a backup package with rollback: capture live snapshots first, apply prepared
   * state, and restore previous snapshots if any apply step fails.
   */
  async importPackage(input: unknown): Promise<ImportBackupResult> {
    const prepared = await this.prepareImport(input);
    const previous = await this.captureLive();
    const stagingDirectory = this.options.stagingDirectory;

    if (stagingDirectory) {
      await this.writeStaging(stagingDirectory, prepared.package);
    }

    try {
      await this.applyLive(prepared.package);
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      return prepared.result;
    } catch (error) {
      try {
        await this.applyLive(previous);
      } catch (rollbackError) {
        const message = error instanceof Error ? error.message : "Import failed.";
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : "Rollback failed.";
        throw new Error(`Import failed and rollback also failed: ${message}; ${rollbackMessage}`);
      }
      if (stagingDirectory) {
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error instanceof Error ? error : new Error("Import failed.");
    }
  }

  private async prepareImport(input: unknown): Promise<{ package: BackupPackage; result: ImportBackupResult }> {
    const pkg = parseAndValidatePackage(input);
    assertPackageHasNoSecrets(pkg);
    assertSerializedHasNoSecrets(JSON.stringify(pkg));

    const needsRepairProjects: ImportBackupResult["needsRepairProjects"] = [];
    let relinkedWorkspaces = 0;
    const projects: Project[] = [];

    for (const project of pkg.projects) {
      const exists = await this.options.workspaceChecker.directoryExists(project.workspacePath);
      if (exists) {
        relinkedWorkspaces += 1;
        projects.push({
          ...project,
          workspaceLinkStatus: "linked",
          workspaceRepairNote: undefined
        });
      } else {
        needsRepairProjects.push({
          projectId: project.id,
          projectName: project.name,
          workspacePath: project.workspacePath
        });
        projects.push({
          ...project,
          workspaceLinkStatus: "needs_repair",
          workspaceRepairNote: `工作区目录不存在或不可访问：${project.workspacePath}`
        });
      }
    }

    const connections: ModelConnection[] = pkg.connections.map((entry) => ({
      id: entry.id,
      name: entry.name,
      baseUrl: entry.baseUrl,
      modelId: entry.modelId,
      enabled: entry.enabled,
      credentialRef: entry.credentialRef,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    }));

    const livePackage: BackupPackage = {
      ...pkg,
      projects,
      connections: connections.map(redactConnection),
      settings: sanitizeSettings(pkg.settings),
      workbenchRecords: sanitizeWorkbenchRecords(pkg.workbenchRecords)
    };

    const warnings = [
      ...needsRepairProjects.map(
        (entry) => `项目“${entry.projectName}”的工作区待修复：${entry.workspacePath}`
      ),
      "模型连接的 API Key 未包含在备份中；请在本机重新保存凭据。"
    ];

    return {
      package: livePackage,
      result: {
        restored: {
          projects: livePackage.projects.length,
          todos: livePackage.todos.length,
          runs: livePackage.runs.length,
          roles: livePackage.roles.length,
          connections: connections.length,
          workbenchRecords: livePackage.workbenchRecords.length
        },
        relinkedWorkspaces,
        needsRepairProjects,
        warnings
      }
    };
  }

  private async captureLive(): Promise<BackupPackage> {
    const exported = await this.exportPackage();
    return exported.package;
  }

  private async applyLive(pkg: BackupPackage): Promise<void> {
    const connections: ModelConnection[] = pkg.connections.map((entry) => ({
      id: entry.id,
      name: entry.name,
      baseUrl: entry.baseUrl,
      modelId: entry.modelId,
      enabled: entry.enabled,
      credentialRef: entry.credentialRef,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    }));

    await this.options.sink.importProjects({ schemaVersion: 1, projects: structuredClone(pkg.projects) });
    await this.options.sink.importTodos({ schemaVersion: 1, todos: structuredClone(pkg.todos) });
    await this.options.sink.importRuns({ schemaVersion: 1, runs: structuredClone(pkg.runs) });
    await this.options.sink.importRoles({ schemaVersion: 1, roles: structuredClone(pkg.roles) });
    await this.options.sink.importConnections({ schemaVersion: 1, connections });
    await this.options.sink.importSettings(sanitizeSettings(pkg.settings));
    await this.options.sink.importWorkbenchRecords(sanitizeWorkbenchRecords(pkg.workbenchRecords));
  }

  private async writeStaging(stagingDirectory: string, pkg: BackupPackage): Promise<void> {
    await mkdir(stagingDirectory, { recursive: true });
    const target = join(stagingDirectory, "package.json");
    const temporaryPath = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(pkg, null, 2)}\n`, {
      encoding: "utf8",
      mode: constants.S_IRUSR | constants.S_IWUSR
    });
    await rename(temporaryPath, target);
  }
}

export function redactConnection(connection: ModelConnection | BackupConnection): BackupConnection {
  return {
    id: connection.id,
    name: connection.name,
    baseUrl: connection.baseUrl,
    modelId: connection.modelId,
    enabled: connection.enabled,
    credentialRef: connection.credentialRef,
    secretsExcluded: true,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

function sanitizeProjectForExport(project: Project): Project {
  return {
    ...project,
    // Export retains path index only; presence is re-evaluated on import.
    workspaceLinkStatus: project.workspaceLinkStatus ?? "linked"
  };
}

function sanitizeSettings(settings: NonSensitiveSettings | undefined): NonSensitiveSettings {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const clean: NonSensitiveSettings = {};
  for (const [key, value] of Object.entries(settings)) {
    if (/apiKey|password|secret|token|credential|passwd/i.test(key)) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      clean[key] = value;
    }
  }
  return clean;
}

function sanitizeWorkbenchRecords(records: WorkbenchRecord[] | undefined): WorkbenchRecord[] {
  if (!Array.isArray(records)) return [];
  return records.map((record) => ({
    id: String(record.id),
    kind: String(record.kind),
    projectId: record.projectId,
    path: record.path,
    data: record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? stripSecretFields(record.data)
      : undefined,
    updatedAt: String(record.updatedAt)
  }));
}

function stripSecretFields(data: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (/apiKey|password|secret|token|credential|passwd/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

export function parseAndValidatePackage(input: unknown): BackupPackage {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Backup package must be a JSON object.");
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.schemaVersion !== BACKUP_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported backup schema version: ${String(candidate.schemaVersion)}.`);
  }
  if (candidate.kind !== BACKUP_PACKAGE_KIND) {
    throw new Error("Backup package kind is not recognized.");
  }
  if (!candidate.manifest || typeof candidate.manifest !== "object" || Array.isArray(candidate.manifest)) {
    throw new Error("Backup package manifest is required.");
  }
  const manifest = candidate.manifest as Record<string, unknown>;
  if (manifest.secretsExcluded !== true) {
    throw new Error("Backup package must declare secretsExcluded.");
  }
  if (manifest.includesProjectFiles === true) {
    throw new Error("Backup packages must not include large project files.");
  }
  if (!Array.isArray(candidate.projects)) throw new Error("Backup package projects are invalid.");
  if (!Array.isArray(candidate.todos)) throw new Error("Backup package todos are invalid.");
  if (!Array.isArray(candidate.runs)) throw new Error("Backup package runs are invalid.");
  if (!Array.isArray(candidate.roles)) throw new Error("Backup package roles are invalid.");
  if (!Array.isArray(candidate.connections)) throw new Error("Backup package connections are invalid.");
  if (!Array.isArray(candidate.workbenchRecords)) throw new Error("Backup package workbench records are invalid.");
  if (!candidate.settings || typeof candidate.settings !== "object" || Array.isArray(candidate.settings)) {
    throw new Error("Backup package settings are invalid.");
  }

  for (const connection of candidate.connections as unknown[]) {
    if (!connection || typeof connection !== "object" || Array.isArray(connection)) {
      throw new Error("Backup connection entries are invalid.");
    }
    const row = connection as Record<string, unknown>;
    if ("apiKey" in row && row.apiKey) {
      throw new Error("Backup package must not contain API Key values.");
    }
    if (row.secretsExcluded !== true) {
      throw new Error("Backup connection entries must declare secretsExcluded.");
    }
    if (typeof row.credentialRef !== "string" || !row.credentialRef.trim()) {
      throw new Error("Backup connection entries require an opaque credentialRef placeholder.");
    }
  }

  return candidate as unknown as BackupPackage;
}

export function assertPackageHasNoSecrets(pkg: BackupPackage): void {
  for (const connection of pkg.connections) {
    if ((connection as { apiKey?: unknown }).apiKey) {
      throw new Error("Backup package must not contain API Key values.");
    }
    if (connection.secretsExcluded !== true) {
      throw new Error("Backup connection entries must declare secretsExcluded.");
    }
  }
  assertSerializedHasNoSecrets(JSON.stringify(pkg));
}

export function assertSerializedHasNoSecrets(serialized: string): void {
  if (SECRET_KEY_PATTERN.test(serialized)) {
    throw new Error("Backup package must not contain secret field values.");
  }
}

export async function fsDirectoryExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    const { stat } = await import("node:fs/promises");
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** File-backed non-sensitive settings + .workbench records under the data directory. */
export class FileSettingsWorkbenchStore {
  constructor(
    private readonly settingsPath: string,
    private readonly workbenchRecordsPath: string
  ) {}

  async exportSettings(): Promise<NonSensitiveSettings> {
    try {
      const decoded = JSON.parse(await readFile(this.settingsPath, "utf8")) as NonSensitiveSettings;
      return sanitizeSettings(decoded);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }
  }

  async importSettings(settings: NonSensitiveSettings): Promise<void> {
    await this.writeJson(this.settingsPath, sanitizeSettings(settings));
  }

  async exportWorkbenchRecords(): Promise<WorkbenchRecord[]> {
    try {
      const decoded = JSON.parse(await readFile(this.workbenchRecordsPath, "utf8")) as {
        schemaVersion?: number;
        records?: WorkbenchRecord[];
      };
      if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.records)) return [];
      return sanitizeWorkbenchRecords(decoded.records);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async importWorkbenchRecords(records: WorkbenchRecord[]): Promise<void> {
    await this.writeJson(this.workbenchRecordsPath, {
      schemaVersion: 1,
      records: sanitizeWorkbenchRecords(records)
    });
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: constants.S_IRUSR | constants.S_IWUSR
    });
    await rename(temporaryPath, path);
  }
}
