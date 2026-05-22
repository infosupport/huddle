# ──────────────────────────────────────────────────────────────────────────────
#  Huddle CLI  --  DMZ Devcontainer Manager
# ──────────────────────────────────────────────────────────────────────────────

$HUDDLE_CONTAINER = "huddle"
$HUDDLE_IMAGE     = "huddle"
$HUDDLE_VOLUME    = "huddle-data"
$HUDDLE_PORT      = 3000
$BASE_IMAGE       = "base-devimage"

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
    Write-Host "   2  Devcontainer starten van snapshot" -ForegroundColor White
    Write-Host "   3  Base image bouwen" -ForegroundColor White
    Write-Host "   4  Huddle image bouwen" -ForegroundColor White
    Write-Host "   5  Huddle herstarten" -ForegroundColor White
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
    $id = docker run -d `
        --name $HUDDLE_CONTAINER `
        --network devcontainer-net `
        -p "${HUDDLE_PORT}:3000" `
        -v "${HUDDLE_VOLUME}:/data" `
        -v "/var/run/docker.sock:/var/run/docker.sock" `
        -v "/tmp/dc-sockets:/tmp/dc-sockets" `
        $HUDDLE_IMAGE
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

    $defaultName = "snapshot-$($container.Name)"
    $imageName   = Read-Host "  Snapshot naam [$defaultName]"
    if (-not $imageName) { $imageName = $defaultName }

    Write-Host "  Commit $($container.Name) -> $imageName ..." -ForegroundColor DarkCyan
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    docker commit `
        --change 'LABEL com.devcontainer.snapshot=true' `
        --change "LABEL com.devcontainer.source=$($container.Name)" `
        --change "LABEL com.devcontainer.created=$timestamp" `
        $container.ID $imageName | Out-Null
    Write-Host "  [OK] Snapshot '$imageName' klaar." -ForegroundColor Green
}

# ── Start from snapshot ───────────────────────────────────────────────────────

function Start-FromSnapshot {
    Write-Host ""
    Write-Host "  Beschikbare snapshots:" -ForegroundColor DarkCyan

    $fmt = "{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedSince}}"
    $rows = @(docker images --filter 'label=com.devcontainer.snapshot=true' --format $fmt |
        ForEach-Object {
            $p = $_ -split '\|'
            [PSCustomObject]@{ Name = $p[0]; ID = $p[1]; Size = $p[2]; Created = $p[3] }
        })

    if (-not $rows) { Write-Host "  Geen snapshots gevonden." -ForegroundColor Yellow; return }

    for ($i = 0; $i -lt $rows.Count; $i++) {
        Write-Host ("   {0})  {1,-45}  {2,8}  ({3})" -f ($i + 1), $rows[$i].Name, $rows[$i].Size, $rows[$i].Created)
    }

    $sel = [int](Read-Host "`n  Kies snapshot") - 1
    if ($sel -lt 0 -or $sel -ge $rows.Count) { Write-Host "  Ongeldige keuze." -ForegroundColor Red; return }
    $image = $rows[$sel]

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

    $modelJson    = '{"customizations":{"jetbrains":{"backend":"IntelliJ"}}}'
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
        $image.Name | Out-Null

    Remove-Item $labelFile -Force -ErrorAction SilentlyContinue

    Write-Host "  Host config aanmaken..." -ForegroundColor DarkCyan
    $configCmd = @'
#!/bin/sh
IDEA_DIR=$(ls /.jbdevcontainer/JetBrains/RemoteDev/dist/ | grep idea | sort -t- -k2 -V | tail -1)
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
    $configCmd = ($configCmd -replace 'WORKSPACE_PLACEHOLDER', $containerWorkspace) -replace 'CONTAINER_NAME_PLACEHOLDER', $containerName -replace "`r`n", "`n"
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
    $defaultName = $BASE_IMAGE
    $imageName   = Read-Host "  Image naam [$defaultName]"
    if (-not $imageName) { $imageName = $defaultName }
    $scriptDir = Split-Path $MyInvocation.ScriptName -Parent
    $buildPath = Join-Path $scriptDir "base-devimage"
    Write-Host "  Image '$imageName' bouwen..." -ForegroundColor DarkCyan
    docker build -t $imageName $buildPath
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] Image '$imageName' klaar." -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Build mislukt." -ForegroundColor Red
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
        '2' { Start-FromSnapshot; Read-Host "`n  Druk Enter om terug te gaan" }
        '3' { Build-BaseImage;    Read-Host "`n  Druk Enter om terug te gaan" }
        '4' { Build-HuddleImage;  Read-Host "`n  Druk Enter om terug te gaan" }
        '5' { Restart-Huddle;     Read-Host "`n  Druk Enter om terug te gaan" }
        '0' { $running = $false }
        default { Write-Host "  Ongeldige keuze." -ForegroundColor Red; Start-Sleep -Seconds 1 }
    }
}
