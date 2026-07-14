import { join } from "node:path";
import type { ConnectionService } from "../connections/connectionService.js";
import type { ProjectService } from "../projects/projectService.js";
import type { RoleService } from "../roles/roleService.js";
import type { RunService } from "../runs/runService.js";
import type { TodoService } from "../todos/todoService.js";
import { BackupService, FileSettingsWorkbenchStore, fsDirectoryExists } from "./backupService.js";
import type { BackupDataSink, BackupDataSource, WorkspacePresenceChecker } from "./backupTypes.js";

export interface BackupServiceDependencies {
  dataDirectory: string;
  projects: ProjectService;
  todos: TodoService;
  runs: RunService;
  roles: RoleService;
  connections: ConnectionService;
  appVersion?: string;
  workspaceChecker?: WorkspacePresenceChecker;
}

/**
 * Wires BackupService to live domain services + file-backed settings / .workbench records.
 * Additive only — does not alter queue or concurrency subsystems.
 */
export function createBackupService(deps: BackupServiceDependencies): BackupService {
  const store = new FileSettingsWorkbenchStore(
    join(deps.dataDirectory, "settings.json"),
    join(deps.dataDirectory, "workbench-records.json")
  );

  const source: BackupDataSource = {
    exportProjects: () => deps.projects.exportSnapshot(),
    exportTodos: () => deps.todos.exportSnapshot(),
    exportRuns: () => deps.runs.exportSnapshot(),
    exportRoles: () => deps.roles.exportSnapshot(),
    exportConnections: () => deps.connections.exportSnapshot(),
    exportSettings: () => store.exportSettings(),
    exportWorkbenchRecords: () => store.exportWorkbenchRecords()
  };

  const sink: BackupDataSink = {
    importProjects: (snapshot) => deps.projects.importSnapshot(snapshot),
    importTodos: (snapshot) => deps.todos.importSnapshot(snapshot),
    importRuns: (snapshot) => deps.runs.importSnapshot(snapshot),
    importRoles: (snapshot) => deps.roles.importSnapshot(snapshot),
    importConnections: (snapshot) => deps.connections.importSnapshot(snapshot),
    importSettings: (settings) => store.importSettings(settings),
    importWorkbenchRecords: (records) => store.importWorkbenchRecords(records)
  };

  return new BackupService({
    source,
    sink,
    workspaceChecker: deps.workspaceChecker ?? { directoryExists: fsDirectoryExists },
    appVersion: deps.appVersion,
    stagingDirectory: join(deps.dataDirectory, ".backup-import-staging")
  });
}
