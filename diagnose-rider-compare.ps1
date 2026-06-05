[CmdletBinding()]
param(
    [string]$Broken  = 'devcontainer-empty1',
    [string]$Working = 'devcontainer-empty2',
    [string]$LogFile = "$PSScriptRoot\rider-compare.log",
    [string]$JsonDir = "$PSScriptRoot"
)

# Vergelijkt twee devcontainers: een werkende (snapshot van JB-gestarte container)
# vs een niet-werkende (lege baseimage via huddle). Dumpt voor elke probe de output
# van beide containers en flagt waar ze verschillen.

$ErrorActionPreference = 'Continue'

# We schrijven via één StreamWriter ipv Add-Content per regel. Add-Content opent en
# sluit de file bij elke aanroep, wat op Windows met Defender/OneDrive sharing
# violations geeft als je honderden keren snel achter elkaar schrijft.
if (Test-Path $LogFile) { Remove-Item $LogFile -Force }
$script:LogWriter = [System.IO.StreamWriter]::new($LogFile, $false, [System.Text.UTF8Encoding]::new($false))
$script:LogWriter.AutoFlush = $false

function W { param([string]$Text) $script:LogWriter.WriteLine($Text) }

function W-Section {
    param([string]$Title)
    W ""
    W "==================== $Title ===================="
    W ""
}

# Runs a shell snippet inside a container via base64 so PowerShell quoting can't bite.
# Returns the captured stdout/stderr as a single string.
function Get-DockerShOutput {
    param([string]$Container, [string]$Script)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Script)
    $b64   = [Convert]::ToBase64String($bytes)
    $out = & docker exec $Container sh -c "echo $b64 | base64 -d | sh" 2>&1 | Out-String
    if ($null -eq $out) { return '' }
    return $out
}

# Probe = run dezelfde shell op beide containers, dump beide outputs, en vergelijk regelvoor-regel.
function Compare-Probe {
    param([string]$Title, [string]$Script)
    W-Section $Title
    W "--- script ---"
    W $Script
    $brokenOut  = Get-DockerShOutput -Container $Broken  -Script $Script
    $workingOut = Get-DockerShOutput -Container $Working -Script $Script
    W ""
    W "--- $Broken (broken) ---"
    W $brokenOut
    W "--- $Working (working) ---"
    W $workingOut

    $brokenLines  = $brokenOut  -split "(`r`n|`r|`n)" | Where-Object { $_ -notmatch '^(`r`n|`r|`n)$' }
    $workingLines = $workingOut -split "(`r`n|`r|`n)" | Where-Object { $_ -notmatch '^(`r`n|`r|`n)$' }
    $diff = Compare-Object -ReferenceObject $brokenLines -DifferenceObject $workingLines -CaseSensitive
    if ($null -eq $diff -or $diff.Count -eq 0) {
        W "--- DIFF: identical ---"
    } else {
        W "--- DIFF (<= only in $Broken, => only in $Working) ---"
        foreach ($d in $diff) {
            $marker = if ($d.SideIndicator -eq '<=') { '<= broken  :' } else { '=> working :' }
            W ("{0} {1}" -f $marker, $d.InputObject)
        }
    }
}

# Dump docker inspect for each container to disk for proper structural diffing later.
function Dump-Inspect {
    param([string]$Container, [string]$Path)
    & docker inspect $Container 2>&1 | Out-File -FilePath $Path -Encoding utf8
}

W "Rider devcontainer compare"
W "Broken  : $Broken"
W "Working : $Working"
W "Date    : $(Get-Date -Format o)"

# --- Phase 1: docker inspect dumps ----------------------------------------
W-Section "0. docker inspect dumps written to disk"
$brokenJson  = Join-Path $JsonDir "compare-broken-$Broken.json"
$workingJson = Join-Path $JsonDir "compare-working-$Working.json"
Dump-Inspect -Container $Broken  -Path $brokenJson
Dump-Inspect -Container $Working -Path $workingJson
W "Broken  inspect -> $brokenJson"
W "Working inspect -> $workingJson"
W "Use: git diff --no-index $brokenJson $workingJson"

