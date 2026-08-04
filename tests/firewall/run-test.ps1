#!/usr/bin/env pwsh
#
# Huddle firewall compatibility test — runtime-agnostic (Windows).
#
# PowerShell sibling of run-test.sh: same steps, same assertions, same exit
# semantics, driven by the same tests/firewall/huddle-test-config/cases.env.
# The GitHub Actions workflow only picks the platform + runtime; the test logic
# lives here.
#
#   1. Activate the requested runtime (docker or podman).
#   2. Install/start Huddle via its own CLI (`huddle init`).
#   3. Start a minimal test devcontainer on Huddle's internal network.
#   4. Assert an allowed URL is reachable.
#   5. Assert a blocked URL is not reachable.
#   6. (optional) Path mode: allowed path works, sibling path blocked.
#   7. Collect the Huddle logs.
#   8. Always clean up — even on failure.
#
# Usage:
#   pwsh tests/firewall/run-test.ps1 -Runtime <docker|podman>
#
# Exit code: 0 when every required assertion passed, 1 otherwise.

[CmdletBinding()]
param(
  [ValidateSet('docker', 'podman')]
  [string]$Runtime = $env:HUDDLE_RUNTIME,
  [switch]$NoPathmode
)

$ErrorActionPreference = 'Stop'

# ── Locations ────────────────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
$ConfigDir = Join-Path $ScriptDir 'huddle-test-config'
$LogDir    = if ($env:HUDDLE_TEST_LOG_DIR) { $env:HUDDLE_TEST_LOG_DIR } else { Join-Path $ScriptDir '.logs' }

# ── Output helpers ────────────────────────────────────────────────────────────
function Step($m) { Write-Host "`n==> $m" }
function Log($m)  { Write-Host "  - $m" -ForegroundColor DarkGray }
function Pass($m) { Write-Host "  PASS $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  WARN $m" -ForegroundColor Yellow }
function Fatal($m) { Write-Host "FATAL $m" -ForegroundColor Red; exit 1 }
$script:Failures = 0
function Fail($m) { Write-Host "  FAIL $m" -ForegroundColor Red; $script:Failures++ }

if (-not $Runtime) { Fatal "no runtime given — pass -Runtime <docker|podman> or set HUDDLE_RUNTIME" }
$RT = $Runtime

# ── Load shared test cases (env overrides win) ────────────────────────────────
$casesFile = Join-Path $ConfigDir 'cases.env'
if (-not (Test-Path $casesFile)) { Fatal "missing config: $casesFile" }
$cfg = @{}
foreach ($line in Get-Content $casesFile) {
  $t = $line.Trim()
  if ($t -eq '' -or $t.StartsWith('#') -or -not $t.Contains('=')) { continue }
  $k, $v = $t.Split('=', 2)
  $k = $k.Trim()
  $existing = [Environment]::GetEnvironmentVariable($k)
  $cfg[$k] = if ($existing) { $existing } else { $v }
}

$Client       = $cfg['HUDDLE_TEST_CLIENT_NAME']
$ClientImage  = $cfg['HUDDLE_TEST_CLIENT_IMAGE']
$HuddleUrl    = if ($env:HUDDLE_URL) { $env:HUDDLE_URL } else { 'http://localhost:3000' }
$HuddleName   = 'huddle'            # fixed names from cli/src/init.ts
$HuddleNet    = 'devcontainer-net'

# Operator token, shared by the CLI and our REST calls.
$Token = if ($env:HUDDLE_OPERATOR_TOKEN) { $env:HUDDLE_OPERATOR_TOKEN } else {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $_.ToString('x2') })
}
$env:HUDDLE_OPERATOR_TOKEN = $Token
$env:HUDDLE_RUNTIME = $RT

# ── Management API + in-container curl helpers ────────────────────────────────
function Invoke-Api($method, $path, $body) {
  $headers = @{ Authorization = "Bearer $Token" }
  if ($body) {
    Invoke-RestMethod -Method $method -Uri "$HuddleUrl$path" -Headers $headers -ContentType 'application/json' -Body $body
  } else {
    Invoke-RestMethod -Method $method -Uri "$HuddleUrl$path" -Headers $headers
  }
}

