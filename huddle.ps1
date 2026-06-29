# ──────────────────────────────────────────────────────────────────────────────
#  Huddle CLI  --  DMZ Devcontainer Manager
# ──────────────────────────────────────────────────────────────────────────────

$HUDDLE_CONTAINER = "huddle"
$HUDDLE_IMAGE     = "huddle"
$HUDDLE_VOLUME    = "huddle-data"
$HUDDLE_PORT      = 3000

# Per-IDE base images. Elke IDE heeft een eigen base-devimage-<ide>/ folder met
# een Dockerfile en draagt LABEL com.devcontainer.ide=<ide>. Snapshots inheriten
# datzelfde label zodat de spawn-flow ze per IDE kan filteren.
$IDE_DEFS = @(
    [PSCustomObject]@{ Key = 'rider';    Display = 'Rider';    Backend = 'Rider';    Image = 'base-devimage-rider';    Folder = 'base-devimage-rider' }
    [PSCustomObject]@{ Key = 'intellij'; Display = 'IntelliJ'; Backend = 'IntelliJ'; Image = 'base-devimage-intellij'; Folder = 'base-devimage-intellij' }
    # VS Code installeert zijn eigen backend (VS Code Server) in de container bij
    # het attachen — er hoeft dus geen IDE-distro gedownload te worden zoals bij JB.
    [PSCustomObject]@{ Key = 'vscode';   Display = 'VS Code';  Backend = 'VSCode';   Image = 'base-devimage-vscode';   Folder = 'base-devimage-vscode' }
)

$TempDir = if ($env:TEMP) { $env:TEMP } elseif ($env:TMPDIR) { $env:TMPDIR.TrimEnd('/') } else { '/tmp' }

function Write-Banner {
    Clear-Host
#     Write-Host ""
#     Write-Host "  ██╗  ██╗██╗   ██╗██████╗ ██████╗ ██╗     ███████╗" -ForegroundColor Cyan
#     Write-Host "  ██║  ██║██║   ██║██╔══██╗██╔══██╗██║     ██╔════╝" -ForegroundColor Cyan
#     Write-Host "  ███████║██║   ██║██║  ██║██║  ██║██║     █████╗  " -ForegroundColor Cyan
#     Write-Host "  ██╔══██║██║   ██║██║  ██║██║  ██║██║     ██╔══╝  " -ForegroundColor Cyan
#     Write-Host "  ██║  ██║╚██████╔╝██████╔╝██████╔╝███████╗███████╗" -ForegroundColor Cyan
#     Write-Host "  ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝" -ForegroundColor Cyan
#     Write-Host ""
    Write-Host "  DMZ Portal  --  Secure dev environments" -ForegroundColor DarkCyan
    Write-Host ""
}

function Write-Status {
    $running = docker ps --filter "name=^${HUDDLE_CONTAINER}$" --format "{{.Names}}"
    if ($running) {
        Write-Host "  [ON]  Huddle draait  -->  http://localhost:${HUDDLE_PORT}" -ForegroundColor Green
    } else {
        Write-Host "  [OFF] Huddle is gestopt" -ForegroundColor Red
    }
    Write-Host ""
}

function Show-Menu {
    Write-Banner
    Write-Status
    Write-Host "  -----------------------------------------" -ForegroundColor DarkGray
    Write-Host "   1  Snapshot maken van draaiende container" -ForegroundColor White
    Write-Host "   2  Devcontainer starten (IDE -> standaard of snapshot)" -ForegroundColor White
    Write-Host "   3  Base image bouwen per IDE (of alle parallel)" -ForegroundColor White
    Write-Host "   4  Huddle bouwen en herstarten" -ForegroundColor White
    Write-Host "  -----------------------------------------" -ForegroundColor DarkGray
    Write-Host "   0  Afsluiten" -ForegroundColor DarkGray
    Write-Host ""
}

# ── Start Huddle ──────────────────────────────────────────────────────────────

