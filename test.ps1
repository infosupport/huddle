$ErrorActionPreference = "Stop"

$WorkspaceDir = $PSScriptRoot

Write-Host "`n=== Snapshot van working devcontainer ===" -ForegroundColor Cyan

$SourceContainer = "interesting_buck"
$SnapshotImage   = "huddle-snapshot"
$SnapshotName    = "huddle-running"

# Commit de draaiende container naar een image
Write-Host "docker commit $SourceContainer -> $SnapshotImage ..."
docker commit $SourceContainer $SnapshotImage

# Kopieer devcontainer-labels zodat IntelliJ de container herkent.
# Labels met JSON-waarden (bevatten ") worden overgeslagen: PowerShell escapet
# die niet correct voor externe commando's, waardoor docker de JSON-fragmenten
# als image-naam interpreteert.
$inspect   = docker inspect $SourceContainer | ConvertFrom-Json
$labels    = $inspect[0].Config.Labels
$labelArgs = @()
foreach ($key in $labels.PSObject.Properties.Name) {
    $value = $labels.$key
    if ($value -notmatch '"') {
        $labelArgs += "--label"
        $labelArgs += "${key}=${value}"
    }
}

# Verwijder eventuele oude instantie en start de snapshot
$existing = docker ps -aq --filter "name=^${SnapshotName}$" 2>$null
if ($existing) { docker rm -f $SnapshotName | Out-Null }
Write-Host "Container starten als '$SnapshotName'..."
$snapshotId = docker run -d `
    --name $SnapshotName `
    @labelArgs `
    -v "jb_devcontainers_shared_volume:/.jbdevcontainer/JetBrains/RemoteDev/dist:z" `
    -v "${WorkspaceDir}:/workspaces/huddle" `
    $SnapshotImage
Write-Host "Gestart: $snapshotId"
Write-Host "Verbind IntelliJ via Remote Development > Dev Containers met container '$SnapshotName'" -ForegroundColor Green
