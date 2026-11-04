# installer/stop-daemon.ps1 — ask a running daemon to shut down before uninstall.
param([string]$DataDir = (Join-Path $env:LOCALAPPDATA 'LiBER'))

$tokenFile = Join-Path $DataDir '.liber\daemon.token'
if (-not (Test-Path $tokenFile)) { exit 0 }
$token = (Get-Content $tokenFile -Raw).Trim()
if (-not $token) { exit 0 }
try {
  Invoke-WebRequest -Uri 'http://127.0.0.1:4567/shutdown' -Method Post `
    -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5 -UseBasicParsing | Out-Null
  Start-Sleep -Milliseconds 800
} catch { }
exit 0