function Start-Huddle {
    $running = docker ps --filter "name=^${HUDDLE_CONTAINER}$" --format "{{.Names}}"
    if ($running) {
        Write-Host "  Huddle draait al." -ForegroundColor Green
        return
    }

    $netExists = docker network ls --filter 'name=^devcontainer-net$' --format "{{.Name}}"
    if (-not $netExists) {
        Write-Host "  Netwerk 'devcontainer-net' aanmaken (intern)..." -ForegroundColor DarkCyan
        docker network create --internal devcontainer-net | Out-Null
    } else {
        $netInternal = docker network inspect devcontainer-net --format '{{.Internal}}' 2>$null
        if ($netInternal -ne 'true') {
            Write-Host "  WAARSCHUWING: 'devcontainer-net' is niet intern. Voer 'docker network rm devcontainer-net' uit (stop eerst alle containers) en herstart Huddle." -ForegroundColor Yellow
        }
    }

    $imageExists = docker images --filter "reference=${HUDDLE_IMAGE}" --format "{{.Repository}}"
    if (-not $imageExists) {
        Write-Host "  Image '${HUDDLE_IMAGE}' niet gevonden -- bouwen..." -ForegroundColor DarkCyan
        $scriptDir = $PSScriptRoot
        docker build -t $HUDDLE_IMAGE (Join-Path $scriptDir "gateway") --no-cache
        if ($LASTEXITCODE -ne 0) { Write-Host "  Build mislukt." -ForegroundColor Red; return }
    }

    $stopped = docker ps -aq --filter "name=^${HUDDLE_CONTAINER}$" 2>$null
    if ($stopped) { docker rm $HUDDLE_CONTAINER | Out-Null }

    Write-Host "  Huddle starten..." -ForegroundColor DarkCyan
    $scriptDir = $PSScriptRoot
    $bugtrackerDir = Join-Path $scriptDir "bugtracker"
    New-Item -ItemType Directory -Force -Path (Join-Path $bugtrackerDir "bugs") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $bugtrackerDir "solved") | Out-Null
    $runArgs = @(
        '-d',
        '--name', $HUDDLE_CONTAINER,
        '--network', 'devcontainer-net',
        '-p', "${HUDDLE_PORT}:3000",
        '-v', "${HUDDLE_VOLUME}:/data",
        '-v', '/var/run/docker.sock:/var/run/docker.sock',
        '-v', '/tmp/dc-sockets:/tmp/dc-sockets',
        '-v', "${bugtrackerDir}:/bugtracker"
    )
    foreach ($ide in $IDE_DEFS) {
        $folderHost = Join-Path $scriptDir $ide.Folder
        if (Test-Path $folderHost) {
            $runArgs += @('-v', "${folderHost}:/$($ide.Folder):ro")
        }
    }
    # Gedeelde AI-config (.ai) mee zodat de gateway base-images kan bouwen met de
    # `COPY .ai/…` regels (zie gateway/src/docker.ts buildImage).
    $aiHost = Join-Path $scriptDir ".ai"
    if (Test-Path $aiHost) {
        $runArgs += @('-v', "${aiHost}:/.ai:ro")
    }
    $runArgs += $HUDDLE_IMAGE
    $id = docker run @runArgs
    # Verbind Huddle ook met de default bridge zodat het zelf internet kan bereiken
    # voor proxy-verzoeken, terwijl devcontainers alleen op het interne netwerk zitten.
    docker network connect bridge $HUDDLE_CONTAINER | Out-Null
    Write-Host "  [OK] Gestart: $id" -ForegroundColor Green
    Write-Host "  Web UI: http://localhost:${HUDDLE_PORT}" -ForegroundColor Cyan
}

function Restart-Huddle {
    $existing = docker ps -aq --filter "name=^${HUDDLE_CONTAINER}$" 2>$null
    if ($existing) {
        Write-Host "  Huddle stoppen..." -ForegroundColor DarkCyan
        docker rm -f $HUDDLE_CONTAINER | Out-Null
    }
    Start-Huddle
}

# ── Build Huddle image ────────────────────────────────────────────────────────

function Build-HuddleImage {
    $scriptDir = $PSScriptRoot
    Write-Host "  Image '${HUDDLE_IMAGE}' bouwen..." -ForegroundColor DarkCyan
    docker build -t $HUDDLE_IMAGE (Join-Path $scriptDir "gateway") --no-cache
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] Image '${HUDDLE_IMAGE}' klaar." -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Build mislukt." -ForegroundColor Red
    }
}

