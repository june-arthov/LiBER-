# installer/launch.ps1 — start the daemon (if needed), then open the window.
#
# Runs from the install directory; the workspace/data directory is the cwd the
# shortcut sets, so .liber/ (sessions, token, audit logs) stays user-writable
# even when the program lives in Program Files.
#
# Every step is appended to <data>\launch.log: a shortcut gives you no console,
# so when something goes wrong the log is the only honest witness.
param(
  [string]$InstallDir = (Split-Path -Parent $PSScriptRoot),
  [string]$DataDir = "",
  [int]$WaitSeconds = 45,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'LiBER' }
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }

$LogFile = Join-Path $DataDir 'launch.log'
function Log($m) {
  $line = '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  if (-not $Quiet) { Write-Host $line }
}
function Fail($message, $detail = '') {
  Log "FAILED: $message"
  if ($detail) { Log "  $detail" }
  # -Quiet is also the headless mode: no dialog, a distinct exit code, so a
  # script (or a test) can tell success from failure without a human clicking OK.
  if ($Quiet) { exit 2 }
  $body = "$message`n`n$detail`n`nLog: $LogFile"
  [System.Windows.Forms.MessageBox]::Show($body, 'LiBER', 'OK', 'Warning') | Out-Null
  exit 1
}

Set-Location $DataDir
Log '--- launch ---'
Log "install: $InstallDir"
Log "data:    $DataDir"

$app = Join-Path $InstallDir 'app'
$exe = Join-Path $app 'LiBER.exe'
$daemon = Join-Path $app 'bin\liberd-entry'

if (-not (Test-Path $exe)) { Fail "LiBER is not installed correctly: $exe is missing." }
if (-not (Test-Path $daemon)) { Fail "The daemon entry point is missing: $daemon" }

# interpreter: bundled first, then the system node
$node = Join-Path $InstallDir 'runtime\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) {
  Fail 'Node.js is required and was not found.' 'Install it from https://nodejs.org, or rebuild the installer with the bundled runtime.'
}
Log "node:    $node"

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4567/healthz' -TimeoutSec 2 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Test-Ours {
  # A daemon started from another folder answers /healthz and still rejects our
  # token; opening the window against it would show 401 on every request.
  $tokenFile = Join-Path $DataDir '.liber\daemon.token'
  if (-not (Test-Path $tokenFile)) { return $false }
  $t = (Get-Content $tokenFile -Raw).Trim()
  if (-not $t) { return $false }
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4567/ps' -Headers @{ Authorization = "Bearer $t" } -TimeoutSec 3 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

# The daemon reads liber.yaml and .env from its working directory, and that
# directory is the data dir (a program dir under Program Files is not writable).
foreach ($pair in @(@('liber.yaml', 'liber.yaml'), @('.env', '.env.example'))) {
  $target = Join-Path $DataDir $pair[0]
  if (-not (Test-Path $target)) {
    $src = Join-Path $app $pair[1]
    if (Test-Path $src) { Copy-Item $src $target; Log "seeded $($pair[0])" }
  }
}

if (Test-Health) {
  if (Test-Ours) {
    Log 'daemon already running and answers with our token'
  } else {
    Log 'port 4567 is held by a daemon that does not accept our token'
    Fail "Another LiBER daemon is already using port 4567, started from a different folder, so it does not share this installation's token." `
      "Stop it with ``liber stop`` in that folder, then open LiBER again."
  }
} else {
  Log 'starting the daemon'
  $env:LIBER_PORT = '4567'
  # A detached process with no console crashes on the first stdout write (EPIPE),
  # so give it real log files — which are also what you want when something breaks.
  # Paths here contain spaces ("C:\Program Files\..."), and Start-Process does
  # not quote arguments for you: without the quotes node receives "C:\Program".
  Start-Process -FilePath $node -ArgumentList "`"$daemon`"" -WorkingDirectory $DataDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $DataDir 'liberd.out.log') `
    -RedirectStandardError (Join-Path $DataDir 'liberd.err.log') | Out-Null

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $up = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    if (Test-Health) { $up = $true; break }
  }

  if (-not $up) {
    $errTail = ''
    $errLog = Join-Path $DataDir 'liberd.err.log'
    if (Test-Path $errLog) {
      # the workspace scanner logs "could not open directory" warnings; they are
      # noise next to a real failure
      $errTail = (Get-Content $errLog -Tail 40 | Where-Object { $_ -notmatch 'could not open directory' } | Select-Object -Last 6) -join "`n"
    }
    $outTail = ''
    $outLog = Join-Path $DataDir 'liberd.out.log'
    if (Test-Path $outLog) { $outTail = (Get-Content $outLog -Tail 6) -join "`n" }
    Fail "The LiBER daemon did not start within $WaitSeconds seconds." (($errTail + "`n" + $outTail).Trim())
  }
  Log 'daemon is up'
}

# Detach the window: `Start-Process $exe` leaves the child holding our stdout,
# so a caller that pipes this script (or a shortcut host) waits forever.
Log 'opening the window'
Start-Process -FilePath $env:ComSpec -ArgumentList '/c', 'start', '""', "`"$exe`"", '/D', "`"$DataDir`"" -WindowStyle Hidden
Log 'launched'
