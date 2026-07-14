<#
.SYNOPSIS
  Upgrade an existing Personal AI Workbench install in place.

.DESCRIPTION
  Backs up the current install root, copies new build artifacts, and rolls back on failure.
  Never modifies the data directory or Project workspaces. Does not store secrets.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$InstallRoot,
  [string]$DataDirectory,
  [int]$Port = 41731
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "paths.ps1")

$resolvedInstall = Get-PawInstallRoot -InstallRoot $InstallRoot
$resolvedData = Get-PawDataDirectory -DataDirectory $DataDirectory
$backupRoot = Join-Path $env:TEMP ("paw-upgrade-backup-" + [guid]::NewGuid().ToString("N"))

if (-not (Test-Path -LiteralPath $resolvedInstall)) {
  Write-Host "No existing install at $resolvedInstall — running fresh install."
  & (Join-Path $PSScriptRoot "Install-PersonalAIWorkbench.ps1") -RepoRoot $RepoRoot -InstallRoot $resolvedInstall -DataDirectory $resolvedData -Port $Port
  exit $LASTEXITCODE
}

Write-Host "Upgrading install at $resolvedInstall"
Write-Host "Data directory remains: $resolvedData"

try {
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  Copy-Item -Path (Join-Path $resolvedInstall "*") -Destination $backupRoot -Recurse -Force
} catch {
  Write-PawError -Code "UPGRADE_BACKUP_FAILED" -Message "升级前备份当前安装失败。未修改现有安装。请检查磁盘空间与权限后重试。" -Detail $_.Exception.Message
  exit 1
}

$trayCmd = Join-Path $resolvedInstall "paw-tray.cmd"
if (Test-Path -LiteralPath $trayCmd) {
  try { & $trayCmd stop 2>$null | Out-Null } catch { }
}

try {
  & (Join-Path $PSScriptRoot "Install-PersonalAIWorkbench.ps1") `
    -RepoRoot $RepoRoot `
    -InstallRoot $resolvedInstall `
    -DataDirectory $resolvedData `
    -Port $Port
  if ($LASTEXITCODE -ne 0) { throw "Install step failed with exit $LASTEXITCODE" }
  Write-Host "Upgrade completed. Backup retained at $backupRoot (safe to delete)."
} catch {
  Write-Host "Upgrade failed — attempting rollback from $backupRoot"
  try {
    if (Test-Path -LiteralPath $resolvedInstall) {
      Remove-Item -LiteralPath $resolvedInstall -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $resolvedInstall | Out-Null
    Copy-Item -Path (Join-Path $backupRoot "*") -Destination $resolvedInstall -Recurse -Force
    Write-Host "Rollback restored previous install. Data directory was not modified."
  } catch {
    Write-PawError -Code "UPGRADE_RESTORE_FAILED" -Message "升级失败且无法自动回滚。请从备份目录手动恢复安装文件，或重新运行安装程序。数据目录未被修改。" -Detail "backup=$backupRoot; $($_.Exception.Message)"
    exit 1
  }
  Write-PawError -Code "INSTALL_COPY_FAILED" -Message "复制应用文件失败。请确认对安装目录有写权限，关闭正在运行的 Personal AI Workbench，然后重试。" -Detail $_.Exception.Message
  exit 1
}
