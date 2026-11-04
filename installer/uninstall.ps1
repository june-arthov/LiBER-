# installer/uninstall.ps1 — remove an installed LiBER.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-InstallDir ...] [-KeepData]
#
# Removes: shortcuts, the uninstall registry entry, the program directory.
# Keeps:   the data directory (sessions, memory, vault) unless -PurgeData is given.
param(
  [string]$InstallDir = (Split-Path -Parent $PSScriptRoot),
  [switch]$PurgeData,
  [string]$DataDir = ""
)

$ErrorActionPreference = 'Continue'
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'LiBER' }
$removed = @()

# 1. stop the daemon if it is ours
try {
  $tokenFile = Join-Path $DataDir '.liber\daemon.token'
  if (Test-Path $tokenFile) {
    $token = (Get-Content $tokenFile -Raw).Trim()
    Invoke-WebRequest -Uri 'http://127.0.0.1:4567/shutdown' -Method Post -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5 -UseBasicParsing | Out-Null
    $removed += 'daemon stopped'
  }
} catch { }

# 2. shortcuts
$shell = New-Object -ComObject WScript.Shell
$links = @(
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\LiBER.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'LiBER.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'LiBER.lnk')
)
foreach ($l in $links) { if (Test-Path $l) { Remove-Item $l -Force; $removed += "shortcut $l" } }

# 3. registry (both hives; only the one we wrote will exist)
foreach ($root in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER',
                    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER')) {
  if (Test-Path $root) { Remove-Item $root -Recurse -Force; $removed += "registry $root" }
}

# 4. program files
if (Test-Path $InstallDir) {
  Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) { $removed += "COULD NOT REMOVE $InstallDir (in use?)" } else { $removed += "files $InstallDir" }
}

# 5. data, only when asked
if ($PurgeData -and (Test-Path $DataDir)) {
  Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
  $removed += "data $DataDir"
}

$removed | ForEach-Object { Write-Host "  removed: $_" }
Write-Host ''
if (-not $PurgeData) { Write-Host "Your data is still in $DataDir (pass -PurgeData to delete it)." }
Write-Host 'LiBER uninstalled.' -ForegroundColor Green
