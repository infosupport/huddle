[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Default: ruim ALLE devcontainers op. Geef -Container <name> om er maar 1 te doen.
    [string]$Container,
    # Houd lokale Rider (rider64 + Rider.Backend) draaien.
    [switch]$KeepRider,
    # Sla bevestiging over.
    [switch]$Force,
    [string]$HuddleUrl = 'http://localhost:3000'
)

$ErrorActionPreference = 'Continue'

function Section { param([string]$T) Write-Host ""; Write-Host "=== $T ===" -ForegroundColor Cyan }

# ── Plan ────────────────────────────────────────────────────────────────────
Section 'Plan'

# Processen die we gaan killen. JetBrains-thin-client / Gateway / daemon /
# CEF-helper zijn de gebruikelijke verdachten bij "Connection declined ...
# another connection to the same IDE backend" en bij windows die meteen
# verdwijnen na trust-klik.
$alwaysKill = @(
    'jetbrains_client64',   # thin client (de "ghost session" die de backend-slot vasthoudt)
    'gateway64',            # JetBrains Gateway (stand-alone)
    'jetbrainsd',           # JetBrains Daemon helper
    'jcef_helper'           # Chromium Embedded Framework subprocess
)
$riderKill = @('rider64','Rider.Backend')

$names = $alwaysKill
if (-not $KeepRider) { $names += $riderKill }

Write-Host "Te killen processen:"
foreach ($n in $names) { Write-Host ("  - {0}" -f $n) }
if ($KeepRider) { Write-Host "  (Rider blijft draaien vanwege -KeepRider)" -ForegroundColor Yellow }

if ($Container) {
    Write-Host ""
    Write-Host "Container: alleen '$Container' wordt verwijderd via huddle API"
} else {
    Write-Host ""
    Write-Host "Containers: ALLE devcontainers worden verwijderd via huddle API ($HuddleUrl)"
}
Write-Host ""

if (-not $Force) {
    $ans = Read-Host "Doorgaan? [y/N]"
    if ($ans -notmatch '^[Yy]') { Write-Host "Afgebroken." -ForegroundColor Yellow; return }
}

# ── Kill processen ──────────────────────────────────────────────────────────
Section 'JetBrains-processen killen'

foreach ($n in $names) {
    $procs = Get-Process -Name $n -ErrorAction SilentlyContinue
    if (-not $procs) {
        Write-Host ("  geen {0}" -f $n) -ForegroundColor DarkGray
        continue
    }
    foreach ($p in $procs) {
        $start = try { $p.StartTime.ToString('s') } catch { 'unknown' }
        Write-Host ("  kill {0,-22} pid={1} start={2}" -f $p.ProcessName, $p.Id, $start)
        try {
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
        } catch {
            Write-Host "    mislukt: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

# Laat sockets / file-locks even los voordat we containers gaan opruimen.
Start-Sleep -Seconds 2

# ── Containers via huddle-API opruimen ──────────────────────────────────────
Section 'Devcontainers opruimen via huddle-API'

function Remove-HuddleContainer {
    param([string]$Name)
    try {
        Invoke-RestMethod -Method Delete -Uri "$HuddleUrl/api/docker/containers/$Name" -TimeoutSec 30 -ErrorAction Stop | Out-Null
        Write-Host ("  verwijderd via API : {0}" -f $Name) -ForegroundColor Green
        return $true
    } catch {
        Write-Host ("  API delete mislukt voor {0}: {1}" -f $Name, $_.Exception.Message) -ForegroundColor Yellow
        return $false
    }
}

function Remove-DockerFallback {
    param([string]$Name)
    Write-Host ("  fallback docker stop/rm voor {0}" -f $Name) -ForegroundColor Yellow
    & docker stop $Name 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    & docker rm   $Name 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}

# Lijst ophalen via huddle (zodat we netwerk/socket-cleanup goed laten gebeuren).
# Valt terug op `docker ps` als huddle niet bereikbaar is.
$targets = @()
if ($Container) {
    $targets = @($Container)
} else {
    try {
        $list = Invoke-RestMethod -Method Get -Uri "$HuddleUrl/api/docker/containers" -TimeoutSec 10 -ErrorAction Stop
        $targets = $list | ForEach-Object { $_.name } | Where-Object { $_ }
        if (-not $targets) { Write-Host "  (geen devcontainers gevonden via huddle-API)" -ForegroundColor DarkGray }
    } catch {
        Write-Host "  huddle-API niet bereikbaar ($($_.Exception.Message)); fallback naar 'docker ps'" -ForegroundColor Yellow
        $targets = & docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -like 'devcontainer-*' -and $_ -ne 'devcontainer-huddle' }
    }
}

foreach ($name in $targets) {
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if (-not (Remove-HuddleContainer -Name $name)) {
        Remove-DockerFallback -Name $name
    }
}

# ── Orphan-socket cleanup (per-container docker socket proxies) ─────────────
Section 'Stale dc-sockets opruimen'

$sockDir = 'C:\tmp\dc-sockets'
if (Test-Path $sockDir) {
    Get-ChildItem -Path $sockDir -Filter '*.sock' -ErrorAction SilentlyContinue | ForEach-Object {
        $base = [IO.Path]::GetFileNameWithoutExtension($_.Name)
        # Alleen verwijderen als de bijbehorende container niet meer bestaat.
        $stillThere = & docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $base }
        if (-not $stillThere) {
            try {
                Remove-Item $_.FullName -Force
                Write-Host ("  verwijderd: {0}" -f $_.FullName) -ForegroundColor Green
            } catch {
                Write-Host ("  kon niet verwijderen: {0} ({1})" -f $_.FullName, $_.Exception.Message) -ForegroundColor Yellow
            }
        } else {
            Write-Host ("  behouden: {0} (container bestaat nog)" -f $_.Name) -ForegroundColor DarkGray
        }
    }
} else {
    Write-Host "  $sockDir bestaat niet, niets op te ruimen." -ForegroundColor DarkGray
}

# ── Verifieer dat alles weg is ──────────────────────────────────────────────
Section 'Verificatie'

$leftover = @()
foreach ($n in $names) {
    $procs = Get-Process -Name $n -ErrorAction SilentlyContinue
    if ($procs) { $leftover += "$n (pids: $($procs.Id -join ','))" }
}

if ($leftover.Count -gt 0) {
    Write-Host "  Nog draaiende processen:" -ForegroundColor Yellow
    $leftover | ForEach-Object { Write-Host "    - $_" -ForegroundColor Yellow }
} else {
    Write-Host "  Alle target-processen weg." -ForegroundColor Green
}

# ── Klaar ───────────────────────────────────────────────────────────────────
Section 'Klaar'
Write-Host "Volgende stappen:" -ForegroundColor Green
Write-Host "  1. Open de huddle web-UI ($HuddleUrl)"
Write-Host "  2. Spawn een nieuwe container met de 'Rider' optie"
Write-Host "  3. Wacht tot de container 'in network' staat (groene indicator)"
Write-Host "  4. Open Rider VERS (geen oude Toolbox / Gateway windows) en klik Connect"
Write-Host ""
Write-Host "Als het opnieuw faalt: .\diagnose-rider.ps1 + .\diagnose-rider-client.ps1" -ForegroundColor DarkGray