# Compact field-by-field comparison of the docker inspect, key fields only.
W-Section "1. docker inspect: key fields side by side"
function Get-InspectFields {
    param([string]$Container)
    $json = (& docker inspect $Container 2>&1 | Out-String)
    $obj  = ($json | ConvertFrom-Json)[0]
    [PSCustomObject]@{
        Image          = $obj.Image
        ImageName      = $obj.Config.Image
        User           = $obj.Config.User
        WorkingDir     = $obj.Config.WorkingDir
        Entrypoint     = ($obj.Config.Entrypoint -join ' ')
        Cmd            = ($obj.Config.Cmd -join ' ')
        Hostname       = $obj.Config.Hostname
        NetworkMode    = $obj.HostConfig.NetworkMode
        Networks       = (($obj.NetworkSettings.Networks.PSObject.Properties | ForEach-Object { $_.Name }) -join ',')
        IPs            = (($obj.NetworkSettings.Networks.PSObject.Properties | ForEach-Object { $_.Value.IPAddress }) -join ',')
        CapAdd         = (($obj.HostConfig.CapAdd) -join ',')
        CapDrop        = (($obj.HostConfig.CapDrop) -join ',')
        SecurityOpt    = (($obj.HostConfig.SecurityOpt) -join ',')
        Privileged     = $obj.HostConfig.Privileged
        ShmSize        = $obj.HostConfig.ShmSize
        IpcMode        = $obj.HostConfig.IpcMode
        PidMode        = $obj.HostConfig.PidMode
        ReadonlyRootfs = $obj.HostConfig.ReadonlyRootfs
        AutoRemove     = $obj.HostConfig.AutoRemove
        RestartPolicy  = $obj.HostConfig.RestartPolicy.Name
        MountCount     = $obj.Mounts.Count
        MountSummary   = (($obj.Mounts | ForEach-Object { "$($_.Type):$($_.Source)->$($_.Destination)" }) -join " ; ")
        EnvCount       = $obj.Config.Env.Count
        LabelKeys      = (($obj.Config.Labels.PSObject.Properties | ForEach-Object { $_.Name }) -join ',')
    }
}
$bFields = Get-InspectFields -Container $Broken
$wFields = Get-InspectFields -Container $Working
$fieldNames = $bFields.PSObject.Properties.Name
$rows = foreach ($f in $fieldNames) {
    $bv = "$($bFields.$f)"
    $wv = "$($wFields.$f)"
    [PSCustomObject]@{
        Field    = $f
        Broken   = $bv
        Working  = $wv
        Differs  = if ($bv -ne $wv) { 'YES' } else { '' }
    }
}
$rows | Format-Table -AutoSize -Wrap | Out-String | ForEach-Object { W $_ }

# Env-vars en labels worden uitgesplitst, want zitten meestal in de "echte" verschillen.
W-Section "2. Env vars: union sorted, marked B/W/=/!="
function Get-EnvMap {
    param([string]$Container)
    $env = (& docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $Container) -split "`n" |
        Where-Object { $_ -match '=' }
    $map = @{}
    foreach ($line in $env) {
        $idx = $line.IndexOf('=')
        $k = $line.Substring(0, $idx)
        $v = $line.Substring($idx + 1)
        $map[$k] = $v
    }
    return $map
}
$bEnv = Get-EnvMap $Broken
$wEnv = Get-EnvMap $Working
$allKeys = ($bEnv.Keys + $wEnv.Keys) | Sort-Object -Unique
foreach ($k in $allKeys) {
    $hasB = $bEnv.ContainsKey($k); $hasW = $wEnv.ContainsKey($k)
    if ($hasB -and $hasW) {
        if ($bEnv[$k] -eq $wEnv[$k]) { W ("=  {0}={1}" -f $k, $bEnv[$k]) }
        else { W ("!= {0}" -f $k); W ("   broken : {0}" -f $bEnv[$k]); W ("   working: {0}" -f $wEnv[$k]) }
    } elseif ($hasB) { W ("B  {0}={1}" -f $k, $bEnv[$k]) }
    else { W ("W  {0}={1}" -f $k, $wEnv[$k]) }
}

W-Section "3. Labels: union sorted, marked B/W/=/!="
function Get-LabelMap {
    param([string]$Container)
    $json = (& docker inspect $Container | Out-String | ConvertFrom-Json)[0]
    $map = @{}
    if ($json.Config.Labels) {
        foreach ($p in $json.Config.Labels.PSObject.Properties) { $map[$p.Name] = $p.Value }
    }
    return $map
}
$bLab = Get-LabelMap $Broken
$wLab = Get-LabelMap $Working
$allLabels = ($bLab.Keys + $wLab.Keys) | Sort-Object -Unique
foreach ($k in $allLabels) {
    $hasB = $bLab.ContainsKey($k); $hasW = $wLab.ContainsKey($k)
    if ($hasB -and $hasW) {
        if ($bLab[$k] -eq $wLab[$k]) { W ("=  {0}={1}" -f $k, $bLab[$k]) }
        else { W ("!= {0}" -f $k); W ("   broken : {0}" -f $bLab[$k]); W ("   working: {0}" -f $wLab[$k]) }
    } elseif ($hasB) { W ("B  {0}={1}" -f $k, $bLab[$k]) }
    else { W ("W  {0}={1}" -f $k, $wLab[$k]) }
}

