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

function Write-Banner {
    Clear-Host
    Write-Host ""
    Write-Host "  ██╗  ██╗██╗   ██╗██████╗ ██████╗ ██╗     ███████╗" -ForegroundColor Cyan
    Write-Host "  ██║  ██║██║   ██║██╔══██╗██╔══██╗██║     ██╔════╝" -ForegroundColor Cyan
    Write-Host "  ███████║██║   ██║██║  ██║██║  ██║██║     █████╗  " -ForegroundColor Cyan
    Write-Host "  ██╔══██║██║   ██║██║  ██║██║  ██║██║     ██╔══╝  " -ForegroundColor Cyan
    Write-Host "  ██║  ██║╚██████╔╝██████╔╝██████╔╝███████╗███████╗" -ForegroundColor Cyan
    Write-Host "  ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝" -ForegroundColor Cyan
    Write-Host ""
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
        Write-Host "  Netwerk 'devcontainer-net' aanmaken..." -ForegroundColor DarkCyan
        docker network create devcontainer-net | Out-Null
    }

    $imageExists = docker images --filter "reference=${HUDDLE_IMAGE}" --format "{{.Repository}}"
    if (-not $imageExists) {
        Write-Host "  Image '${HUDDLE_IMAGE}' niet gevonden -- bouwen..." -ForegroundColor DarkCyan
        $scriptDir = Split-Path $MyInvocation.ScriptName -Parent
        docker build -t $HUDDLE_IMAGE (Join-Path $scriptDir "gateway")
        if ($LASTEXITCODE -ne 0) { Write-Host "  Build mislukt." -ForegroundColor Red; return }
    }

    $stopped = docker ps -aq --filter "name=^${HUDDLE_CONTAINER}$" 2>$null
    if ($stopped) { docker rm $HUDDLE_CONTAINER | Out-Null }

    Write-Host "  Huddle starten..." -ForegroundColor DarkCyan
    $scriptDir = Split-Path $MyInvocation.ScriptName -Parent
    $bugtrackerDir = Join-Path $scriptDir "bugtracker"
    New-Item -ItemType Directory -Force -Path (Join-Path $bugtrackerDir "bugs") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $bugtrackerDir "solved") | Out-Null
    $runArgs = @(
        '-d',
        '--name', $HUDDLE_CONTAINER,
        '--network', 'devcontainer-net',
        # Laat huddle de Windows-host bereiken (voor o.a. de sparky port-proxy op
        # host.docker.internal:11434). Modelverkeer blijft zo via de proxy lopen.
        '--add-host', 'host.docker.internal:host-gateway',
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
    $scriptDir = Split-Path $MyInvocation.ScriptName -Parent
    Write-Host "  Image '${HUDDLE_IMAGE}' bouwen..." -ForegroundColor DarkCyan
    docker build -t $HUDDLE_IMAGE (Join-Path $scriptDir "gateway")
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
        $scriptDir = Split-Path $MyInvocation.ScriptName -Parent
        # Build-context = repo-root zodat de Dockerfile `COPY .ai/…` kan; Dockerfile via -f.
        docker build -t $picked.Name -f (Join-Path $scriptDir "$($ide.Folder)/Dockerfile") $scriptDir
        if ($LASTEXITCODE -ne 0) { Write-Host "  Build mislukt." -ForegroundColor Red; return }
    }

    $workspaceDir = Read-Host "  Workspace directory"
    if (-not (Test-Path $workspaceDir)) {
        Write-Host "  Directory bestaat niet: $workspaceDir" -ForegroundColor Red; return
    }

    $leafName           = Split-Path $workspaceDir -Leaf
    $containerWorkspace = "/workspaces/$leafName"
    $presentableName    = $leafName
    $devcontainerId     = [System.Guid]::NewGuid().ToString("N")
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

    # ── VS Code-variant ──────────────────────────────────────────────────────
    # VS Code installeert zijn eigen backend (VS Code Server) bij het attachen, dus
    # geen JB host-config / RemoteDev-distro / model-backend nodig. Wel exact dezelfde
    # com.intellij.devcontainer.* tracking-labels zodat snapshots en de listing-flow
    # ongewijzigd blijven werken. Daarna alleen de firewall-redirect + curlrc zetten.
    if ($ide.Key -eq 'vscode') {
        $modelJson    = "{`"customizations`":{`"jetbrains`":{`"backend`":`"$($ide.Backend)`"}}}"
        $metadataJson = '[{"remoteUser":"vscode"}]'

        $labelFile = Join-Path $env:TEMP "dc-labels-${devcontainerId}.txt"
        $lines = @(
            "com.intellij.devcontainer.id=${devcontainerId}",
            "com.intellij.devcontainer.presentable.name=${presentableName}",
            "com.intellij.devcontainer.sources.path=${workspaceDirFwd}",
            "com.intellij.devcontainer.workspace.path=${containerWorkspace}",
            "com.intellij.devcontainer.model=${modelJson}",
            "com.devcontainer.ide=vscode",
            "devcontainer.metadata=${metadataJson}"
        )
        [IO.File]::WriteAllLines($labelFile, $lines, [Text.UTF8Encoding]::new($false))

        $netExists = docker network ls --filter 'name=^devcontainer-net$' --format "{{.Name}}"
        if (-not $netExists) {
            Write-Host "  Netwerk 'devcontainer-net' aanmaken..." -ForegroundColor DarkCyan
            docker network create devcontainer-net | Out-Null
        }

        Write-Host "  Container starten als '$containerName'..." -ForegroundColor DarkCyan
        docker run -d `
            --name $containerName `
            --label-file $labelFile `
            -e "_CONTAINER_USER=vscode" `
            -e "_CONTAINER_USER_HOME=/home/vscode" `
            -e "_REMOTE_USER=vscode" `
            -e "_REMOTE_USER_HOME=/home/vscode" `
            -e "http_proxy=http://huddle:80" `
            -e "https_proxy=http://huddle:80" `
            -e "HTTP_PROXY=http://huddle:80" `
            -e "HTTPS_PROXY=http://huddle:80" `
            -v "${workspaceDirFwd}:${containerWorkspace}" `
            --network devcontainer-net `
            --cap-add NET_ADMIN `
            $picked.Name | Out-Null

        Remove-Item $labelFile -Force -ErrorAction SilentlyContinue

        Write-Host "  Firewall-redirect instellen..." -ForegroundColor DarkCyan
        $vscCmd = @'
#!/bin/sh
CURL_LINE='--proxy-header "X-Container-ID: CONTAINER_NAME_PLACEHOLDER"'
grep -qF "$CURL_LINE" /home/vscode/.curlrc 2>/dev/null || echo "$CURL_LINE" >> /home/vscode/.curlrc

HUDDLE_IP=$(getent hosts huddle | awk '{print $1}')
iptables -t nat -C OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80" 2>/dev/null || \
  iptables -t nat -A OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80"
'@
        $vscCmd = ($vscCmd `
            -replace 'CONTAINER_NAME_PLACEHOLDER', $containerName) -replace "`r`n", "`n"
        $vscScriptFile = Join-Path $env:TEMP "vsc-config-${devcontainerId}.sh"
        [IO.File]::WriteAllText($vscScriptFile, $vscCmd, [Text.UTF8Encoding]::new($false))
        docker cp $vscScriptFile "${containerName}:/tmp/vsc-config.sh" | Out-Null
        docker exec -u root $containerName sh /tmp/vsc-config.sh
        Remove-Item $vscScriptFile -Force -ErrorAction SilentlyContinue

        Write-Host "  [OK] Container '$containerName' klaar." -ForegroundColor Green
        Write-Host "  Verbind via VS Code: 'Dev Containers: Attach to Running Container' -> '$containerName'," -ForegroundColor Cyan
        Write-Host "  open daarna de map '$containerWorkspace'." -ForegroundColor Cyan
        return
    }

    # Model JSON komt overeen met de IDE-keuze; JB Gateway leest dit label
    # om te beslissen welk backend-distro het downloadt.
    $modelJson    = "{`"customizations`":{`"jetbrains`":{`"backend`":`"$($ide.Backend)`"}}}"
    $metadataJson = '[{"remoteUser":"vscode"}]'

    $labelFile = Join-Path $env:TEMP "dc-labels-${devcontainerId}.txt"
    $lines = @(
        "com.intellij.devcontainer.id=${devcontainerId}",
        "com.intellij.devcontainer.presentable.name=${presentableName}",
        "com.intellij.devcontainer.sources.path=${workspaceDirFwd}",
        "com.intellij.devcontainer.workspace.path=${containerWorkspace}",
        "com.intellij.devcontainer.model=${modelJson}",
        "devcontainer.metadata=${metadataJson}"
    )
    [IO.File]::WriteAllLines($labelFile, $lines, [Text.UTF8Encoding]::new($false))

    $netExists = docker network ls --filter 'name=^devcontainer-net$' --format "{{.Name}}"
    if (-not $netExists) {
        Write-Host "  Netwerk 'devcontainer-net' aanmaken..." -ForegroundColor DarkCyan
        docker network create devcontainer-net | Out-Null
    }

    Write-Host "  Container starten als '$containerName'..." -ForegroundColor DarkCyan
    docker run -d `
        --name $containerName `
        --label-file $labelFile `
        -e "DEVCONTAINER_CONFIG_PATH=/.jbdevcontainer/config/JetBrains/host-config.json" `
        -e "_CONTAINER_USER=vscode" `
        -e "_CONTAINER_USER_HOME=/home/vscode" `
        -e "_REMOTE_USER=vscode" `
        -e "_REMOTE_USER_HOME=/home/vscode" `
        -e "XDG_DATA_HOME=/.jbdevcontainer/data" `
        -e "http_proxy=http://huddle:80" `
        -e "https_proxy=http://huddle:80" `
        -e "HTTP_PROXY=http://huddle:80" `
        -e "HTTPS_PROXY=http://huddle:80" `
        -e "JAVA_TOOL_OPTIONS=-Dhttp.proxyHost=huddle -Dhttp.proxyPort=80 -Dhttps.proxyHost=huddle -Dhttps.proxyPort=80 -Dhttp.nonProxyHosts=" `
        -v "jb_devcontainers_shared_volume:/.jbdevcontainer/JetBrains/RemoteDev/dist:z" `
        -v "${workspaceDirFwd}:${containerWorkspace}" `
        --network devcontainer-net `
        --cap-add NET_ADMIN `
        $picked.Name | Out-Null

    Remove-Item $labelFile -Force -ErrorAction SilentlyContinue

    Write-Host "  Host config aanmaken..." -ForegroundColor DarkCyan
    # Filter het IDE-distro op naam — Rider-distros heten `*JetBrains.Rider-*`,
    # IntelliJ-distros `*idea-*`. Tail -1 pakt de hoogste versie.
    $ideFilter = if ($ide.Key -eq 'rider') { 'rider' } else { 'idea' }
    $configCmd = @'
#!/bin/sh
IDEA_DIR=$(ls /.jbdevcontainer/JetBrains/RemoteDev/dist/ | grep -i IDE_FILTER_PLACEHOLDER | sort -t- -k2 -V | tail -1)
IDEA_PATH="/.jbdevcontainer/JetBrains/RemoteDev/dist/$IDEA_DIR"
BUILD=$(grep -o '"buildNumber":"[^"]*"' "$IDEA_PATH/product-info.json" | cut -d'"' -f4)
CODE=$(grep -o '"productCode":"[^"]*"' "$IDEA_PATH/product-info.json" | cut -d'"' -f4)
PROJ="WORKSPACE_PLACEHOLDER"
mkdir -p /.jbdevcontainer/config/JetBrains
printf '{"connectionParams":{"type":"docker","projectPath":"%s","deploy":"false","idePath":"%s","buildNumber":"%s","productCode":"%s"},"forwardPorts":{},"customizations":{"jetbrains":{}}}' "$PROJ" "$IDEA_PATH" "$BUILD" "$CODE" > /.jbdevcontainer/config/JetBrains/host-config.json

CURL_LINE='--proxy-header "X-Container-ID: CONTAINER_NAME_PLACEHOLDER"'
grep -qF "$CURL_LINE" /home/vscode/.curlrc 2>/dev/null || echo "$CURL_LINE" >> /home/vscode/.curlrc

HUDDLE_IP=$(getent hosts huddle | awk '{print $1}')
iptables -t nat -C OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80" 2>/dev/null || \
  iptables -t nat -A OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80"
'@
    $configCmd = (($configCmd `
        -replace 'WORKSPACE_PLACEHOLDER', $containerWorkspace) `
        -replace 'CONTAINER_NAME_PLACEHOLDER', $containerName) `
        -replace 'IDE_FILTER_PLACEHOLDER', $ideFilter -replace "`r`n", "`n"
    $configScriptFile = Join-Path $env:TEMP "jb-config-${devcontainerId}.sh"
    [IO.File]::WriteAllText($configScriptFile, $configCmd, [Text.UTF8Encoding]::new($false))
    docker cp $configScriptFile "${containerName}:/tmp/jb-config.sh" | Out-Null
    docker exec -u root $containerName sh /tmp/jb-config.sh
    Remove-Item $configScriptFile -Force -ErrorAction SilentlyContinue

    Write-Host "  [OK] Container '$containerName' klaar." -ForegroundColor Green
    Write-Host "  Verbind via Remote Development > Dev Containers met '$containerName'" -ForegroundColor Cyan
}

