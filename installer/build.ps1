# installer/build.ps1 — stage everything the Windows installer needs.
#
#   powershell -ExecutionPolicy Bypass -File installer/build.ps1
#   powershell -ExecutionPolicy Bypass -File installer/build.ps1 -SkipNode
#
# Output: installer/payload/  (gitignored)
#   app\        the runtime: CLI, daemon, sources, production node_modules
#   app\LiBER.exe, app\resources.neu   the desktop shell
#   runtime\node.exe                   bundled interpreter (skip with -SkipNode)
param(
  [switch]$SkipNode,
  [string]$Out = "$PSScriptRoot\payload"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
function Say($m) { Write-Host "[build] $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "[build] FAIL $m" -ForegroundColor Red; exit 1 }

# 1. the desktop shell must exist before we can install it
$shellDir = Join-Path $root 'desktop\dist\liber-desktop'
$exe = Join-Path $shellDir 'LiBER.exe'
$res = Join-Path $shellDir 'resources.neu'
if (-not (Test-Path $exe)) { Fail "LiBER.exe not built. Run: cd desktop; npx neu build" }
if (-not (Test-Path $res)) { Fail "resources.neu missing from $shellDir" }

# 2. clean the staging area
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
$app = Join-Path $Out 'app'
New-Item -ItemType Directory -Path $app -Force | Out-Null

Say 'copying runtime sources'
foreach ($d in @('src', 'bin', 'skills')) {
  $src = Join-Path $root $d
  if (-not (Test-Path $src)) { Fail "$d/ is missing" }
  Copy-Item $src -Destination $app -Recurse -Force
}
foreach ($f in @('package.json', 'package-lock.json', 'liber.yaml', '.env.example', 'README.md', 'LICENSE')) {
  $p = Join-Path $root $f
  if (Test-Path $p) { Copy-Item $p -Destination $app -Force }
}

Say 'copying the desktop shell'
Copy-Item $exe $app -Force
Copy-Item $res $app -Force

Say 'installing production dependencies into the payload'
Push-Location $app
try {
  # --omit=dev keeps the payload small; the three runtime deps are all the CLI needs
  & npm install --omit=dev --no-audit --no-fund --ignore-scripts 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'npm install inside the payload failed' }
} finally { Pop-Location }

# 3. the interpreter
if (-not $SkipNode) {
  $runtime = Join-Path $Out 'runtime'
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Fail 'node not found on PATH — install Node.js or pass -SkipNode' }
  Say "bundling $node"
  Copy-Item $node (Join-Path $runtime 'node.exe') -Force
} else {
  Say 'skipping the bundled interpreter (-SkipNode): the installer will use the system node'
}

# 4. the launcher and uninstaller travel with the payload
Copy-Item (Join-Path $PSScriptRoot 'launch.ps1') $Out -Force
Copy-Item (Join-Path $PSScriptRoot 'uninstall.ps1') $Out -Force

# 5. report
$bytes = (Get-ChildItem $Out -Recurse -File | Measure-Object -Property Length -Sum).Sum
Say ("payload ready: {0} files, {1:N1} MB -> {2}" -f (Get-ChildItem $Out -Recurse -File).Count, ($bytes / 1MB), $Out)
if (Test-Path (Join-Path $Out 'runtime\node.exe')) {
  Say ("  bundled node: {0:N1} MB" -f ((Get-Item (Join-Path $Out 'runtime\node.exe')).Length / 1MB))
}