# ── IDE picker (gemeenschappelijk voor build + spawn) ────────────────────────

function Select-Ide {
    Write-Host ""
    Write-Host "  IDE:" -ForegroundColor DarkCyan
    for ($i = 0; $i -lt $IDE_DEFS.Count; $i++) {
        Write-Host ("   {0})  {1}" -f ($i + 1), $IDE_DEFS[$i].Display)
    }
    $sel = [int](Read-Host "`n  Kies IDE") - 1
    if ($sel -lt 0 -or $sel -ge $IDE_DEFS.Count) { return $null }
    return $IDE_DEFS[$sel]
}

# Detecteer welke IDE bij een snapshot/image hoort — eerst via het label
# com.devcontainer.ide, dan via fallback op de naam-conventie base-devimage-<ide>.
function Get-ImageIde {
    param([string]$ImageRef)
    $json = docker inspect $ImageRef 2>$null | Out-String
    if ($json) {
        try {
            $label = (ConvertFrom-Json $json)[0].Config.Labels.'com.devcontainer.ide'
            if ($label) { return $label.Trim() }
        } catch {}
    }
    foreach ($ide in $IDE_DEFS) {
        if ($ImageRef -like "*$($ide.Image)*") { return $ide.Key }
    }
    return $null
}

# ── Snapshot ──────────────────────────────────────────────────────────────────

