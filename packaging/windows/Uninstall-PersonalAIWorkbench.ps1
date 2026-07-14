<#
.SYNOPSIS
  Uninstall Personal AI Workbench application bits while preserving workspaces and data.

.DESCRIPTION
  Removes the install root (binaries/scripts/shortcuts). By default it NEVER deletes:
    - %LOCALAPPDATA%\PersonalAIWorkbench (workbench indexes / formal artifacts)
    - Project workspace paths configured by the user

  To delete the workbench data directory you must pass -ConfirmDeleteData and
  -ConfirmationToken DELETE-WORKBENCH-DATA.

.PARAMETER InstallRoot
  Install directory to remove.

.PARAMETER DataDirectory
  Data directory to preserve (or delete only with confirmation).

.PARAMETER ConfirmDeleteData
  Required together with the confirmation token to remove the data directory.

.PARAMETER ConfirmationToken
  Must be DELETE-WORKBENCH-DATA when ConfirmDeleteData is set.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot,
  [string]$DataDirectory,
  [switch]$ConfirmDeleteData,
  [string]$ConfirmationToken,
  [switch]$KeepShortcuts
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "paths.ps1")

$resolvedInstall = Get-PawInstallRoot -InstallRoot $InstallRoot
$resolvedData = Get-PawDataDirectory -DataDirectory $DataDirectory
$displayName = Get-PawDisplayName

Write-Host "Uninstalling $displayName"
Write-Host "  Install root  : $resolvedInstall"
Write-Host "  Data directory: $resolvedData (default: preserve)"

# Refuse nested install-under-data without confirmation (mirrors uninstallPlan.ts).
if ((Test-PawIsProtectedDataPath -Candidate $resolvedInstall -DataDirectory $resolvedData) -and -not $ConfirmDeleteData) {
  Write-PawError -Code "UNINSTALL_REFUSED_DATA" -Message "卸载拒绝删除数据目录、Project 工作区或正式 Artifact。若确需清理工作台数据，请使用显式确认参数并自行备份。" -Detail $resolvedInstall
  exit 1
}

if ($ConfirmDeleteData) {
  if ($ConfirmationToken -ne "DELETE-WORKBENCH-DATA") {
    Write-PawError -Code "CONFIRMATION_REQUIRED" -Message "此操作会删除受保护的工作台数据或外部工作区路径，需要显式确认。未确认则已中止，未删除任何受保护内容。" -Detail "需要确认令牌 DELETE-WORKBENCH-DATA"
    exit 1
  }
}

# Best-effort stop via tray CLI if present.
$trayCmd = Join-Path $resolvedInstall "paw-tray.cmd"
if (Test-Path -LiteralPath $trayCmd) {
  try {
    & $trayCmd stop 2>$null | Out-Null
  } catch {
    Write-PawError -Code "UNINSTALL_RUNNING" -Message "检测到本地服务仍在运行。请先从托盘停止服务（或执行 `paw-tray stop`），再卸载。" -Detail $_.Exception.Message
    exit 1
  }
  # Clear autostart while the CLI is still present (also cleared via reg below).
  try { & $trayCmd autostart-off 2>$null | Out-Null } catch { }
}

# Always clear HKCU Run autostart so logon does not resurrect a deleted install path (S2).
$autostartName = Get-PawProductName
$runKey = "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
try {
  & reg.exe delete $runKey /v $autostartName /f 2>$null | Out-Null
  Write-Host "Cleared autostart Run value: $autostartName"
} catch {
  Write-Host "Autostart Run value already absent or could not be cleared (continuing uninstall)."
}

try {
  if (Test-Path -LiteralPath $resolvedInstall) {
    Remove-Item -LiteralPath $resolvedInstall -Recurse -Force
    Write-Host "Removed install root: $resolvedInstall"
  } else {
    Write-Host "Install root already absent: $resolvedInstall"
  }

  if ($ConfirmDeleteData -and $ConfirmationToken -eq "DELETE-WORKBENCH-DATA") {
    if (Test-Path -LiteralPath $resolvedData) {
      Remove-Item -LiteralPath $resolvedData -Recurse -Force
      Write-Host "Removed data directory after confirmation: $resolvedData"
    }
  } else {
    Write-Host "Preserved data directory (and any Project workspaces outside it): $resolvedData"
  }

  if (-not $KeepShortcuts) {
    $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$displayName"
    if (Test-Path -LiteralPath $startMenu) {
      Remove-Item -LiteralPath $startMenu -Recurse -Force
    }
    $desktopLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "$displayName.lnk"
    if (Test-Path -LiteralPath $desktopLnk) {
      Remove-Item -LiteralPath $desktopLnk -Force
    }
  }
} catch {
  Write-PawError -Code "UNINSTALL_REMOVE_FAILED" -Message "删除安装文件失败。请关闭托盘/服务进程后重试；数据目录与 Project 工作区已保留。" -Detail $_.Exception.Message
  exit 1
}

Write-Host "Uninstall completed. Project workspaces were not deleted."
