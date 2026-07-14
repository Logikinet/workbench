import type { AgentRole } from "../roles/roleService.js";
import type { ModelConnection } from "../connections/connectionService.js";
import type { Project } from "../projects/projectService.js";
import type { Run } from "../runs/runService.js";
import type { Todo } from "../todos/todoService.js";

/** Schema version of the portable backup package document. */
export const BACKUP_PACKAGE_SCHEMA_VERSION = 1 as const;

export const BACKUP_PACKAGE_KIND = "personal-ai-workbench-backup" as const;

export interface ExternalWorkspaceEntry {
  projectId: string;
  projectName: string;
  workspacePath: string;
  /** User-facing note: large project trees are not in the package. */
  note: string;
}

export interface NonSensitiveSettings {
  /** Free-form non-secret preferences only (locale, UI hints, etc.). */
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Lightweight .workbench-style records kept by the workbench itself.
 * Never carries file bodies from external project trees.
 */
export interface WorkbenchRecord {
  id: string;
  kind: string;
  projectId?: string;
  path?: string;
  data?: Record<string, unknown>;
  updatedAt: string;
}

/**
 * Connection row as stored in a normal backup package.
 * credentialRef is an opaque vault key placeholder — secret values are never included.
 */
export interface BackupConnection {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  /** Opaque Credential Manager reference; never a secret value. */
  credentialRef: string;
  secretsExcluded: true;
  createdAt: string;
  updatedAt: string;
}

export interface BackupManifest {
  secretsExcluded: true;
  includesProjectFiles: false;
  externalWorkspaces: ExternalWorkspaceEntry[];
  notes: string[];
}

export interface BackupPackage {
  schemaVersion: typeof BACKUP_PACKAGE_SCHEMA_VERSION;
  kind: typeof BACKUP_PACKAGE_KIND;
  exportedAt: string;
  appVersion?: string;
  manifest: BackupManifest;
  projects: Project[];
  todos: Todo[];
  runs: Run[];
  roles: AgentRole[];
  connections: BackupConnection[];
  settings: NonSensitiveSettings;
  workbenchRecords: WorkbenchRecord[];
}

export interface ExportBackupResult {
  package: BackupPackage;
  /** Serialized JSON package (UTF-8). */
  json: string;
}

export interface ImportBackupResult {
  restored: {
    projects: number;
    todos: number;
    runs: number;
    roles: number;
    connections: number;
    workbenchRecords: number;
  };
  relinkedWorkspaces: number;
  needsRepairProjects: Array<{ projectId: string; projectName: string; workspacePath: string }>;
  warnings: string[];
}

export interface BackupDataSource {
  exportProjects(): Promise<{ schemaVersion: 1; projects: Project[] }>;
  exportTodos(): Promise<{ schemaVersion: 1; todos: Todo[] }>;
  exportRuns(): Promise<{ schemaVersion: 1; runs: Run[] }>;
  exportRoles(): Promise<{ schemaVersion: 1; roles: AgentRole[] }>;
  /**
   * Connection index only. Implementations must not read the credential vault
   * when producing this snapshot for backup.
   */
  exportConnections(): Promise<{ schemaVersion: 1; connections: ModelConnection[] }>;
  exportSettings(): Promise<NonSensitiveSettings>;
  exportWorkbenchRecords(): Promise<WorkbenchRecord[]>;
}

export interface BackupDataSink {
  importProjects(snapshot: { schemaVersion: 1; projects: Project[] }): Promise<void>;
  importTodos(snapshot: { schemaVersion: 1; todos: Todo[] }): Promise<void>;
  importRuns(snapshot: { schemaVersion: 1; runs: Run[] }): Promise<void>;
  importRoles(snapshot: { schemaVersion: 1; roles: AgentRole[] }): Promise<void>;
  importConnections(snapshot: { schemaVersion: 1; connections: ModelConnection[] }): Promise<void>;
  importSettings(settings: NonSensitiveSettings): Promise<void>;
  importWorkbenchRecords(records: WorkbenchRecord[]): Promise<void>;
}

export interface WorkspacePresenceChecker {
  directoryExists(path: string): Promise<boolean>;
}