function New-Snapshot {
    Write-Host ""
    Write-Host "  Draaiende devcontainers:" -ForegroundColor DarkCyan

    $fmt = "{{.ID}}|{{.Names}}|{{.Image}}"
    $rows = @(docker ps --filter 'label=com.intellij.devcontainer.id' --format $fmt |
        ForEach-Object {
            $p = $_ -split '\|'
            [PSCustomObject]@{ ID = $p[0]; Name = $p[1]; Image = $p[2] }
        })

    if (-not $rows) { Write-Host "  Geen draaiende containers." -ForegroundColor Yellow; return }

    for ($i = 0; $i -lt $rows.Count; $i++) {
        Write-Host ("   {0})  {1,-35} {2}" -f ($i + 1), $rows[$i].Name, $rows[$i].Image)
    }

    $sel = [int](Read-Host "`n  Kies container") - 1
    if ($sel -lt 0 -or $sel -ge $rows.Count) { Write-Host "  Ongeldige keuze." -ForegroundColor Red; return }
    $container = $rows[$sel]

    # Detecteer IDE uit het bestaande JB-model-label van de bron-container
    # (`customizations.jetbrains.backend`). Dan kan de spawn-UI dit snapshot
    # filteren als "Rider-snapshot" / "IntelliJ-snapshot".
    $ideKey = $null
    $inspectJson = docker inspect $container.ID 2>$null | Out-String
    if ($inspectJson) {
        try {
            $modelLabel = (ConvertFrom-Json $inspectJson)[0].Config.Labels.'com.intellij.devcontainer.model'
            if ($modelLabel) {
                $backend = (ConvertFrom-Json $modelLabel).customizations.jetbrains.backend
                $ideKey  = ($IDE_DEFS | Where-Object { $_.Backend -eq $backend } | Select-Object -First 1).Key
            }
        } catch {}
    }
    if (-not $ideKey) {
        Write-Host "  Kon IDE niet uit container-labels lezen -- kies handmatig:" -ForegroundColor Yellow
        $picked = Select-Ide
        if (-not $picked) { Write-Host "  Geen IDE gekozen, snapshot afgebroken." -ForegroundColor Red; return }
        $ideKey = $picked.Key
    }

    $defaultName = "snapshot-$($container.Name)"
    $imageName   = Read-Host "  Snapshot naam [$defaultName]"
    if (-not $imageName) { $imageName = $defaultName }

    Write-Host "  Commit $($container.Name) -> $imageName  (IDE: $ideKey)" -ForegroundColor DarkCyan
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    docker commit `
        --change 'LABEL com.devcontainer.snapshot=true' `
        --change "LABEL com.devcontainer.source=$($container.Name)" `
        --change "LABEL com.devcontainer.created=$timestamp" `
        --change "LABEL com.devcontainer.ide=$ideKey" `
        $container.ID $imageName | Out-Null
    Write-Host "  [OK] Snapshot '$imageName' klaar." -ForegroundColor Green
}

# ── Start devcontainer (IDE-first → standaard/snapshot) ──────────────────────

function Start-Devcontainer {
    # Stap 1: IDE kiezen — bepaalt welke base image + welke snapshots in beeld.
    $ide = Select-Ide
    if (-not $ide) { Write-Host "  Ongeldige IDE-keuze." -ForegroundColor Red; return }

    # Stap 2: standaard (per-IDE base image) of een snapshot van die IDE.
    Write-Host ""
    Write-Host "  Beschikbare images voor $($ide.Display):" -ForegroundColor DarkCyan
    $options = @()

    $baseExists = docker image inspect $ide.Image *>$null 2>&1
    if ($LASTEXITCODE -eq 0) {
        $options += [PSCustomObject]@{ Name = $ide.Image; Kind = 'standaard'; Detail = 'base image' }
    } else {
        $options += [PSCustomObject]@{ Name = $ide.Image; Kind = 'standaard'; Detail = '(nog niet gebouwd -- wordt direct gebouwd voor je)' }
    }

    $fmt = "{{.Repository}}:{{.Tag}}|{{.Size}}|{{.CreatedSince}}"
    $snapRows = @(docker images --filter 'label=com.devcontainer.snapshot=true' --filter "label=com.devcontainer.ide=$($ide.Key)" --format $fmt |
        ForEach-Object {
            $p = $_ -split '\|'
            # base-devimage-* zelf óók een snapshot; sla over zodat hij niet dubbel staat.
            if ($p[0] -ne "$($ide.Image):latest" -and $p[0] -ne $ide.Image) {
                [PSCustomObject]@{ Name = $p[0]; Kind = 'snapshot'; Detail = "$($p[1])  $($p[2])" }
            }
        })
    foreach ($r in $snapRows) { $options += $r }

    for ($i = 0; $i -lt $options.Count; $i++) {
        Write-Host ("   {0})  [{1,-9}]  {2,-45}  {3}" -f ($i + 1), $options[$i].Kind, $options[$i].Name, $options[$i].Detail)
    }

    $sel = [int](Read-Host "`n  Kies image") - 1
    if ($sel -lt 0 -or $sel -ge $options.Count) { Write-Host "  Ongeldige keuze." -ForegroundColor Red; return }
    $picked = $options[$sel]

    # Auto-build de standaard-image als die nog niet bestaat.
    if ($picked.Kind -eq 'standaard' -and $LASTEXITCODE -ne 0) {
        Write-Host "  Image '$($picked.Name)' nog niet aanwezig -- bouwen..." -ForegroundColor DarkCyan
        $scriptDir = $PSScriptRoot
        # Build-context = repo-root zodat de Dockerfile `COPY .ai/…` kan; Dockerfile via -f.
        docker build -t $picked.Name -f (Join-Path $scriptDir "$($ide.Folder)/Dockerfile") $scriptDir --no-cache
        if ($LASTEXITCODE -ne 0) { Write-Host "  Build mislukt." -ForegroundColor Red; return }
    }

    $workspaceDir = Read-Host "  Workspace directory"
    if (-not (Test-Path $workspaceDir)) {
        Write-Host "  Directory bestaat niet: $workspaceDir" -ForegroundColor Red; return
    }

    $leafName           = Split-Path $workspaceDir -Leaf
    $containerWorkspace = "/workspaces/$leafName"
    $presentableName    = $leafName
    $workspaceDirFwd    = $workspaceDir.TrimEnd('\', '/') -replace '\\', '/'

    $defaultName   = "devcontainer-$presentableName"
    $containerName = Read-Host "  Containernaam [$defaultName]"
    if (-not $containerName) { $containerName = $defaultName }

    $existing = docker ps -aq --filter "name=^${containerName}$" 2>$null
    if ($existing) {
        $confirm = Read-Host "  Container '$containerName' bestaat al. Verwijderen? [j/N]"
        if ($confirm -ne 'j') { return }
        docker rm -f $containerName | Out-Null
    }

    # De gateway doet alle container-aanmaaklogica: per-container socket-proxy,
    # worktrees, AI-CLI volumes, MCP-config, TLS CA en de firewall-redirect.
    # Het PS1-script delegeert daarom volledig naar de Huddle API.
    Write-Host "  Container starten via Huddle API..." -ForegroundColor DarkCyan

    $body = @{
        imageName     = $picked.Name
        workspaceDir  = $workspaceDirFwd
        containerName = $containerName
        ideName       = $ide.Key
        empty         = $false
    } | ConvertTo-Json

    try {
        $response = Invoke-RestMethod -Method Post `
            -Uri "http://localhost:3000/api/docker/start" `
            -ContentType "application/json" `
            -Body $body
        Write-Host "  [OK] Container '$containerName' gestart (ID: $($response.id))." -ForegroundColor Green
    } catch {
        Write-Host "  [FAIL] Aanmaken mislukt: $_" -ForegroundColor Red
        Write-Host "  Zorg dat Huddle draait (optie 4 om te herstarten)." -ForegroundColor Yellow
        return
    }

    if ($ide.Key -eq 'vscode') {
        Write-Host "  Verbind via VS Code: 'Dev Containers: Attach to Running Container' -> '$containerName'," -ForegroundColor Cyan
        Write-Host "  open daarna de map '$containerWorkspace'." -ForegroundColor Cyan
        return
    }

    Write-Host "  Verbind via Remote Development > Dev Containers met '$containerName'" -ForegroundColor Cyan
    $link = Invoke-RestMethod -Uri "http://localhost:3000/api/docker/containers/$containerName/ide-link" -ErrorAction SilentlyContinue
    if ($link.link) { Write-Host "  IDE-link: $($link.link)" -ForegroundColor Cyan }
}

# ── Build base image ──────────────────────────────────────────────────────────

# Bouwt de gedeelde base-devimage (sequentieel, want IDE-images hangen ervan af).
function Build-SharedBase {
    param([string]$ScriptDir)
    $dockerfile = Join-Path $ScriptDir 'base-devimage\Dockerfile'
    Write-Host "  Gedeelde base image 'base-devimage' bouwen..." -ForegroundColor DarkCyan
    # Build-context = repo-root zodat de Dockerfile `COPY .ai/…` kan; Dockerfile via -f.
    docker build -t base-devimage -f $dockerfile $ScriptDir --no-cache
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [FAIL] Build van base-devimage mislukt." -ForegroundColor Red
        return $false
    }
    Write-Host "  [OK] base-devimage klaar." -ForegroundColor Green
    return $true
}

function Build-BaseImage {
    # Eigen picker (niet de gedeelde Select-Ide): naast de losse IDE's ook een
    # 'Alle (parallel)'-keuze die alle base images tegelijk bouwt.
    Write-Host ""
    Write-Host "  IDE:" -ForegroundColor DarkCyan
    for ($i = 0; $i -lt $IDE_DEFS.Count; $i++) {
        Write-Host ("   {0})  {1}" -f ($i + 1), $IDE_DEFS[$i].Display)
    }
    Write-Host ("   {0})  Alle (parallel)" -f ($IDE_DEFS.Count + 1))
    $sel = [int](Read-Host "`n  Kies IDE") - 1
    if ($sel -eq $IDE_DEFS.Count) { Build-AllBaseImages; return }
    if ($sel -lt 0 -or $sel -ge $IDE_DEFS.Count) { Write-Host "  Ongeldige IDE-keuze." -ForegroundColor Red; return }
    $ide = $IDE_DEFS[$sel]

    $scriptDir = $PSScriptRoot
    if (-not (Build-SharedBase -ScriptDir $scriptDir)) { return }

    $buildPath = Join-Path $scriptDir $ide.Folder
    if (-not (Test-Path (Join-Path $buildPath 'Dockerfile'))) {
        Write-Host "  Dockerfile niet gevonden: $buildPath\Dockerfile" -ForegroundColor Red
        return
    }
    Write-Host "  Image '$($ide.Image)' bouwen ($($ide.Display))..." -ForegroundColor DarkCyan
    # Build-context = repo-root zodat de Dockerfile `COPY .ai/…` kan; Dockerfile via -f.
    docker build -t $ide.Image -f (Join-Path $buildPath 'Dockerfile') $scriptDir --no-cache
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] Image '$($ide.Image)' klaar." -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Build mislukt." -ForegroundColor Red
    }
}

