# DSH layout for the LiBER desktop shell

The desktop shell (`desktop/app/index.html`, Neutralino/WebView2) was re-skinned to mirror the
DeepSeek Harness Web GUI: a three-column frame on the DSH dark palette, a 40 px caption, a
280 px sidebar, the centered conversation column, and the edge-anchored right panel.

Reference screenshots: [hero](../docs/dsh-layout/hero.png) ·
[transcript with right panel](../docs/dsh-layout/transcript.png) ·
[settings drawer](../docs/dsh-layout/settings.png)

## Frame

| Part | Value |
|---|---|
| Caption | 40 px, sidebar fill `#1b1b1c`, menus left, status pills and panel toggles right |
| Sidebar | 280 px (`--dsh-sidebar-w`), collapses to 0; brand row 44 px, New session 38 px / radius 12 / `#43454a` |
| Content column | `clamp(680px, 64%, 920px)` chat column; composer card is that width + 32 px (16 px each side) |
| Composer | 28 px radius, `#2c2c2e`, 34 px `#7aaaff` send pill, chips / prompt / toolbar / meta rows |
| Right panel | hidden by default, `clamp(300px, 45vw, 100vw - 280px - 400px)` so the center keeps ≥ 400 px |
| Corners | 16 px top-left on the content column only; everything else square against the shell |
| User bubble | 20 px radius, `#2c2c2e`, `10px 16px` padding, right aligned |
| Rows | sidebar workspace 34 px, session 32 px, nav 36 px — all radius 12 |
| Typography | system sans 14/22–24, secondary 13, meta 11, code 11 mono |

## Palette (DSH dark)

`#151517` background · `#1b1b1c` sidebar/caption · `#232324` layer 1 · `#2c2c2e` layer 2
(bubble/composer) · `#353638` layer 3 · `#f9fafb` text · `#adb2b8` muted · `#81858c` dim ·
`#7aaaff` business accent · `#22c55e` success · `#f25a5a` error · hairlines `#ffffff0f`
(`--border`) and `#ffffff1f` (`--border-strong`), hover `#ffffff14`.

## Behaviour kept from the existing shell

All original ids/JS are retained: menus, status pills, New session, workspace/session list,
skills + automations, settings drawer (18 categories), model/permission pickers, context chips,
review badges, overview panels, toasts, shortcuts. New wiring: the right panel starts hidden,
`#ov-close` and `Escape` close it, `Ctrl+Alt+O` toggles it, the caption shows a New session button
when the sidebar is collapsed, and markdown answers render headings, lists, quotes, links and
fenced code with the language tag stripped.

`MERLIN-PARITY.md` describes the previous Merlin-derived look; the layout numbers there are
superseded for the desktop shell by this document.

## Composer footer controls (added after the skin)

Both footer chips are real buttons now, not labels:

- **Local Checkout** — shows the working folder, opens it in Explorer, copies the path, lists
  recent workspaces and offers *Choose folder…* (native folder dialog). Picking a folder calls
  `POST /workspace/switch`: the daemon re-execs itself with the new cwd, keeping the same
  `liber.yaml` (absolute path via `LIBER_CONFIG`) and copying `.liber/credentials.json` into the
  new folder when it has none, so the providers keep working. The window then re-reads the token
  file the new instance writes and reloads every panel. Workspace-local state (sessions, journal,
  budget) starts fresh there by design.
- **Branch** — `GET /git` returns the real branch, local branches, the origin URL and the
  ahead/behind counts; clicking a branch calls `POST /git/checkout` (branch names are validated
  against `--flags` and shell metacharacters), and *Fetch origin* calls `POST /git/fetch`.
  *Open on GitHub* appears when origin points at github.com.

`nativeAllowList` in `neutralino.config.json` had to gain `os.showFolderDialog` and `os.open`;
without them Neutralino blocks both calls.
