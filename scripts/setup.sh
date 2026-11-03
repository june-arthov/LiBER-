#!/usr/bin/env bash
# Liber full setup for Linux / WSL / macOS.
# One command: bash scripts/setup.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

say()  { printf '\033[36m[liber-setup]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[liber-setup] FAIL\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[liber-setup] OK\033[0m   %s\n' "$*"; }

say "Liber setup — $(node -p 'require("./package.json").version') in $ROOT"

# 1. Node runtime
command -v node >/dev/null 2>&1 || fail "Node.js is required (>= 18). Install it first: https://nodejs.org"
NODE_MAJOR="$(node -p 'parseInt(process.versions.node.split(".")[0], 10)')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node ${NODE_MAJOR} too old — need >= 18 (have $(node -v))"
ok "node $(node -v)"

# 2. Node dependencies
say "Installing node dependencies…"
npm install --no-audit --no-fund >/dev/null 2>&1 || fail "npm install failed — run it manually to see the error"
ok "npm install"

# 3. Global CLI link (best effort — needs sudo on most Linux/WSL for /usr/lib/node_modules)
say "Linking 'liber' and 'liberd' commands…"
if npm link >/dev/null 2>&1; then
  ok "npm link (global commands available)"
else
  say "npm link skipped (EACCES — needs sudo). Two options:"
  say "  1. sudo npm link   (recommended)"
  say "  2. run without linking:  node bin/liber"
fi

# 4. Python TUI (optional but recommended) — isolated venv so nothing else is touched
say "Setting up the Python TUI (textual + httpx) in .venv…"
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  say "No python3 found — the TUI is skipped (CLI and daemon work fine)."
  say "Install python3 to enable 'liber tui'."
else
  if [ ! -x "$ROOT/.venv/bin/python" ]; then
    "$PY" -m venv "$ROOT/.venv" >/dev/null 2>&1 || say "venv creation failed — trying user install instead"
  fi
  if [ -x "$ROOT/.venv/bin/python" ]; then
    "$ROOT/.venv/bin/pip" install --quiet --disable-pip-version-check textual httpx >/dev/null 2>&1 \
      || say "pip install into .venv failed — run: $ROOT/.venv/bin/pip install textual httpx"
    ok "TUI ready (.venv)"
  else
    "$PY" -m pip install --quiet --user textual httpx >/dev/null 2>&1 \
      || say "pip --user install failed — run: $PY -m pip install --user textual httpx"
    ok "TUI deps (user site-packages)"
  fi
fi

# 5. Environment template
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  ok ".env created from template (edit it to add provider keys)"
else
  ok ".env already present (not touched)"
fi

# 6. Verify
say "Verifying…"
if node bin/liber ps >/dev/null 2>&1; then
  ok "daemon reachable — fleet status works"
else
  say "Daemon not running yet — start it with:  node bin/liber spawn   (or liber spawn)"
fi

echo
say "Done. Quick start:"
say "  liber spawn        # start the daemon (or: node bin/liber spawn)"
say "  liber              # interactive CLI  (or: node bin/liber)"
say "  liber tui          # Python dashboard (or: node bin/liber tui)"
say "  npm test           # run the 167-test enforcement suite"
