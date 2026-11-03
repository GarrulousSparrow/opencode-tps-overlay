#requires -Version 5.1
<#
.SYNOPSIS
    Install helper for the OpenCode TPS Overlay.

.DESCRIPTION
    Checks Python/tkinter, creates a small launcher in the runtime data
    directory, and optionally creates Start Menu / Startup shortcuts.

.PARAMETER Python
    Path to python.exe or pythonw.exe. When omitted the script searches PATH.

.PARAMETER Startup
    Also add a shortcut to the current user's Startup folder.

.PARAMETER Launch
    Start the overlay immediately after installing.

.PARAMETER Uninstall
    Remove shortcuts and the launcher, then stop the running overlay.
    Plugin files are not deleted.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Launch

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Startup

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Python,
    [switch]$Startup,
    [switch]$Launch,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$PluginDir = Split-Path -Parent $PSCommandPath
$OverlayScript = Join-Path $PluginDir "overlay.py"
$DataDir = if ($env:TPS_OVERLAY_DATA_DIR) {
    [System.IO.Path]::GetFullPath($env:TPS_OVERLAY_DATA_DIR)
} else {
    Join-Path $env:LOCALAPPDATA "opencode-tps-overlay"
}
$LauncherPath = Join-Path $DataDir "launch-overlay.cmd"
$ShortcutName = "OpenCode TPS Overlay.lnk"
$StartMenuShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) $ShortcutName
$StartupShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) $ShortcutName

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor Yellow
}

function Get-ConsolePython {
    param([string]$Path)
    $leaf = [System.IO.Path]::GetFileName($Path).ToLowerInvariant()
    if ($leaf -eq "pythonw.exe") {
        $sibling = Join-Path ([System.IO.Path]::GetDirectoryName($Path)) "python.exe"
        if (Test-Path -LiteralPath $sibling) { return $sibling }
    }
    return $Path
}

function Test-Python {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
    $console = Get-ConsolePython -Path $Path
    try {
        & $console -c "import tkinter" 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Resolve-PythonPath {
    param([string]$Requested)

    if ($Requested) {
        if (-not (Test-Path -LiteralPath $Requested)) {
            throw "Python not found at: $Requested"
        }
        if (-not (Test-Python -Path $Requested)) {
            throw "The selected Python cannot import tkinter: $Requested"
        }
        return (Resolve-Path -LiteralPath $Requested).Path
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($name in @("pythonw.exe", "python.exe")) {
        $commands = Get-Command $name -All -ErrorAction SilentlyContinue
        foreach ($command in $commands) {
            if ($command.Source) { $candidates.Add($command.Source) }
        }
    }

    # Prefer a real installation over the Microsoft Store execution alias.
    $ordered = $candidates |
        Select-Object -Unique |
        Sort-Object @{ Expression = { if ($_ -match "\\WindowsApps\\") { 1 } else { 0 } } }

    foreach ($candidate in $ordered) {
        if (Test-Python -Path $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw "No Python with tkinter was found. Install Python 3.8+ from python.org, or pass -Python <path>."
}

function New-Shortcut {
    param(
        [string]$Path,
        [string]$Target,
        [string]$WorkingDirectory
    )
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $Target
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.WindowStyle = 7
    $shortcut.Description = "OpenCode V2 TPS overlay"
    $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
    $shortcut.Save()
}

function Stop-Overlay {
    $pidFile = Join-Path $DataDir "overlay.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { return }
    try {
        $raw = Get-Content -LiteralPath $pidFile -Raw
        $data = $raw | ConvertFrom-Json
        $processId = [int]$data.pid
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process -and $process.ProcessName -match "^(python|pythonw)$") {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
            Write-Ok "Stopped overlay process $processId."
        } elseif ($process) {
            Write-Warn "PID $processId is not a Python process; leaving it alone."
        }
    } catch {
        Write-Warn "Could not read or stop the overlay process; close it from its context menu."
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

Write-Step "OpenCode TPS Overlay installer"
Write-Host "    Plugin directory: $PluginDir"
Write-Host "    Data directory:   $DataDir"

if ($Uninstall) {
    foreach ($shortcut in @($StartMenuShortcut, $StartupShortcut)) {
        if (Test-Path -LiteralPath $shortcut) {
            Remove-Item -LiteralPath $shortcut -Force
            Write-Ok "Removed $shortcut"
        }
    }
    if (Test-Path -LiteralPath $LauncherPath) {
        Remove-Item -LiteralPath $LauncherPath -Force
        Write-Ok "Removed $LauncherPath"
    }
    Stop-Overlay
    Write-Host ""
    Write-Host "Uninstall complete. Plugin files were not deleted." -ForegroundColor Green
    Write-Host "To remove the plugin itself, delete:" -ForegroundColor DarkGray
    Write-Host "  $PluginDir" -ForegroundColor DarkGray
    exit 0
}

if (-not (Test-Path -LiteralPath $OverlayScript)) {
    throw "overlay.py was not found next to install.ps1: $OverlayScript"
}

Write-Step "Checking Python and tkinter"
$pythonPath = Resolve-PythonPath -Requested $Python
$consolePython = Get-ConsolePython -Path $pythonPath
$version = & $consolePython -c "import sys; print('%d.%d.%d' % sys.version_info[:3])"
Write-Ok "Python $version"
Write-Ok "Executable: $pythonPath"

$pythonwPath = $pythonPath
if ([System.IO.Path]::GetFileName($pythonPath).ToLowerInvariant() -ne "pythonw.exe") {
    $sibling = Join-Path ([System.IO.Path]::GetDirectoryName($pythonPath)) "pythonw.exe"
    if (Test-Path -LiteralPath $sibling) { $pythonwPath = $sibling }
}

Write-Step "Creating launcher"
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$launcher = @(
    "@echo off",
    "start `"`" `"$pythonwPath`" `"$OverlayScript`""
) -join "`r`n"
$launcherEncoding = [System.Text.Encoding]::GetEncoding(
    [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
)
[System.IO.File]::WriteAllText($LauncherPath, $launcher, $launcherEncoding)
Write-Ok $LauncherPath

Write-Step "Creating Start Menu shortcut"
New-Shortcut -Path $StartMenuShortcut -Target $LauncherPath -WorkingDirectory $PluginDir
Write-Ok $StartMenuShortcut

if ($Startup) {
    Write-Step "Creating Startup shortcut"
    New-Shortcut -Path $StartupShortcut -Target $LauncherPath -WorkingDirectory $PluginDir
    Write-Ok $StartupShortcut
}

if ($Launch) {
    Write-Step "Starting overlay"
    Start-Process -FilePath $LauncherPath -WindowStyle Hidden
    Start-Sleep -Milliseconds 800
    $overlayLog = Join-Path $DataDir "overlay.log"
    if (Test-Path -LiteralPath $overlayLog) {
        $lastLine = Get-Content -LiteralPath $overlayLog -Tail 1
        Write-Ok $lastLine
    }
}

Write-Host ""
Write-Host "Done. Restart OpenCode Desktop if the plugin is not loaded yet." -ForegroundColor Green
Write-Host "Logs:" -ForegroundColor DarkGray
Write-Host "  $(Join-Path $DataDir 'plugin.log')" -ForegroundColor DarkGray
Write-Host "  $(Join-Path $DataDir 'overlay.log')" -ForegroundColor DarkGray
