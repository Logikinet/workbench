import { useState } from "react";
import {
  createBackupClient,
  type BackupImportResult,
  type BackupPackage
} from "../lib/backup.js";

interface BackupPanelProps {
  serviceUrl: string;
  available: boolean;
  /** Called after a successful import so sibling panels can refresh (e.g. 待修复 tags). */
  onImportSuccess?: () => void;
}

export function BackupPanel({ serviceUrl, available, onImportSuccess }: BackupPanelProps) {
  const client = createBackupClient(serviceUrl);
  const [notice, setNotice] = useState("");
  const [lastImport, setLastImport] = useState<BackupImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const downloadExport = async () => {
    if (!available) return;
    setBusy(true);
    setNotice("");
    try {
      const exported = await client.exportPackage();
      const blob = new Blob([`${JSON.stringify(exported.package, null, 2)}\n`], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exported.filename || "personal-ai-workbench-backup.json";
      anchor.click();
      URL.revokeObjectURL(url);
      const workspaceCount = exported.package.manifest.externalWorkspaces.length;
      setNotice(
        `已导出工作台数据（不含 API Key 与大型项目文件）。外部工作区 ${workspaceCount} 个需自行备份。`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法导出备份");
    } finally {
      setBusy(false);
    }
  };

  const importFromFile = async (file: File | undefined) => {
    if (!available || !file) return;
    if (!window.confirm("导入将替换当前工作台索引数据。若导入失败会自动回滚。是否继续？")) {
      return;
    }
    setBusy(true);
    setNotice("");
    setLastImport(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as BackupPackage;
      const result = await client.importPackage(parsed);
      setLastImport(result);
      const repair = result.needsRepairProjects.length;
      setNotice(
        repair > 0
          ? `导入完成：${result.restored.projects} 个项目；${repair} 个工作区待修复。请重新保存 API Key。`
          : `导入完成：已恢复 ${result.restored.projects} 个项目、${result.restored.todos} 个 Todo。请重新保存 API Key。`
      );
      onImportSuccess?.();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法导入备份（当前数据未改动）");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="workspace-panel" aria-labelledby="backup-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">BACKUP &amp; MIGRATION</p>
          <h2 id="backup-title">备份与迁移</h2>
        </div>
      </div>
      <p className="backup-help">
        导出 Project 索引、Todo、Run、Agent Role、非敏感设置与 .workbench 记录。不会打包 API Key、账号密码、Harness
        凭据或大型项目文件。导入请求体上限 50MB（其他接口仍为 1MB）。
      </p>
      <div className="project-actions backup-actions">
        <button type="button" disabled={!available || busy} onClick={() => void downloadExport()}>
          导出备份 JSON
        </button>
        <label className={`file-import-label ${!available || busy ? "disabled" : ""}`}>
          导入备份 JSON
          <input
            type="file"
            accept="application/json,.json"
            disabled={!available || busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void importFromFile(file);
            }}
          />
        </label>
      </div>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {lastImport && (
        <div className="backup-result">
          <p>
            已关联工作区 {lastImport.relinkedWorkspaces} 个；待修复{" "}
            {lastImport.needsRepairProjects.length} 个。
          </p>
          {lastImport.needsRepairProjects.length > 0 && (
            <ul className="backup-repair-list">
              {lastImport.needsRepairProjects.map((entry) => (
                <li key={entry.projectId}>
                  <strong>{entry.projectName}</strong>
                  <span>{entry.workspacePath}</span>
                </li>
              ))}
            </ul>
          )}
          {lastImport.warnings.length > 0 && (
            <ul className="backup-warning-list">
              {lastImport.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
