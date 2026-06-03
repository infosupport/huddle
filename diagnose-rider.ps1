[CmdletBinding()]
param(
    [string]$Container = 'devcontainer-empty1',
    [string]$LogFile   = "$PSScriptRoot\rider-diagnose.log"
)

$ErrorActionPreference = 'Continue'

function Write-Section {
    param([string]$Title, [string]$Cmd)
    Add-Content -Path $LogFile -Value ""
    Add-Content -Path $LogFile -Value "===== $Title ====="
    Add-Content -Path $LogFile -Value "`$ $Cmd"
    Add-Content -Path $LogFile -Value ""
}

# Runs an arbitrary shell snippet inside the container, immune to PowerShell's
# variable expansion / argument splitting by transporting it as base64.
function Invoke-DockerSh {
    param([string]$Title, [string]$Script)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Script)
    $b64   = [Convert]::ToBase64String($bytes)
    Write-Section -Title $Title -Cmd "docker exec $Container sh -c '<base64 shell>' (script below)"
    Add-Content -Path $LogFile -Value "--- script ---"
    Add-Content -Path $LogFile -Value $Script
    Add-Content -Path $LogFile -Value "--- output ---"
    & docker exec $Container sh -c "echo $b64 | base64 -d | sh" *>&1 | Out-String | Add-Content -Path $LogFile
}

if (Test-Path $LogFile) { Remove-Item $LogFile -Force }
New-Item -Path $LogFile -ItemType File -Force | Out-Null

Add-Content -Path $LogFile -Value "Rider devcontainer diagnose"
Add-Content -Path $LogFile -Value "Container : $Container"
Add-Content -Path $LogFile -Value "Date      : $(Get-Date -Format o)"

Write-Section -Title 'docker inspect (labels + env)' -Cmd "docker inspect $Container"
& docker inspect $Container *>&1 | Out-String | Add-Content -Path $LogFile

Invoke-DockerSh -Title '1. JetBrains dists in shared volume' -Script @'
ls -la /.jbdevcontainer/JetBrains/RemoteDev/dist/
'@

Invoke-DockerSh -Title '2. host-config.json content' -Script @'
cat /.jbdevcontainer/config/JetBrains/host-config.json
'@

Invoke-DockerSh -Title '3. host-config dir permissions' -Script @'
ls -la /.jbdevcontainer/config/JetBrains/
'@

Invoke-DockerSh -Title '4. product-info.json (from detected dist)' -Script @'
D=$(ls /.jbdevcontainer/JetBrains/RemoteDev/dist/ | grep -i rider | sort -t- -k2 -V | tail -1)
echo "DIST=$D"
if [ -n "$D" ]; then
  cat "/.jbdevcontainer/JetBrains/RemoteDev/dist/$D/product-info.json"
fi
'@

Invoke-DockerSh -Title '4b. Extracted BUILD/CODE values (should NOT be empty)' -Script @'
D=$(ls /.jbdevcontainer/JetBrains/RemoteDev/dist/ | grep -i rider | sort -t- -k2 -V | tail -1)
P="/.jbdevcontainer/JetBrains/RemoteDev/dist/$D/product-info.json"
echo "DIST=$D"
echo "PRODUCT_INFO=$P"
echo "OLD grep BUILD: '$(grep -o '\"buildNumber\":\"[^\"]*\"' "$P" | cut -d\" -f4)'"
echo "OLD grep CODE : '$(grep -o '\"productCode\":\"[^\"]*\"' "$P" | cut -d\" -f4)'"
echo "NEW awk BUILD : '$(awk -F\" '/\"buildNumber\"/ {print $4; exit}' "$P")'"
echo "NEW awk CODE  : '$(awk -F\" '/\"productCode\"/ {print $4; exit}' "$P")'"
'@

Invoke-DockerSh -Title '5. Rider/IDE log locations' -Script @'
find / \( -name "idea.log" -o -name "rider.log" -o -name "backend.log" \) 2>/dev/null | head -20
'@

Invoke-DockerSh -Title '6. Tail of any found idea/rider/backend logs' -Script @'
find / \( -name "idea.log" -o -name "rider.log" -o -name "backend.log" \) 2>/dev/null | head -5 | while IFS= read -r f; do
  echo "--- $f ---"
  tail -n 120 "$f"
done
'@

Invoke-DockerSh -Title '7. Running JetBrains-ish processes' -Script @'
ps -ef | grep -iE "java|rider|idea|remote-dev" | grep -v grep
'@

Invoke-DockerSh -Title '8. Listening ports' -Script @'
(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | head -40
'@

Invoke-DockerSh -Title '9. JetBrains config dirs (vscode + root)' -Script @'
echo "--- /home/vscode/.config/JetBrains ---"
ls -la /home/vscode/.config/JetBrains 2>/dev/null || echo "(not present)"
echo "--- /root/.config/JetBrains ---"
ls -la /root/.config/JetBrains 2>/dev/null || echo "(not present)"
'@

Invoke-DockerSh -Title '10. Effective env vars (proxy + JAVA_TOOL_OPTIONS)' -Script @'
env | grep -iE "proxy|JAVA_TOOL" | sort
'@

Write-Host "Done. Log written to: $LogFile" -ForegroundColor Green
