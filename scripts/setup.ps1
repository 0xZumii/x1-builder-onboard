#Requires -Version 5.1
<#
.SYNOPSIS
  Provisions an X1 development environment on Windows.

.DESCRIPTION
  The Solana CLI, Anchor and the SBF compiler are Linux/macOS only. There is no
  supported native Windows build, so the correct path is WSL2 + Ubuntu.

  This script handles the Windows side (WSL2 + distro) and then delegates to
  scripts/wsl-provision.sh for the Linux side, so there is one source of truth
  for toolchain versions.

  Plan-first: nothing is installed unless you pass -Apply.

.PARAMETER Apply
  Actually perform the installation.

.PARAMETER Distro
  WSL distribution to use. Default: Ubuntu-24.04

.EXAMPLE
  .\setup.ps1
  Shows what would happen.

.EXAMPLE
  .\setup.ps1 -Apply
  Installs WSL2 (if needed), Ubuntu, and the X1 toolchain inside it.
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"

function Write-Step($Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok($Message)   { Write-Host "    [ok] $Message" -ForegroundColor Green }
function Write-Warn2($Message){ Write-Host "    [!!] $Message" -ForegroundColor Yellow }
function Write-Plan($Message) { Write-Host "    would: $Message" -ForegroundColor DarkGray }

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-WslState {
  try {
    $raw = & wsl.exe --status 2>&1 | Out-String
    # wsl.exe writes UTF-16; strip nulls before matching.
    $text = ($raw -replace "`0", "").Trim()
    if ($text -match "not installed" -or $text -match "not running") { return "absent" }
    if ($text -match "no installed distributions" -or $text -match "distribution.*not") { return "no-distro" }
    return "present"
  } catch {
    return "absent"
  }
}

function Test-DistroInstalled($Name) {
  try {
    $list = (& wsl.exe --list --quiet 2>&1 | Out-String) -replace "`0", ""
    return $list -match [regex]::Escape($Name)
  } catch {
    return $false
  }
}

Write-Host "X1 development environment setup" -ForegroundColor White
Write-Host "Host: Windows $([System.Environment]::OSVersion.Version)"

$isAdmin = Test-Admin
$wslState = Get-WslState
$hasDistro = ($wslState -ne "absent") -and (Test-DistroInstalled $Distro)

Write-Step "Current state"
Write-Host "    WSL2           : $wslState"
Write-Host "    $Distro : $(if ($hasDistro) { 'installed' } else { 'not installed' })"
Write-Host "    Administrator  : $(if ($isAdmin) { 'yes' } else { 'no' })"

# ---------------------------------------------------------------------------
# Windows side: WSL2 platform and distro
# ---------------------------------------------------------------------------

if ($wslState -eq "absent" -or -not $hasDistro) {
  Write-Step "Installing WSL2 / $Distro"
  if (-not $Apply) {
    Write-Plan "wsl --install -d $Distro"
    Write-Plan "may require a reboot; re-run with -Apply if so"
    Write-Host "`nDry run. Pass -Apply to execute.`n" -ForegroundColor DarkGray
    exit 0
  }

  if (-not $isAdmin) {
    Write-Warn2 "This step needs an elevated shell. Re-run from PowerShell as Administrator."
    exit 1
  }

  & wsl.exe --install -d $Distro --no-launch
  if (-not (Test-DistroInstalled $Distro)) {
    Write-Warn2 "The distribution is not available yet. Reboot if prompted, then re-run: .\setup.ps1 -Apply"
    exit 1
  }
  Write-Ok "distro installed"
}

# ---------------------------------------------------------------------------
# Linux side: delegate to the provisioner
# ---------------------------------------------------------------------------

$provisioner = Join-Path $PSScriptRoot "wsl-provision.sh"
if (-not (Test-Path $provisioner)) {
  throw "Cannot find wsl-provision.sh next to this script (expected: $provisioner)"
}

Write-Step "Provisioning the toolchain in $Distro"
if (-not $Apply) {
  Write-Plan "create a 'dev' user with passwordless sudo (sets it as the WSL default)"
  Write-Plan "apt: build-essential, clang, pkg-config, libudev, libssl, protobuf"
  Write-Plan "rust (rustup, stable, minimal)"
  Write-Plan "solana CLI (stable; the kit builds with --arch v0)"
  Write-Plan "anchor CLI 0.31.1 (prebuilt)"
  Write-Plan "node 24 via nvm, plus ~/.profile so non-interactive shells see it"
  Write-Plan "generate a wallet and point the Solana CLI at https://rpc.testnet.x1.xyz"
  Write-Host "`nDry run. Pass -Apply to execute.`n" -ForegroundColor DarkGray
  exit 0
}

# Normalise CRLF: bash treats a trailing \r as part of the token.
$content = [IO.File]::ReadAllText($provisioner) -replace "`r`n", "`n"
$temp = Join-Path ([IO.Path]::GetTempPath()) "x1-wsl-provision.sh"
[IO.File]::WriteAllText($temp, $content, (New-Object Text.UTF8Encoding($false)))

try {
  $wslPath = (& wsl.exe -d $Distro wslpath -a "$temp" | Out-String).Trim() -replace "`0", ""
  & wsl.exe -d $Distro -u root -- bash $wslPath
} finally {
  Remove-Item $temp -ErrorAction SilentlyContinue
}

Write-Step "Next"
Write-Host "    Open the distro (your default user is now 'dev'):"
Write-Host "      wsl -d $Distro" -ForegroundColor DarkGray
Write-Host ""
Write-Host "    Verify the toolchain and RPC:"
Write-Host "      cd ~/devkit && node packages/kit/dist/cli.js doctor" -ForegroundColor DarkGray
Write-Host ""
Write-Host "    Fund the wallet printed above at https://faucet.testnet.x1.xyz"
Write-Host ""
