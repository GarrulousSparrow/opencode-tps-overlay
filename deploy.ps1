#requires -Version 5.1
<#
.SYNOPSIS
    Deploy this source tree to the OpenCode global plugin directory.

.DESCRIPTION
    OpenCode auto-discovers plugins in %USERPROFILE%\.config\opencode\plugins.
    This script copies the project there so the workspace can remain the source
    of truth. It does not delete files in the destination.

.PARAMETER Destination
    Target plugin directory. Defaults to the OpenCode global plugin directory.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Destination "D:\tmp\tps-overlay"
#>
[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $env:USERPROFILE ".config\opencode\plugins\tps-overlay")
)

$ErrorActionPreference = "Stop"

$Source = Split-Path -Parent $PSCommandPath
$sourceFull = [System.IO.Path]::GetFullPath($Source).TrimEnd("\")
$destFull = [System.IO.Path]::GetFullPath($Destination).TrimEnd("\")

if ($sourceFull -eq $destFull) {
    throw "Source and destination are the same directory: $sourceFull"
}

New-Item -ItemType Directory -Path $destFull -Force | Out-Null

$exclude = @(".git", "__pycache__", ".pytest_cache")
Get-ChildItem -Force -LiteralPath $sourceFull |
    Where-Object { $_.Name -notin $exclude } |
    ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destFull -Recurse -Force
    }

Write-Host "Deployed: $sourceFull" -ForegroundColor Green
Write-Host "       -> $destFull" -ForegroundColor Green
Write-Host "If index.js changed, reload the plugin or restart OpenCode." -ForegroundColor DarkGray
Write-Host "If overlay.py changed, close and reopen the overlay." -ForegroundColor DarkGray
