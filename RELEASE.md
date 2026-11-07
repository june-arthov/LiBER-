# Release checklist

Everything here is a command you can run and a result you can read. If a step has no
output, it did not happen.

## 1. Before you touch the version

```powershell
cd G:\Liber
npm test                      # expect: fail 0
rg -n "TODO|FIXME" src        # expect: nothing you cannot defend
node -e "require('./src/daemon/liberd')"   # expect: no throw on load
```

`npm test` covers 331 cases. Three of them skip when Docker is not running — the
container tests say so instead of passing empty.

## 2. Build the shell, not just the daemon

The desktop UI lives in `desktop/app/index.html` and is compiled into
`desktop/dist/liber-desktop/resources.neu`. A daemon-only build ships the old UI.

```powershell
cd G:\Liber\desktop
npx neu build                 # -> dist\liber-desktop\resources.neu
```

`installer/build.ps1` now runs this for you and **fails** when `resources.neu` is
older than `desktop/app`. That guard exists because a stale bundle shipped for four
releases while the code moved on.

## 3. Stage and compile the installer

```powershell
cd G:\Liber
powershell -ExecutionPolicy Bypass -File installer\build.ps1 -SkipNode
powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1 -SkipPayload -RequestLevel admin
# -> installer\dist\LiBER-Setup-<version>.exe
```

`-SkipNode` produces a 1.4 MB installer that uses the system `node`. Drop it to bundle
the interpreter (~99 MB) for machines without Node.

## 4. Install it the way a user does

The manifest is `requireAdministrator`, so a plain `cmd /c setup.exe /S` returns
"Access denied" without installing anything. Elevate explicitly:

```powershell
Start-Process -FilePath 'installer\dist\LiBER-Setup-<ver>.exe' -ArgumentList '/S' -Verb RunAs -Wait
(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LiBER').DisplayVersion
```

## 5. Prove the running product, not the source

```powershell
& "C:\Program Files\LiBER\launch.ps1" -InstallDir "C:\Program Files\LiBER" -Quiet
$T = Get-Content "$env:LOCALAPPDATA\LiBER\.liber\daemon.token"
curl.exe -s http://127.0.0.1:4567/healthz                       # {"ok":true}
curl.exe -s -H "Authorization: Bearer $T" http://127.0.0.1:4567/media
curl.exe -s -H "Authorization: Bearer $T" http://127.0.0.1:4567/sandbox
```

Then look at the window: the badge must show the installed version (it reads
`/whoami`), the sidebar must list the daemon's sessions, and the footer must show the
real sandbox (`container` or `no container`).

## 6. Publish

```powershell
git add -A
git commit -m "…"
git tag v<version>
git push origin main
git push origin v<version>
npm publish --access public
gh run list --limit 2          # both the main and tag runs must be success
npm view @arthovlabs/liber version
```

Tags are lightweight here; `git push --follow-tags` does **not** carry them.

## What is deliberately not done yet

Honest list, so nobody assumes otherwise:

- **No UI automation test.** The shell is verified by launching it and reading the
  window; the daemon has HTTP integration tests (`test/http-daemon.test.js`).
- **No auto-update.** Installing a new version is a manual setup run.
- **Docker is optional.** Without a running daemon the terminal falls back to
  Constrained Language Mode; the UI says `no container` instead of pretending.
- **One agent per install.** Multiple agents in one daemon are not supported by the
  config format yet.
- **Media needs a provider key.** No local model, no GPU pipeline; `GET /media` reports
  exactly which capability is missing.
- **Session list is per-window.** Titles live in `localStorage`; messages live in the
  daemon. A fresh window re-syncs the list from `/sessions`, so history is never lost,
  but custom titles are.