# ── Build alle base images parallel ─────────────────────────────────────────────

# Bouwt eerst de gedeelde base-devimage (sequentieel), daarna de IDE-images parallel.
# Output per build gaat naar een eigen logbestand in $env:TEMP (parallelle builds
# door elkaar op de console is onleesbaar); aan het eind volgt een overzicht.
function Build-AllBaseImages {
    $scriptDir = $PSScriptRoot

    if (-not (Build-SharedBase -ScriptDir $scriptDir)) { return }

    Write-Host ""
    Write-Host "  IDE-images parallel bouwen..." -ForegroundColor DarkCyan
    Write-Host ""

    $builds = @()
    foreach ($ide in $IDE_DEFS) {
        $dockerfile = Join-Path (Join-Path $scriptDir $ide.Folder) 'Dockerfile'
        if (-not (Test-Path $dockerfile)) {
            Write-Host "  [SKIP] Dockerfile niet gevonden voor $($ide.Display): $dockerfile" -ForegroundColor Yellow
            continue
        }
        $logOut = Join-Path $TempDir "huddle-build-$($ide.Key).out.log"
        $logErr = Join-Path $TempDir "huddle-build-$($ide.Key).err.log"
        # Build-context = repo-root zodat de Dockerfile `COPY .ai/…` kan; Dockerfile via -f.
        $proc = Start-Process -FilePath 'docker' `
            -ArgumentList @('build', '-t', $ide.Image, '-f', $dockerfile, $scriptDir) `
            -NoNewWindow -PassThru `
            -RedirectStandardOutput $logOut -RedirectStandardError $logErr
        # Forceer het cachen van de proces-handle; zonder dit blijft .ExitCode na
        # afloop leeg (bekende Start-Process -PassThru valkuil).
        try { [void]$proc.Handle } catch {}
        Write-Host "  -> $($ide.Image) ($($ide.Display)) gestart  [pid $($proc.Id)]  log: $logOut" -ForegroundColor DarkGray
        $builds += [PSCustomObject]@{ Ide = $ide; Proc = $proc; LogErr = $logErr }
    }

    if (-not $builds) { Write-Host "  Geen images om te bouwen." -ForegroundColor Yellow; return }

    Write-Host ""
    Write-Host "  Wachten tot $($builds.Count) build(s) klaar zijn..." -ForegroundColor DarkCyan
    foreach ($b in $builds) { $b.Proc.WaitForExit() }

    Write-Host ""
    $allOk = $true
    foreach ($b in $builds) {
        if ($b.Proc.ExitCode -eq 0) {
            Write-Host "  [OK]   $($b.Ide.Image)" -ForegroundColor Green
        } else {
            $allOk = $false
            Write-Host "  [FAIL] $($b.Ide.Image) (exit $($b.Proc.ExitCode)) -- zie $($b.LogErr)" -ForegroundColor Red
            if (Test-Path $b.LogErr) {
                Get-Content $b.LogErr -Tail 15 | ForEach-Object { Write-Host "         | $_" -ForegroundColor DarkGray }
            }
        }
    }
    Write-Host ""
    if ($allOk) {
        Write-Host "  [OK] Alle base images klaar." -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Niet alle builds zijn geslaagd." -ForegroundColor Red
    }
}

# ── Main loop ─────────────────────────────────────────────────────────────────

Start-Huddle

$running = $true
while ($running) {
    Show-Menu
    $choice = Read-Host "  Keuze"
    Write-Host ""
    switch ($choice) {
        '1' { New-Snapshot;       Read-Host "`n  Druk Enter om terug te gaan" }
        '2' { Start-Devcontainer; Read-Host "`n  Druk Enter om terug te gaan" }
        '3' { Build-BaseImage;    Read-Host "`n  Druk Enter om terug te gaan" }
        '4' { Build-HuddleImage; if ($LASTEXITCODE -eq 0) { Restart-Huddle }; Read-Host "`n  Druk Enter om terug te gaan" }
        '0' { $running = $false }
        default { Write-Host "  Ongeldige keuze." -ForegroundColor Red; Start-Sleep -Seconds 1 }
    }
}
