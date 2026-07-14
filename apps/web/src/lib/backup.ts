import { createJsonRequest } from "./apiClient.js";

export interface BackupExternalWorkspace {
  projectId: string;
  projectName: string;
  workspacePath: string;
  note: string;
}

export interface BackupPackage {
  schemaVersion: number;
  kind: string;
  exportedAt: string;
  appVersion?: string;
  manifest: {
    secretsExcluded: boolean;
    includesProjectFiles: boolean;
    externalWorkspaces: BackupExternalWorkspace[];
    notes: string[];
  };
  projects: unknown[];
  todos: unknown[];
  runs: unknown[];
  roles: unknown[];
  connections: unknown[];
  settings: Record<string, unknown>;
  workbenchRecords: unknown[];
}

export interface BackupExportResponse {
  package: BackupPackage;
  filename: string;
}

export interface BackupImportResult {
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

export function createBackupClient(serviceUrl: string) {
  const requestJson = createJsonRequest(serviceUrl);
  return {
    exportPackage: () => requestJson<BackupExportResponse>("/api/backup/export"),
    importPackage: (backupPackage: BackupPackage) =>
      requestJson<BackupImportResult>("/api/backup/import", {
        method: "POST",
        body: JSON.stringify({ package: backupPackage })
      })
  };
}
