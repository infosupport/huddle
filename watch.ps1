$FlagFile  = "$PSScriptRoot\run.flag"
$ErrorFile = "$PSScriptRoot\error.txt"
$TestScript = "$PSScriptRoot\test.ps1"

Write-Host "Watching for run.flag ..." -ForegroundColor Cyan
Write-Host "Maak run.flag aan om een testrun te starten." -ForegroundColor Gray

while ($true) {
    if (Test-Path $FlagFile) {
        Remove-Item $FlagFile -Force
        $ts = Get-Date -Format 'HH:mm:ss'
        Write-Host "[$ts] run.flag gevonden - test.ps1 uitvoeren (max 90s)..." -ForegroundColor Yellow

        # Start in een job zodat we een timeout kunnen afdwingen
        $job = Start-Job -ScriptBlock {
            param($script)
            & powershell -ExecutionPolicy Bypass -File $script 2>&1 | Out-String
        } -ArgumentList $TestScript

        $finished = Wait-Job $job -Timeout 90
        if (-not $finished) {
            $ts = Get-Date -Format 'HH:mm:ss'
            Write-Host "[$ts] Timeout! Job stoppen..." -ForegroundColor Red
            Stop-Job $job -ErrorAction SilentlyContinue
            $result = (Receive-Job $job -Keep -ErrorAction SilentlyContinue | Out-String) + "`n--- TIMEOUT na 90s ---`n"
        } else {
            $result = Receive-Job $job | Out-String
        }
        Remove-Job $job -Force -ErrorAction SilentlyContinue

        $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        [System.IO.File]::WriteAllText($ErrorFile, "[$timestamp]`n$result", [System.Text.Encoding]::UTF8)

        $ts = Get-Date -Format 'HH:mm:ss'
        Write-Host "[$ts] Klaar. Resultaat in error.txt" -ForegroundColor Green
    }
    Start-Sleep -Milliseconds 500
}
