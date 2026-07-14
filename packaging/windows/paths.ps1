# Shared path helpers for Personal AI Workbench Windows packaging.
# Data and Project workspaces stay outside the install root by design.

$ErrorActionPreference = "Stop"

function Get-PawProductName {
  return "PersonalAIWorkbench"
}

function Get-PawDisplayName {
  return "Personal AI Workbench"
}

function Get-PawDefaultPort {
  return 41731
}

function Get-PawInstallRoot {
  param(
    [string]$InstallRoot
  )
  if ($InstallRoot -and $InstallRoot.Trim().Length -gt 0) {
    return $InstallRoot.Trim()
  }
  $local = $env:LOCALAPPDATA
  if (-not $local) {
    throw "[PATH_RESOLVE_FAILED] 无法解析安装或数据路径。请设置 LOCALAPPDATA，或显式传入 -InstallRoot / -DataDirectory。"
  }
  return (Join-Path (Join-Path $local "Programs") (Get-PawProductName))
}

function Get-PawDataDirectory {
  param(
    [string]$DataDirectory
  )
  if ($DataDirectory -and $DataDirectory.Trim().Length -gt 0) {
    return $DataDirectory.Trim()
  }
  $local = $env:LOCALAPPDATA
  if (-not $local) {
    throw "[PATH_RESOLVE_FAILED] 无法解析安装或数据路径。请设置 LOCALAPPDATA，或显式传入 -InstallRoot / -DataDirectory。"
  }
  return (Join-Path $local (Get-PawProductName))
}

function Get-PawLoopbackUrl {
  param(
    [int]$Port = 41731
  )
  return "http://127.0.0.1:$Port/"
}

function Test-PawIsProtectedDataPath {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$DataDirectory
  )
  $norm = {
    param($p)
    return ($p -replace "/", "\").TrimEnd("\").ToLowerInvariant()
  }
  $target = & $norm $Candidate
  $root = & $norm $DataDirectory
  return ($target -eq $root) -or ($target.StartsWith($root + "\"))
}

function Write-PawError {
  param(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message,
    [string]$Detail
  )
  if ($Detail) {
    Write-Error "[$Code] $Message 详情：$Detail"
  } else {
    Write-Error "[$Code] $Message"
  }
}