W-Section "4. Mounts: side-by-side"
function Get-MountList {
    param([string]$Container)
    $json = (& docker inspect $Container | Out-String | ConvertFrom-Json)[0]
    $json.Mounts | ForEach-Object { "{0,-7} {1,-50} -> {2}" -f $_.Type, $_.Source, $_.Destination }
}
W "--- broken ---"
Get-MountList $Broken  | ForEach-Object { W $_ }
W "--- working ---"
Get-MountList $Working | ForEach-Object { W $_ }

# --- Phase 2: in-container probes -----------------------------------------

Compare-Probe -Title '10. /etc/os-release' -Script @'
cat /etc/os-release 2>/dev/null
'@

Compare-Probe -Title '11. uname + kernel' -Script @'
uname -a
'@

Compare-Probe -Title '12. id / whoami / groups' -Script @'
echo "whoami: $(whoami)"
echo "id    : $(id)"
echo "groups: $(groups)"
'@

Compare-Probe -Title '13. /etc/passwd users with home in /home or /.jbdevcontainer' -Script @'
grep -E "/(home|\.jbdevcontainer)" /etc/passwd | sort
'@

Compare-Probe -Title '14. effective env (sorted)' -Script @'
env | sort
'@

Compare-Probe -Title '15. PATH segments (one per line)' -Script @'
echo "$PATH" | tr : "\n"
'@

Compare-Probe -Title '16. mount table (filtered to interesting fs types)' -Script @'
mount | grep -vE "proc|cgroup|sysfs|devpts|mqueue|tmpfs" | sort
'@

Compare-Probe -Title '17. tmpfs mounts' -Script @'
mount | grep tmpfs | sort
'@

Compare-Probe -Title '18. process tree (long form)' -Script @'
ps -efH 2>/dev/null || ps -ef
'@

