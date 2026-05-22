param(
    [Parameter(Mandatory)] [Alias('Working')] [string]$ContainerA,
    [Parameter(Mandatory)] [Alias('Broken')]  [string]$ContainerB
)

$transcriptPath = Join-Path $PSScriptRoot 'error.txt'
Start-Transcript -Path $transcriptPath -Force | Out-Null

# ── helpers ──────────────────────────────────────────────────────────────────

function Get-ContainerInfo([string]$name) {
    $raw = docker inspect $name 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Host "Container '$name' niet gevonden." -ForegroundColor Red; Stop-Transcript | Out-Null; exit 1 }
    $c = ($raw -join '') | ConvertFrom-Json
    $c = $c[0]
    [PSCustomObject]@{
        Name        = [string]$name
        User        = [string]$c.Config.User
        Entrypoint  = [string]($c.Config.Entrypoint -join ' ')
        Cmd         = [string]($c.Config.Cmd -join ' ')
        NetworkMode = [string]$c.HostConfig.NetworkMode
        Privileged  = [string]$c.HostConfig.Privileged
        PidMode     = [string]$c.HostConfig.PidMode
        Env         = @($c.Config.Env | Where-Object { $_ } | Sort-Object)
        Labels      = @($c.Config.Labels.PSObject.Properties | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" })
        Mounts      = @($c.Mounts | ForEach-Object { "$($_.Type) $($_.Source) -> $($_.Destination)" } | Sort-Object)
    }
}

function Show-Header([string]$title) {
    Write-Host "`n=== $title ===" -ForegroundColor Cyan
}

function Get-Col($infoA, $infoB) {
    [Math]::Max($infoA.Name.Length, $infoB.Name.Length) + 2
}

function Compare-Scalars($infoA, $infoB, [string[]]$fields) {
    $col = Get-Col $infoA $infoB
    $fmt = "{0,-22} {1,-" + $col + "} {2}"
    Write-Host ($fmt -f 'Veld', $infoA.Name, $infoB.Name)
    Write-Host ('-' * (22 + $col + 40))
    foreach ($f in $fields) {
        $vA = [string]$infoA.$f
        $vB = [string]$infoB.$f
        $color = if ($vA -eq $vB) { 'Gray' } else { 'Yellow' }
        Write-Host ($fmt -f $f, $vA, $vB) -ForegroundColor $color
    }
}

function Compare-KeyLists($infoA, $infoB, [string[]]$listA, [string[]]$listB, [string]$delim) {
    $col  = Get-Col $infoA $infoB
    $fmtV = "      {0,-" + $col + "}: {1}"
    $fmtS = "  {0} {1,-" + $col + "}  (alleen in {2})"
    $keys = (($listA + $listB) | ForEach-Object { $_.Split($delim)[0] }) | Sort-Object -Unique
    foreach ($key in $keys) {
        $vA = $listA | Where-Object { $_.StartsWith("$key$delim") }
        $vB = $listB | Where-Object { $_.StartsWith("$key$delim") }
        if ($vA -and $vB) {
            if ($vA -eq $vB) {
                Write-Host "  [=] $key" -ForegroundColor Gray
            } else {
                $sA = $vA.Substring($key.Length + $delim.Length)
                $sB = $vB.Substring($key.Length + $delim.Length)
                Write-Host "  [~] $key" -ForegroundColor Yellow
                Write-Host ($fmtV -f $infoA.Name, $sA.Substring(0, [Math]::Min(120, $sA.Length))) -ForegroundColor DarkYellow
                Write-Host ($fmtV -f $infoB.Name, $sB.Substring(0, [Math]::Min(120, $sB.Length))) -ForegroundColor DarkRed
            }
        } elseif ($vA) {
            $val = $vA.Substring($key.Length + $delim.Length)
            Write-Host ($fmtS -f '[-]', $key, $infoA.Name) -ForegroundColor Yellow
            Write-Host ("      $($infoA.Name): $($val.Substring(0, [Math]::Min(200, $val.Length)))") -ForegroundColor DarkYellow
        } else {
            $val = $vB.Substring($key.Length + $delim.Length)
            Write-Host ($fmtS -f '[+]', $key, $infoB.Name) -ForegroundColor Red
            Write-Host ("      $($infoB.Name): $($val.Substring(0, [Math]::Min(200, $val.Length)))") -ForegroundColor DarkRed
        }
    }
}

function Get-Processes([string]$name) {
    $out = docker exec $name ps aux 2>&1
    if ($LASTEXITCODE -ne 0) { return @("(ps niet beschikbaar: $($out -join ' '))") }
    @($out | Select-Object -Skip 1 | ForEach-Object { ($_ -replace '\s+', ' ').Trim() })
}

function Get-DirListing([string]$name, [string]$path) {
    $out = docker exec $name sh -c "ls -la '$path' 2>&1" 2>&1
    if ($LASTEXITCODE -ne 0) { return @("(niet beschikbaar: $($out -join ' '))") }
    @($out)
}

# ── collect ───────────────────────────────────────────────────────────────────

$infoA = Get-ContainerInfo $ContainerA
$infoB = Get-ContainerInfo $ContainerB

# ── config ────────────────────────────────────────────────────────────────────

Show-Header 'Config'
Compare-Scalars $infoA $infoB @('User','Entrypoint','Cmd','NetworkMode','Privileged','PidMode')

# ── env vars ──────────────────────────────────────────────────────────────────

Show-Header 'Env vars'
Compare-KeyLists $infoA $infoB $infoA.Env $infoB.Env '='

# ── labels ────────────────────────────────────────────────────────────────────

Show-Header 'Labels'
Compare-KeyLists $infoA $infoB $infoA.Labels $infoB.Labels '='

# ── mounts ────────────────────────────────────────────────────────────────────

Show-Header 'Mounts'
$col  = Get-Col $infoA $infoB
$allM = ($infoA.Mounts + $infoB.Mounts) | Sort-Object -Unique
foreach ($m in $allM) {
    $inA = $infoA.Mounts -contains $m
    $inB = $infoB.Mounts -contains $m
    if ($inA -and $inB)  { Write-Host "  [=] $m" -ForegroundColor Gray }
    elseif ($inA)        { Write-Host "  [-] $m  (alleen in $ContainerA)" -ForegroundColor Yellow }
    else                 { Write-Host "  [+] $m  (alleen in $ContainerB)" -ForegroundColor Red }
}

# ── processes ─────────────────────────────────────────────────────────────────

Show-Header "Processen ($ContainerA)"
Get-Processes $ContainerA | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }

Show-Header "Processen ($ContainerB)"
Get-Processes $ContainerB | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }

# ── jbdevcontainer filesystem ─────────────────────────────────────────────────

foreach ($dir in @('/.jbdevcontainer', '/.jbdevcontainer/JetBrains/RemoteDev/dist', '/.jbdevcontainer/config')) {
    Show-Header $dir
    $lsA = Get-DirListing $ContainerA $dir
    $lsB = Get-DirListing $ContainerB $dir
    Write-Host "  [$ContainerA]" -ForegroundColor DarkYellow
    $lsA | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    Write-Host "  [$ContainerB]" -ForegroundColor DarkCyan
    $lsB | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkCyan }
}

Stop-Transcript | Out-Null
Write-Host "`nOutput geschreven naar: $transcriptPath" -ForegroundColor Green
