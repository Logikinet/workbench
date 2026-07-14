/**
 * Actionable installer / upgrade / uninstall error messages.
 * PowerShell packaging scripts should reuse these codes and text.
 */
export const InstallerErrorCode = {
  NODE_MISSING: "NODE_MISSING",
  SOURCE_MISSING: "SOURCE_MISSING",
  INSTALL_COPY_FAILED: "INSTALL_COPY_FAILED",
  SHORTCUT_FAILED: "SHORTCUT_FAILED",
  UPGRADE_BACKUP_FAILED: "UPGRADE_BACKUP_FAILED",
  UPGRADE_RESTORE_FAILED: "UPGRADE_RESTORE_FAILED",
  UNINSTALL_RUNNING: "UNINSTALL_RUNNING",
  UNINSTALL_REFUSED_DATA: "UNINSTALL_REFUSED_DATA",
  UNINSTALL_REMOVE_FAILED: "UNINSTALL_REMOVE_FAILED",
  PATH_RESOLVE_FAILED: "PATH_RESOLVE_FAILED",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED"
} as const;

export type InstallerErrorCode = (typeof InstallerErrorCode)[keyof typeof InstallerErrorCode];

const messages: Record<InstallerErrorCode, string> = {
  NODE_MISSING:
    "未找到 Node.js。请安装 Node.js 20+ 并确保 `node` 在 PATH 中，然后重新运行安装程序。",
  SOURCE_MISSING:
    "安装源不完整（缺少 service/web/tray 构建产物）。请先在仓库根目录执行 `npm run build`，再运行安装脚本。",
  INSTALL_COPY_FAILED:
    "复制应用文件失败。请确认对安装目录有写权限，关闭正在运行的 Personal AI Workbench，然后重试。",
  SHORTCUT_FAILED:
    "创建开始菜单/桌面快捷方式失败。应用文件可能已安装，可手动打开安装目录中的托盘入口，或修复快捷方式权限后重试。",
  UPGRADE_BACKUP_FAILED:
    "升级前备份当前安装失败。未修改现有安装。请检查磁盘空间与权限后重试。",
  UPGRADE_RESTORE_FAILED:
    "升级失败且无法自动回滚。请从备份目录手动恢复安装文件，或重新运行安装程序。数据目录未被修改。",
  UNINSTALL_RUNNING:
    "检测到本地服务仍在运行。请先从托盘停止服务（或执行 `paw-tray stop`），再卸载。",
  UNINSTALL_REFUSED_DATA:
    "卸载拒绝删除数据目录、Project 工作区或正式 Artifact。若确需清理工作台数据，请使用显式确认参数并自行备份。",
  UNINSTALL_REMOVE_FAILED:
    "删除安装文件失败。请关闭托盘/服务进程后重试；数据目录与 Project 工作区已保留。",
  PATH_RESOLVE_FAILED:
    "无法解析安装或数据路径。请设置 LOCALAPPDATA，或显式传入 -InstallRoot / -DataDirectory。",
  CONFIRMATION_REQUIRED:
    "此操作会删除受保护的工作台数据或外部工作区路径，需要显式确认。未确认则已中止，未删除任何受保护内容。"
};

export function installerErrorMessage(code: InstallerErrorCode): string {
  return messages[code];
}

export function formatInstallerFailure(code: InstallerErrorCode, detail?: string): string {
  const base = installerErrorMessage(code);
  if (!detail?.trim()) return `[${code}] ${base}`;
  return `[${code}] ${base} 详情：${detail.trim()}`;
}