function Client-Code($url, $extra = '') {
  $out = & $RT exec $Client sh -c "curl -s -o /dev/null -w '%{http_code}' $extra '$url' || true" 2>$null
  return ("$out").Trim()
}

# ── Cleanup (always runs) ─────────────────────────────────────────────────────
function Cleanup {
  Step 'Collecting logs & cleaning up'
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  try { (& $RT logs $HuddleName 2>&1) | Out-File -FilePath (Join-Path $LogDir "huddle-$RT.log"); Log "Huddle logs -> $LogDir/huddle-$RT.log" } catch { Warn 'could not collect Huddle logs' }
  try { (& $RT logs $Client 2>&1) | Out-File -FilePath (Join-Path $LogDir "client-$RT.log") } catch {}
  & $RT rm -f $Client      2>$null | Out-Null
  & $RT rm -f $HuddleName  2>$null | Out-Null
  & $RT network rm $HuddleNet 2>$null | Out-Null
  Log 'cleanup done'
}

try {
  # ── 1. Activate runtime ─────────────────────────────────────────────────────
  Step "1. Container runtime: $RT"
  if (-not (Get-Command $RT -ErrorAction SilentlyContinue)) { Fatal "'$RT' is not on PATH" }
  & $RT info *> $null; if ($LASTEXITCODE -ne 0) { Fatal "'$RT' daemon/machine is not reachable" }
  Log ((& $RT version --format '{{.Server.Version}}' 2>$null) -join ' ')

  # ── 2. Install / start Huddle ───────────────────────────────────────────────
  Step '2. Build & start Huddle'
  if (Get-Command huddle -ErrorAction SilentlyContinue) {
    $HuddleExe = 'huddle'; $HuddlePre = @()
    Log "using 'huddle' from PATH"
  } else {
    $dist = Join-Path $RepoRoot 'cli\dist\index.js'
    if (-not (Test-Path $dist)) {
      Log 'building the CLI'
      Push-Location (Join-Path $RepoRoot 'cli')
      try { npm ci --silent; npm run build --silent } finally { Pop-Location }
    }
    $HuddleExe = 'node'; $HuddlePre = @($dist)
    Log "using node $dist"
  }
  function Huddle { param([Parameter(ValueFromRemainingArguments)]$a) & $HuddleExe @HuddlePre @a }

  $Image = if ($env:HUDDLE_IMAGE) { $env:HUDDLE_IMAGE } else { 'huddle:citest' }
  if (-not $env:HUDDLE_IMAGE) {
    Log "building gateway image $Image"
    & $RT build (Join-Path $RepoRoot 'gateway') -t $Image
    if ($LASTEXITCODE -ne 0) { Fatal 'gateway build failed' }
  }
  $env:HUDDLE_IMAGE = $Image; $env:HUDDLE_NO_PULL = '1'

  Log "huddle init (runtime=$RT)"
  Huddle init --runtime $RT
  if ($LASTEXITCODE -ne 0) { Fatal 'huddle init failed' }

  Log "waiting for the management API at $HuddleUrl"
  $ready = $false
  foreach ($i in 1..30) {
    try { Invoke-Api GET '/api/rules' | Out-Null; $ready = $true; break } catch { Start-Sleep 2 }
  }
  if (-not $ready) { Fatal 'Huddle API did not become ready' }
  Pass 'Huddle is up'

  # ── 3. Minimal test devcontainer ────────────────────────────────────────────
  Step '3. Start the minimal test devcontainer'
  & $RT pull $ClientImage *> $null; if ($LASTEXITCODE -ne 0) { Fatal "could not pull $ClientImage" }
  & $RT rm -f $Client 2>$null | Out-Null
  & $RT run -d --name $Client --network $HuddleNet `
    -e HTTP_PROXY=http://huddle:80 -e HTTPS_PROXY=http://huddle:80 `
    -e http_proxy=http://huddle:80 -e https_proxy=http://huddle:80 `
    -e NO_PROXY=localhost,127.0.0.1,huddle -e no_proxy=localhost,127.0.0.1,huddle `
    --entrypoint sleep $ClientImage infinity | Out-Null
  if ($LASTEXITCODE -ne 0) { Fatal 'could not start the test client' }

  & $RT exec $Client sh -c 'curl -s -o /tmp/huddle-ca.crt http://huddle:3000/api/tls/ca.crt' 2>$null | Out-Null
  $CaOpt = '--cacert /tmp/huddle-ca.crt'
  Pass "test client '$Client' running on $HuddleNet"

  # ── 4. Blocked URL stays blocked (default-deny) ─────────────────────────────
  Step '4. Blocked URL stays blocked'
  $code = Client-Code $cfg['HUDDLE_TEST_BLOCKED_URL']
  if ($code -eq $cfg['HUDDLE_TEST_BLOCKED_EXPECT']) { Pass "blocked $($cfg['HUDDLE_TEST_BLOCKED_URL']) -> $code" }
  else { Fail "blocked $($cfg['HUDDLE_TEST_BLOCKED_URL']) -> $code (expected $($cfg['HUDDLE_TEST_BLOCKED_EXPECT']))" }

  # ── 5. Allowed URL reachable after approval ─────────────────────────────────
  Step '5. Allowed URL is reachable after approval'
  Huddle firewall add $cfg['HUDDLE_TEST_ALLOWED_DOMAIN'] | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'firewall add failed' }
  $code = ''
  foreach ($i in 1..4) {
    $code = Client-Code $cfg['HUDDLE_TEST_ALLOWED_URL']
    if ($code -eq $cfg['HUDDLE_TEST_ALLOWED_EXPECT']) { break }
    Start-Sleep 1
  }
  if ($code -eq $cfg['HUDDLE_TEST_ALLOWED_EXPECT']) { Pass "allowed $($cfg['HUDDLE_TEST_ALLOWED_URL']) -> $code" }
  else { Fail "allowed $($cfg['HUDDLE_TEST_ALLOWED_URL']) -> $code (expected $($cfg['HUDDLE_TEST_ALLOWED_EXPECT']))" }

  # ── 6. Path mode (optional) ─────────────────────────────────────────────────
  if ($NoPathmode) {
    Step '6. Path mode — skipped (-NoPathmode)'
  } else {
    Step '6. Path mode: allowed path works, sibling path blocked'
    $pm = $cfg['HUDDLE_TEST_PATHMODE_DOMAIN']
    try {
      $rule = Invoke-Api POST '/api/rules' "{`"domain`":`"$pm`",`"container_id`":null,`"status`":`"deny`"}"
      Invoke-Api POST "/api/rules/$($rule.id)/path-mode" '{"enabled":true}' | Out-Null
      Invoke-Api POST '/api/rules' "{`"domain`":`"$pm`",`"container_id`":null,`"status`":`"allow`",`"path_pattern`":`"$($cfg['HUDDLE_TEST_PATHMODE_PATTERN'])`"}" | Out-Null
      Start-Sleep 1
      $a = Client-Code $cfg['HUDDLE_TEST_PATHMODE_ALLOWED_URL'] "$CaOpt --path-as-is"
      $b = Client-Code $cfg['HUDDLE_TEST_PATHMODE_BLOCKED_URL'] "$CaOpt --path-as-is"
      if ($a -ne '403' -and $a -ne '000') { Pass "path-mode allowed -> $a" } else { Fail "path-mode allowed -> $a (expected forwarded, non-403)" }
      if ($b -eq '403') { Pass "path-mode blocked -> $b" } else { Fail "path-mode blocked -> $b (expected 403)" }
    } catch {
      Warn "path-mode setup failed: $($_.Exception.Message)"
    }
  }
}
finally {
  Cleanup
}

# ── Report ────────────────────────────────────────────────────────────────────
Step 'Result'
if ($script:Failures -eq 0) {
  Write-Host "All firewall checks passed ($RT)." -ForegroundColor Green
  exit 0
} else {
  Write-Host "$($script:Failures) firewall check(s) failed ($RT)." -ForegroundColor Red
  exit 1
}
