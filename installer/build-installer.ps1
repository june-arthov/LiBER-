# installer/build-installer.ps1 — produce LiBER-Setup-<version>.exe (NSIS)
#
#   powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1
#   ... -SkipPayload   reuse the staged payload (fast rebuilds)
#   ... -SkipNode      leave the 90 MB Node runtime out of the installer
#   ... -RequestLevel user   per-user build that needs no UAC (for tests)
#
# Requires NSIS 3 (winget install NSIS.NSIS). The compiler is looked up on PATH,
# then in the usual install folders.
param(
  [switch]$SkipPayload,
  [switch]$SkipNode,
  [string]$Makensis = '',
  [ValidateSet('admin', 'user')]
  [string]$RequestLevel = 'admin'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
function Say($m) { Write-Host "[installer] $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "[installer] FAIL $m" -ForegroundColor Red; exit 1 }

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if (-not $version) { Fail 'could not read the version from package.json' }
Say "version $version (request level: $RequestLevel)"

if (-not $SkipPayload) {
  Say 'staging the payload'
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build.ps1'))
  if ($SkipNode) { $args += '-SkipNode' }
  & powershell @args
  if ($LASTEXITCODE -ne 0) { Fail 'payload build failed' }
}
$payload = Join-Path $PSScriptRoot 'payload'
if (-not (Test-Path (Join-Path $payload 'app\LiBER.exe'))) { Fail "payload missing at $payload" }

$candidates = @(@(
  $Makensis,
  (Get-Command makensis.exe -ErrorAction SilentlyContinue).Source,
  (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
  (Join-Path $env:ProgramFiles 'NSIS\makensis.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\NSIS\makensis.exe')
) | Where-Object { $_ -and (Test-Path $_) })
if ($candidates.Count -eq 0) { Fail 'NSIS not found. Install it:  winget install NSIS.NSIS' }
$makensis = $candidates[0]
Say "compiler $makensis"

$icon = Join-Path $root 'resources\icons\appIcon.ico'
if (-not (Test-Path $icon)) { $icon = Join-Path $root 'desktop\resources\icons\appIcon.ico' }
if (-not (Test-Path $icon)) { Fail 'appIcon.ico not found — run: node resources/icons/make-atom.js' }

Say 'compiling'
$defines = @(
  "/DVERSION=$version",
  "/DPAYLOAD=$payload",
  "/DICON=$icon",
  "/DREQUESTLEVEL=$RequestLevel"
)
Push-Location $PSScriptRoot
try {
  & $makensis @defines 'liber.nsi'
  $code = $LASTEXITCODE
} finally { Pop-Location }
if ($code -ne 0) { Fail "makensis exited $code" }

$out = Join-Path $PSScriptRoot ("dist\LiBER-Setup-{0}.exe" -f $version)
if (-not (Test-Path $out)) { Fail "expected $out" }
$size = (Get-Item $out).Length / 1MB
Say ("ready: {0}  ({1:N1} MB)" -f $out, $size)