Compare-Probe -Title '19. listening sockets' -Script @'
(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | head -40
'@

Compare-Probe -Title '20. capabilities of init (pid 1) + self' -Script @'
echo "--- pid 1 ---"
grep -E "^Cap" /proc/1/status
echo "--- self ---"
grep -E "^Cap" /proc/self/status
echo "--- capsh --print (if present) ---"
command -v capsh >/dev/null 2>&1 && capsh --print 2>/dev/null || echo "(capsh not installed)"
'@

Compare-Probe -Title '21. cgroup membership (pid 1)' -Script @'
cat /proc/1/cgroup
'@

Compare-Probe -Title '22. namespaces (pid 1 vs self)' -Script @'
ls -l /proc/1/ns 2>/dev/null
echo "---"
ls -l /proc/self/ns 2>/dev/null
'@

Compare-Probe -Title '23. /etc/resolv.conf + /etc/hosts' -Script @'
echo "--- /etc/resolv.conf ---"
cat /etc/resolv.conf 2>/dev/null
echo "--- /etc/hosts ---"
cat /etc/hosts 2>/dev/null
'@

Compare-Probe -Title '24. tooling presence (which X)' -Script @'
for cmd in docker sudo curl wget git ssh java javac dotnet python3 node npm; do
  printf "%-10s -> %s\n" "$cmd" "$(command -v $cmd 2>/dev/null || echo MISSING)"
done
'@

Compare-Probe -Title '25. /workspaces top level' -Script @'
ls -la /workspaces 2>/dev/null || echo "(no /workspaces)"
'@

Compare-Probe -Title '26. /.jbdevcontainer top level' -Script @'
ls -la /.jbdevcontainer 2>/dev/null || echo "(no /.jbdevcontainer)"
echo "--- /.jbdevcontainer/JetBrains ---"
ls -la /.jbdevcontainer/JetBrains 2>/dev/null || echo "(missing)"
echo "--- /.jbdevcontainer/JetBrains/RemoteDev/dist ---"
ls -la /.jbdevcontainer/JetBrains/RemoteDev/dist 2>/dev/null || echo "(missing)"
echo "--- /.jbdevcontainer/config/JetBrains ---"
ls -la /.jbdevcontainer/config/JetBrains 2>/dev/null || echo "(missing)"
'@

Compare-Probe -Title '27. host-config.json content' -Script @'
F=/.jbdevcontainer/config/JetBrains/host-config.json
if [ -f "$F" ]; then
  cat "$F"
else
  echo "(missing $F)"
fi
'@

Compare-Probe -Title '28. RemoteDev dist: detected build + product-info.json' -Script @'
D=$(ls /.jbdevcontainer/JetBrains/RemoteDev/dist/ 2>/dev/null | grep -i rider | sort -t- -k2 -V | tail -1)
echo "DIST=$D"
if [ -n "$D" ]; then
  P="/.jbdevcontainer/JetBrains/RemoteDev/dist/$D/product-info.json"
  echo "--- product-info.json ---"
  cat "$P" 2>/dev/null
fi
'@

Compare-Probe -Title '29. remote-dev-server.sh / launcher presence' -Script @'
D=$(ls /.jbdevcontainer/JetBrains/RemoteDev/dist/ 2>/dev/null | grep -i rider | sort -t- -k2 -V | tail -1)
B="/.jbdevcontainer/JetBrains/RemoteDev/dist/$D/bin"
echo "BIN=$B"
ls -la "$B" 2>/dev/null | head -20
'@

Compare-Probe -Title '30. home dir layouts (vscode, root)' -Script @'
for h in /home/vscode /home/dev /root; do
  if [ -d "$h" ]; then
    echo "--- $h ---"
    ls -la "$h" 2>/dev/null
  fi
done
'@

Compare-Probe -Title '31. sudoers + sudoers.d' -Script @'
ls -la /etc/sudoers /etc/sudoers.d 2>/dev/null
echo "--- /etc/sudoers ---"
sudo -n cat /etc/sudoers 2>/dev/null || cat /etc/sudoers 2>/dev/null || echo "(unreadable)"
'@

Compare-Probe -Title '32. installed apt packages (count + last 30)' -Script @'
if command -v dpkg-query >/dev/null 2>&1; then
  echo "count: $(dpkg-query -W -f='${Package}\n' | wc -l)"
  echo "--- last 30 alphabetical ---"
  dpkg-query -W -f='${Package} ${Version}\n' | sort | tail -30
else
  echo "(no dpkg)"
fi
'@

Compare-Probe -Title '33. /etc/security/limits.conf + ulimit -a' -Script @'
echo "--- limits.conf ---"
cat /etc/security/limits.conf 2>/dev/null | grep -vE "^\s*#|^\s*$"
echo "--- ulimit -a ---"
sh -c 'ulimit -a'
'@

Compare-Probe -Title '34. seccomp / apparmor / no-new-privs' -Script @'
grep -E "Seccomp|NoNewPrivs" /proc/1/status
grep -E "Seccomp|NoNewPrivs" /proc/self/status
echo "--- /proc/1/attr/current (apparmor profile) ---"
cat /proc/1/attr/current 2>/dev/null
'@

Compare-Probe -Title '35. selected sysctls' -Script @'
for k in fs.inotify.max_user_watches fs.inotify.max_user_instances kernel.pid_max kernel.yama.ptrace_scope vm.max_map_count net.ipv4.ip_local_port_range; do
  v=$(cat /proc/sys/$(echo $k | tr . /) 2>/dev/null || echo "n/a")
  printf "%-40s = %s\n" "$k" "$v"
done
'@

Compare-Probe -Title '36. /var/run/docker.sock visibility' -Script @'
ls -la /var/run/docker.sock 2>/dev/null || echo "(no docker.sock)"
echo "--- docker info (if reachable) ---"
docker info 2>&1 | head -25
'@

Compare-Probe -Title '37. devcontainer-feature traces' -Script @'
ls -la /usr/local/share/devcontainer* 2>/dev/null
ls -la /etc/devcontainer* 2>/dev/null
find / -maxdepth 4 -name "devcontainer*" 2>/dev/null | head -30
'@

Compare-Probe -Title '38. JetBrains Daemon / fsnotifier / station sockets in /tmp' -Script @'
ls -la /tmp 2>/dev/null | grep -iE "jetbrains|station|jbr|sa[f0-9]" || echo "(none)"
'@

Compare-Probe -Title '39. .bashrc / .profile / .zshrc for vscode-ish users' -Script @'
for u in vscode dev; do
  h="/home/$u"
  for f in .bashrc .profile .bash_profile .zshrc .pam_environment; do
    if [ -f "$h/$f" ]; then
      echo "--- $h/$f ---"
      sed -n "1,80p" "$h/$f"
    fi
  done
done
'@

Compare-Probe -Title '40. /etc/profile.d entries' -Script @'
ls -la /etc/profile.d 2>/dev/null
echo "--- contents (first 10 lines each) ---"
for f in /etc/profile.d/*.sh; do
  [ -f "$f" ] || continue
  echo "### $f ###"
  sed -n "1,10p" "$f"
done
'@

$script:LogWriter.Flush()
$script:LogWriter.Dispose()

Write-Host "Done. Log written to: $LogFile" -ForegroundColor Green
Write-Host "Inspect JSON dumps:" -ForegroundColor Green
Write-Host "  $brokenJson"
Write-Host "  $workingJson"
Write-Host "Quick structural diff: git diff --no-index `"$brokenJson`" `"$workingJson`""
