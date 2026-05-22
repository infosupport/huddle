param(
    [Parameter(Mandatory)]
    [string]$WorkspaceDir,

    [string]$SnapshotImage = "huddle-snapshot",
    [string]$ContainerName = "huddle-running"
)
$ErrorActionPreference = "Stop"

# Labels afleiden uit workspace en devcontainer.json
$WorkspaceDirFwd   = $WorkspaceDir.TrimEnd('\', '/') -replace '\\', '/'
$devcontainerJson  = Join-Path $WorkspaceDir ".devcontainer\devcontainer.json"
$config            = Get-Content $devcontainerJson -Raw | ConvertFrom-Json
$containerWorkspace = $config.workspaceFolder
$presentableName   = $config.name
$devcontainerId    = [System.Guid]::NewGuid().ToString("N")

$labelArgs = @(
    "--label", "com.intellij.devcontainer.id=${devcontainerId}",
    "--label", "com.intellij.devcontainer.presentable.name=${presentableName}",
    "--label", "com.intellij.devcontainer.sources.path=${WorkspaceDirFwd}",
    "--label", "com.intellij.devcontainer.workspace.path=${containerWorkspace}",
    "--label", "com.intellij.devcontainer.json.path=${containerWorkspace}/.devcontainer/devcontainer.json"
)

# Verwijder eventuele oude instantie
$existing = docker ps -aq --filter "name=^${ContainerName}$" 2>$null
if ($existing) {
    Write-Host "Oude instantie verwijderen..."
    docker rm -f $ContainerName | Out-Null
}

Write-Host "Container starten als '$ContainerName'..." -ForegroundColor Cyan
$id = docker run -d `
    --name $ContainerName `
    @labelArgs `
    -v "jb_devcontainers_shared_volume:/.jbdevcontainer/JetBrains/RemoteDev/dist:z" `
    -v "${WorkspaceDirFwd}:${containerWorkspace}" `
    $SnapshotImage

Write-Host "Gestart: $id" -ForegroundColor Green
Write-Host "Verbind IntelliJ via Remote Development > Dev Containers met '$ContainerName'" -ForegroundColor Cyan
