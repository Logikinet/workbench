<#
.SYNOPSIS
  Single Windows install flow for Personal AI Workbench (local Agent Service + tray + PWA).

.DESCRIPTION
  Copies service/web/tray build outputs to a user-local install root, creates Start Menu and
  Desktop shortcuts that open the loopback PWA, and never writes secrets.

  Install root (app bits):  %LOCALAPPDATA%\Programs\PersonalAIWorkbench
  Data directory (state):   %LOCALAPPDATA%\PersonalAIWorkbench  (not deleted on uninstall)

.PARAMETER RepoRoot
  Monorepo root containing apps/service, apps/web, apps/tray after `npm run build`.

.PARAMETER InstallRoot
  Optional override for the install directory.

.PARAMETER DataDirectory
  Optional override for durable workbench state (indexes only; Project workspaces stay external).

.PARAMETER Port
  Loopback port for the Agent Service (default 41731).
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$InstallRoot,
  [string]$DataDirectory,
  [int]$Port = 41731,
  [switch]$SkipShortcuts
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "paths.ps1")

function Assert-NodeAvailable {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-PawError -Code "NODE_MISSING" -Message "未找到 Node.js。请安装 Node.js 20+ 并确保 `node` 在 PATH 中，然后重新运行安装程序。"
    exit 1
  }
}

function Assert-BuildArtifacts {
  param([string]$Root)
  $required = @(
    (Join-Path $Root "apps\service\dist\main.js"),
    (Join-Path $Root "apps\web\dist\index.html"),
    (Join-Path $Root "apps\tray\dist\main.js")
  )
  foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path)) {
      Write-PawError -Code "SOURCE_MISSING" -Message "安装源不完整（缺少 service/web/tray 构建产物）。请先在仓库根目录执行 `npm run build`，再运行安装脚本。" -Detail $path
      exit 1
    }
  }
}

function Copy-Tree {
  param(
    [string]$Source,
    [string]$Destination
  )
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Source missing: $Source"
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
}

function New-PawShortcut {
  param(
    [string]$ShortcutPath,
    [string]$TargetPath,
    [string]$Arguments,
    [string]$WorkingDirectory,
    [string]$Description
  )
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $TargetPath
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.Description = $Description
  $shortcut.Save()
}

