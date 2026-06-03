[CmdletBinding()]
param(
    [string]$LogFile = "$PSScriptRoot\rider-client-diagnose.log",
    [int]$TailLines = 200,
    [int]$RecentMinutes = 30
)

$ErrorActionPreference = 'Continue'

function W { param([string]$Text) Add-Content -Path $LogFile -Value $Text }
function W-Section { param([string]$Title) W ""; W "===== $Title =====" ; W "" }

if (Test-Path $LogFile) { Remove-Item $LogFile -Force }
New-Item -Path $LogFile -ItemType File -Force | Out-Null

W "Rider client-side diagnose"
W "Date: $(Get-Date -Format o)"
W "Tail: $TailLines lines / files modified in last $RecentMinutes minutes"

$cutoff = (Get-Date).AddMinutes(-$RecentMinutes)

# Likely roots where JetBrains stores client + thin-client + gateway logs
$roots = @(
    "$env:LOCALAPPDATA\JetBrains",
    "$env:APPDATA\JetBrains",
    "$env:USERPROFILE\AppData\Local\JetBrains",
    "$env:USERPROFILE\AppData\Roaming\JetBrains",
    "$env:LOCALAPPDATA\Programs\RiderRemoteDev",
    "$env:LOCALAPPDATA\JetBrains\Toolbox"
) | Sort-Object -Unique | Where-Object { Test-Path $_ }

W-Section "Discovered JetBrains roots"
$roots | ForEach-Object { W $_ }

# All idea.log / backend.log / *.log files inside those roots, only recent ones
W-Section "Recently modified log files (last $RecentMinutes min)"
$logs = foreach ($r in $roots) {
    Get-ChildItem -Path $r -Recurse -File -Include 'idea.log','backend.log','*.log' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -gt $cutoff }
}
$logs = $logs | Sort-Object LastWriteTime -Descending
foreach ($l in $logs) {
    W ("{0}    {1,10}  {2}" -f $l.LastWriteTime.ToString('s'), $l.Length, $l.FullName)
}

W-Section "Tail of each recent log"
foreach ($l in $logs) {
    W ""
    W "##### $($l.FullName) (last $TailLines lines) #####"
    try {
        Get-Content -Path $l.FullName -Tail $TailLines -ErrorAction Stop | ForEach-Object { W $_ }
    } catch {
        W "  (cannot read: $($_.Exception.Message))"
    }
}

# Thin-client dist folders (downloaded backends)
W-Section "Thin-client / RemoteDev dist folders"
$distCandidates = @(
    "$env:LOCALAPPDATA\JetBrains\Toolbox\apps",
    "$env:LOCALAPPDATA\JetBrains\RemoteDevPortal",
    "$env:APPDATA\JetBrains\RemoteDev",
    "$env:LOCALAPPDATA\JetBrains\RemoteDev"
) | Where-Object { Test-Path $_ }

foreach ($d in $distCandidates) {
    W ""
    W "--- $d ---"
    Get-ChildItem -Path $d -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { W ("{0,-50}  modified {1}" -f $_.Name, $_.LastWriteTime.ToString('s')) }
}

# JetBrains Gateway / Toolbox installed apps
W-Section "Installed JetBrains apps (via Toolbox state.json if present)"
$state = "$env:LOCALAPPDATA\JetBrains\Toolbox\state.json"
if (Test-Path $state) {
    Get-Content $state | ForEach-Object { W $_ }
} else {
    W "(no toolbox state.json found at $state)"
}

# Running Rider/Gateway/Java processes
W-Section "Running Rider/Gateway/Java processes"
Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match 'rider|jetbrains|gateway|fleet|cwm|remotedev|java' } |
    Select-Object Id, ProcessName, StartTime, Path, CommandLine |
    Format-List | Out-String | ForEach-Object { W $_ }

# Recent crashes / hs_err
W-Section "JVM crash dumps (hs_err*) in JetBrains roots"
foreach ($r in $roots) {
    Get-ChildItem -Path $r -Recurse -File -Filter 'hs_err*' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -gt $cutoff } |
        ForEach-Object { W $_.FullName }
}

Write-Host "Done. Log written to: $LogFile" -ForegroundColor Green
