# installer/launch.ps1 — start the daemon (if needed), then open the window.
#
# Runs from the install directory; the workspace/data directory is the cwd the
# shortcut sets, so .liber/ (sessions, token, audit logs) stays user-writable
# even when the program lives in Program Files.
param(
  [string]$InstallDir = (Split-Path -Parent $PSScriptRoot),
  [string]$DataDir = ""
)

$ErrorActionPreference = 'Continue'
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'LiBER' }
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
Set-Location $DataDir

$app = Join-Path $InstallDir 'app'
$exe = Join-Path $app 'LiBER.exe'
$daemon = Join-Path $app 'bin\liberd-entry'

if (-not (Test-Path $exe)) {
  [System.Windows.Forms.MessageBox]::Show("LiBER is not installed correctly: $exe is missing.", 'LiBER') | Out-Null
  exit 1
}

# pick an interpreter: the bundled one first, then the system node
$node = Join-Path $InstallDir 'runtime\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "Node.js is required and was not found.`n`nInstall it from https://nodejs.org and run LiBER again.",
    'LiBER') | Out-Null
  exit 1
}

function Test-Daemon {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4567/healthz' -TimeoutSec 2 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

# The daemon reads liber.yaml and .env from its working directory, and that
# directory is the data dir (a program dir under Program Files is not writable).
# Seed both on first run so the first launch is not a cryptic ENOENT.
$cfg = Join-Path $DataDir 'liber.yaml'
if (-not (Test-Path $cfg)) {
  $src = Join-Path $app 'liber.yaml'
  if (Test-Path $src) { Copy-Item $src $cfg }
}
$envFile = Join-Path $DataDir '.env'
if (-not (Test-Path $envFile)) {
  $src = Join-Path $app '.env.example'
  if (Test-Path $src) { Copy-Item $src $envFile }
}

if (-not (Test-Daemon)) {
  $env:LIBER_PORT = '4567'
  # A detached process with no console crashes on the first stdout write (EPIPE),
  # so give it real log files — which are also what you want when something breaks.
  # Paths here contain spaces ("C:\Program Files\..."), and Start-Process does
  # not quote arguments for you: without the quotes node receives "C:\Program".
  Start-Process -FilePath $node -ArgumentList "`"$daemon`"" -WorkingDirectory $DataDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $DataDir 'liberd.out.log') `
    -RedirectStandardError (Join-Path $DataDir 'liberd.err.log') | Out-Null
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline -and -not (Test-Daemon)) { Start-Sleep -Milliseconds 400 }
}

if (-not (Test-Daemon)) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "The LiBER daemon did not start.`n`nRun this from a terminal to see why:`n  `"$node`" `"$daemon`"",
    'LiBER') | Out-Null
  exit 1
}

# Detach the window: `Start-Process $exe` leaves the child holding our stdout,
# so a caller that pipes this script (or a shortcut host) waits forever.
Start-Process -FilePath $env:ComSpec -ArgumentList '/c', 'start', '""', "`"$exe`"", '/D', "`"$DataDir`"" -WindowStyle Hidden