try {
  Assert-NodeAvailable
  Assert-BuildArtifacts -Root $RepoRoot

  $resolvedInstall = Get-PawInstallRoot -InstallRoot $InstallRoot
  $resolvedData = Get-PawDataDirectory -DataDirectory $DataDirectory
  $displayName = Get-PawDisplayName
  $loopbackUrl = Get-PawLoopbackUrl -Port $Port
  $nodePath = (Get-Command node).Source

  Write-Host "Installing $displayName"
  Write-Host "  Install root : $resolvedInstall"
  Write-Host "  Data directory: $resolvedData (preserved on uninstall)"
  Write-Host "  Loopback URL : $loopbackUrl"

  New-Item -ItemType Directory -Force -Path $resolvedInstall | Out-Null
  New-Item -ItemType Directory -Force -Path $resolvedData | Out-Null

  try {
    # Application bits only — never copy Project workspaces or user secrets into install root.
    Copy-Tree -Source (Join-Path $RepoRoot "apps\service\dist") -Destination (Join-Path $resolvedInstall "service\dist")
    Copy-Item -Path (Join-Path $RepoRoot "apps\service\package.json") -Destination (Join-Path $resolvedInstall "service\package.json") -Force
    Copy-Tree -Source (Join-Path $RepoRoot "apps\web\dist") -Destination (Join-Path $resolvedInstall "web\dist")
    Copy-Tree -Source (Join-Path $RepoRoot "apps\tray\dist") -Destination (Join-Path $resolvedInstall "tray\dist")
    Copy-Item -Path (Join-Path $RepoRoot "apps\tray\package.json") -Destination (Join-Path $resolvedInstall "tray\package.json") -Force

    # pawb CLI (Provider management) — same localhost Agent Service as PWA
    $cliDist = Join-Path $RepoRoot "apps\cli\dist"
    if (Test-Path -LiteralPath $cliDist) {
      Copy-Tree -Source $cliDist -Destination (Join-Path $resolvedInstall "cli\dist")
      Copy-Item -Path (Join-Path $RepoRoot "apps\cli\package.json") -Destination (Join-Path $resolvedInstall "cli\package.json") -Force
      $pawbCmd = @"
@echo off
set PAW_SERVICE_PORT=$Port
"$nodePath" "$resolvedInstall\cli\dist\main.js" %*
"@
      Set-Content -Path (Join-Path $resolvedInstall "pawb.cmd") -Value $pawbCmd -Encoding ASCII
      # User-local PATH shim so PowerShell / CMD / Windows Terminal can run `pawb`
      $shimDir = Join-Path $env:LOCALAPPDATA "PersonalAIWorkbench\bin"
      New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
      Copy-Item -Path (Join-Path $resolvedInstall "pawb.cmd") -Destination (Join-Path $shimDir "pawb.cmd") -Force
      $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
      if ($userPath -notlike "*$shimDir*") {
        [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $shimDir), "User")
        Write-Host "  Registered pawb on user PATH: $shimDir"
      }
    }

    # Deploy NotifyIcon tray host so Start Menu "Tray" is a real system-tray UI (not one-shot CLI).
    $packagingDir = Join-Path $RepoRoot "packaging\windows"
    foreach ($scriptName in @("TrayHost.ps1", "paths.ps1")) {
      $src = Join-Path $packagingDir $scriptName
      if (-not (Test-Path -LiteralPath $src)) {
        throw "Missing packaging script: $src"
      }
      Copy-Item -Path $src -Destination (Join-Path $resolvedInstall $scriptName) -Force
    }

    # Install production runtime deps into the install tree so the product does not depend on the repo checkout.
    $serviceInstall = Join-Path $resolvedInstall "service"
    Push-Location $serviceInstall
    try {
      & npm.cmd install --omit=dev --no-fund --no-audit 2>&1 | Out-Host
      if ($LASTEXITCODE -ne 0) {
        throw "npm install --omit=dev failed with exit $LASTEXITCODE"
      }
    } finally {
      Pop-Location
    }

    # Launchers use absolute install paths only (no secrets; no repo paths).
    # Autostart re-launches the NotifyIcon host (start-tray-host.cmd), not one-shot CLI.
    $trayHostLauncher = Join-Path $resolvedInstall "start-tray-host.cmd"
    $runner = @"
@echo off
set PAW_INSTALL_ROOT=$resolvedInstall
set PAW_DATA_DIR=$resolvedData
set PAW_SERVICE_PORT=$Port
set PAW_WEB_DIST=$resolvedInstall\web\dist
set PAW_SERVICE_ENTRY=$resolvedInstall\service\dist\main.js
set PAW_TRAY_LAUNCH_COMMAND=$trayHostLauncher
"$nodePath" "$resolvedInstall\tray\dist\main.js" %*
"@
    Set-Content -Path (Join-Path $resolvedInstall "paw-tray.cmd") -Value $runner -Encoding ASCII

    $startService = @"
@echo off
set PAW_INSTALL_ROOT=$resolvedInstall
set PAW_DATA_DIR=$resolvedData
set PAW_SERVICE_PORT=$Port
set PAW_WEB_DIST=$resolvedInstall\web\dist
"$nodePath" "$resolvedInstall\service\dist\main.js"
"@
    Set-Content -Path (Join-Path $resolvedInstall "start-service.cmd") -Value $startService -Encoding ASCII

    # Persistent system-tray UI (WinForms NotifyIcon via TrayHost.ps1).
    $startTrayHost = @"
@echo off
set PAW_INSTALL_ROOT=$resolvedInstall
set PAW_DATA_DIR=$resolvedData
set PAW_SERVICE_PORT=$Port
set PAW_WEB_DIST=$resolvedInstall\web\dist
set PAW_SERVICE_ENTRY=$resolvedInstall\service\dist\main.js
set PAW_TRAY_LAUNCH_COMMAND=$trayHostLauncher
start "" /B powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$resolvedInstall\TrayHost.ps1" -InstallRoot "$resolvedInstall" -TrayCommand "$resolvedInstall\paw-tray.cmd"
"@
    Set-Content -Path $trayHostLauncher -Value $startTrayHost -Encoding ASCII

    # Persist install metadata (no secrets).
    $meta = @{
      product = (Get-PawProductName)
      installedAt = (Get-Date).ToString("o")
      installRoot = $resolvedInstall
      dataDirectory = $resolvedData
      port = $Port
      loopbackUrl = $loopbackUrl
      trayHost = (Join-Path $resolvedInstall "TrayHost.ps1")
      version = "0.1.0"
    } | ConvertTo-Json
    Set-Content -Path (Join-Path $resolvedInstall "install-meta.json") -Value $meta -Encoding UTF8
  } catch {
    Write-PawError -Code "INSTALL_COPY_FAILED" -Message "复制应用文件失败。请确认对安装目录有写权限，关闭正在运行的 Personal AI Workbench，然后重试。" -Detail $_.Exception.Message
    exit 1
  }

  if (-not $SkipShortcuts) {
    try {
      $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$(Get-PawDisplayName)"
      New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
      $desktop = [Environment]::GetFolderPath("Desktop")

      $trayCmd = Join-Path $resolvedInstall "paw-tray.cmd"
      $trayHostCmd = Join-Path $resolvedInstall "start-tray-host.cmd"

      # Start Menu "Tray" launches the NotifyIcon host (start/stop/restart/emergency-stop UI).
      New-PawShortcut -ShortcutPath (Join-Path $startMenu "$displayName Tray.lnk") `
        -TargetPath $trayHostCmd -Arguments "" -WorkingDirectory $resolvedInstall `
        -Description "系统托盘：启动/停止/重启服务与紧急停止全部任务"

      # Desktop entry opens the loopback PWA (auto-connects to local service on same origin).
      New-PawShortcut -ShortcutPath (Join-Path $desktop "$displayName.lnk") `
        -TargetPath $trayCmd -Arguments "open-pwa" -WorkingDirectory $resolvedInstall `
        -Description "打开 Personal AI Workbench（本机 loopback）"

      New-PawShortcut -ShortcutPath (Join-Path $startMenu "$displayName.lnk") `
        -TargetPath $trayCmd -Arguments "open-pwa" -WorkingDirectory $resolvedInstall `
        -Description "打开 Personal AI Workbench（本机 loopback）"

      New-PawShortcut -ShortcutPath (Join-Path $startMenu "PWA Install Guide.lnk") `
        -TargetPath $trayCmd -Arguments "open-guide" -WorkingDirectory $resolvedInstall `
        -Description "PWA 安装指引"
    } catch {
      Write-PawError -Code "SHORTCUT_FAILED" -Message "创建开始菜单/桌面快捷方式失败。应用文件可能已安装，可手动打开安装目录中的托盘入口，或修复快捷方式权限后重试。" -Detail $_.Exception.Message
      exit 1
    }
  }

  Write-Host ""
  Write-Host "Install completed."
  Write-Host "Next steps:"
  Write-Host "  1. Start Menu: $displayName Tray  (system tray UI)"
  Write-Host "     or: $resolvedInstall\start-tray-host.cmd"
  Write-Host "  2. Open: $loopbackUrl  (same-origin API auto-connect)"
  Write-Host "  3. Optional autostart: paw-tray.cmd autostart-on  (relaunches tray host)"
  Write-Host "  4. PWA guide: ${loopbackUrl}#pwa-install-guide"
  Write-Host "Data directory is NOT removed on uninstall: $resolvedData"
} catch {
  Write-PawError -Code "INSTALL_COPY_FAILED" -Message "复制应用文件失败。请确认对安装目录有写权限，关闭正在运行的 Personal AI Workbench，然后重试。" -Detail $_.Exception.Message
  exit 1
}