# ── Build base image ──────────────────────────────────────────────────────────

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

    $scriptDir = Split-Path $MyInvocation.ScriptName -Parent
    $buildPath = Join-Path $scriptDir $ide.Folder
    if (-not (Test-Path (Join-Path $buildPath 'Dockerfile'))) {
        Write-Host "  Dockerfile niet gevonden: $buildPath\Dockerfile" -ForegroundColor Red
        return
    }
    Write-Host "  Image '$($ide.Image)' bouwen ($($ide.Display))..." -ForegroundColor DarkCyan
    # Build-context = repo-root zodat de Dockerfile `COPY .ai/…` kan; Dockerfile via -f.
    docker build -t $ide.Image -f (Join-Path $buildPath 'Dockerfile') $scriptDir
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] Image '$($ide.Image)' klaar." -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Build mislukt." -ForegroundColor Red
    }
}

# ── Build alle base images parallel ─────────────────────────────────────────────

# Bouwt elke IDE-base-image tegelijk via losse `docker build`-achtergrondprocessen.
# Output per build gaat naar een eigen logbestand in $env:TEMP (parallelle builds
# door elkaar op de console is onleesbaar); aan het eind volgt een overzicht.
function Build-AllBaseImages {
    $scriptDir = Split-Path $MyInvocation.ScriptName -Parent
    Write-Host "  Alle base images parallel bouwen..." -ForegroundColor DarkCyan
    Write-Host ""

    $builds = @()
    foreach ($ide in $IDE_DEFS) {
        $dockerfile = Join-Path (Join-Path $scriptDir $ide.Folder) 'Dockerfile'
        if (-not (Test-Path $dockerfile)) {
            Write-Host "  [SKIP] Dockerfile niet gevonden voor $($ide.Display): $dockerfile" -ForegroundColor Yellow
            continue
        }
        $logOut = Join-Path $env:TEMP "huddle-build-$($ide.Key).out.log"
        $logErr = Join-Path $env:TEMP "huddle-build-$($ide.Key).err.log"
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
