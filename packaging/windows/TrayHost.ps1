<#
.SYNOPSIS
  Lightweight Windows system-tray host for Personal AI Workbench.

.DESCRIPTION
  Uses WinForms NotifyIcon so CI does not need interactive tray automation — unit tests cover
  TrayController actions. This host simply invokes paw-tray.cmd for each menu item.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot,
  [string]$TrayCommand
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "paths.ps1")

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$resolvedInstall = if ($InstallRoot) { $InstallRoot } else { Get-PawInstallRoot }
$cmd = if ($TrayCommand) { $TrayCommand } else { Join-Path $resolvedInstall "paw-tray.cmd" }
if (-not (Test-Path -LiteralPath $cmd)) {
  [System.Windows.Forms.MessageBox]::Show(
    "未找到托盘入口：$cmd`n请先运行 Install-PersonalAIWorkbench.ps1。",
    (Get-PawDisplayName),
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}

function Invoke-TrayAction {
  param([string]$Action)
  try {
    $output = & $cmd $Action 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      [System.Windows.Forms.MessageBox]::Show(
        $output,
        "$(Get-PawDisplayName) — $Action 失败",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
      ) | Out-Null
    }
  } catch {
    [System.Windows.Forms.MessageBox]::Show(
      $_.Exception.Message,
      "$(Get-PawDisplayName) — 错误",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$actions = @(
  @{ Text = "启动服务"; Action = "start" },
  @{ Text = "停止服务"; Action = "stop" },
  @{ Text = "重启服务"; Action = "restart" },
  @{ Text = "紧急停止全部任务"; Action = "emergency-stop" },
  @{ Text = "打开工作台"; Action = "open-pwa" },
  @{ Text = "打开 PWA 安装指引"; Action = "open-guide" },
  @{ Text = "切换开机自启"; Action = "autostart-toggle" },
  @{ Text = "服务状态"; Action = "status" }
)

foreach ($entry in $actions) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem $entry.Text
  $actionName = $entry.Action
  $item.Add_Click({ Invoke-TrayAction -Action $actionName }.GetNewClosure())
  [void]$menu.Items.Add($item)
}

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = New-Object System.Windows.Forms.ToolStripMenuItem "退出托盘"
$quit.Add_Click({
  $script:notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($quit)

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = Get-PawDisplayName
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.ContextMenuStrip = $menu
$notify.Visible = $true
$notify.Add_DoubleClick({ Invoke-TrayAction -Action "open-pwa" })

# Start service on tray launch for a ready desktop experience.
Invoke-TrayAction -Action "start"

[System.Windows.Forms.Application]::Run()
$notify.Dispose()
