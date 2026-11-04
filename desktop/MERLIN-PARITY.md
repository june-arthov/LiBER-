# Merlin → LiBER parity audit

> **Superseded for the desktop shell (2026-11):** the shell now mirrors the DeepSeek Harness Web
> GUI instead of Merlin. See [`DSH-LAYOUT.md`](DSH-LAYOUT.md) for the current frame, palette and
> measurements. This audit remains the record of the earlier Merlin-derived design and of the
> feature parity items that still carry over.

What the reference desktop shell does, what LiBER does, and what is still missing.
Status legend: **done** = implemented and exercised in this build · **partial** = present but narrower than the reference · **missing** = not implemented.

Measurements were taken from the reference bundle (`app.asar` → `dist/assets/*.css`) and its
running window (DOM via CDP), not estimated by eye.

## Design tokens (measured, then applied)

| Token | Reference value | LiBER |
|---|---|---|
| `--font-sans` | `"Segoe WPC","Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji"` | identical stack — **done** |
| `--font-mono` | `"JetBrains Mono","Cascadia Code","Cascadia Mono","DejaVu Sans Mono","Liberation Mono","Noto Sans Mono","Noto Mono","SF Mono",ui-monospace` | identical stack — **done** |
| `--font-kbd` | `-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui` | identical stack — **done** |
| base size / line height | `1rem` / `1.5` | `14px` / `1.5` (reference body is 14 px inside a 16 px root) — **done** |
| title bar height | 35 px | 35 px — **done** |
| sidebar / overview width | 256 px / 318 px | 256 px / 318 px — **done** |
| composer width / radius | 768 px / 16 px | 768 px / 16 px — **done** |
| motion scale | short fades, springy popovers | `120/180/280 ms` on `cubic-bezier(.2,0,0,1)`, spring `(.34,1.56,.64,1)` — **done** |

## Motion and interaction (all live in this build)

- Message entrance: turns fade up 8 px, answers 3 px, user rows 4 px.
- Popovers: spring scale `0.97 → 1`, origin set from the side the panel opens on.
- Buttons: hover tint + 1 px lift, `:active` press to `scale(.984)`, focus-visible accent ring.
- Send button: lift on hover, press on click, pulsing halo while a turn runs.
- Sidebar rows slide 2 px on hover; the active conversation gets an accent spine that scales in.
- Settings nav rows slide and highlight; the active tab grows an accent underline.
- Streaming caret blinks on the draft answer until the final payload replaces it.
- Code blocks reveal a copy button on hover; answers reveal copy / retry / vote actions on hover.
- Toasts spring in; skeletons shimmer while the provider list is being fetched.
- `prefers-reduced-motion: reduce` disables every animation and transition.

## Layout and shell

| Element | Reference | LiBER |
|---|---|---|
| Title bar: menus, status pills, panel toggles, window controls | yes | yes — **done** |
| Left sidebar: new conversation, library rows, projects tree, settings | yes | yes — **done** |
| Center: breadcrumb, turn cards, worked-for label, composer, checkout footer | yes | yes — **done** |
| Right rail: review / files / terminal / artifacts / skills | review, files, artifacts, background commands, extensions | review, files, terminal, artifacts, skills — **partial** (no extensions, no background-command list) |
| Settings drawer: 18 categories with subpages, search, breadcrumb, export/reset | yes | 18 categories, search, breadcrumb, export/reset — **done** |
| Providers page: API keys, accounts/OAuth, custom endpoints, local runtimes | yes | 4 tabs, credential store `0600`, device flow, CLI token import — **done** |
| Model picker reading the live provider list | yes | `/models`, cached per model+endpoint, filter + refresh — **done** |
| Keyboard shortcuts page | ~40 bindings, rebindable | 14 bindings documented, not rebindable — **partial** |

## Not implemented (honest list)

- **Automations / scheduler** — sidebar entry exists, no job engine behind it.
- **Voice** — the microphone button is inert (no capture, no TTS).
- **Browser subagent** — no driven browser, no page-context capture.
- **Plugins / sidecar iframes** — settings row exists, no loader.
- **Pet / HUD / translucency modes** — appearance page covers theme + accent + density only.
- **Quota and billing meters** — Billing page is informational.
- **Multi-tab document strip** — single view per window.
- **Session search across history** — sessions list + delete + export exist, no full-text search.
- **Credential vault for form filling** — providers store keys; there is no browser autofill vault.
- **Rebindable shortcuts** — bindings are hardcoded in the shell.
- **Fallback chain, auxiliary models per task, MoA** — settings pages describe them, the engine runs one model per turn.

## Verification used for this audit

- `npm test` → 199/199.
- Reference CSS token extraction from `dist/assets/index-*.css` (407 KB total).
- Reference window measured through CDP (`DevToolsActivePort`); LiBER measured and clicked through UI Automation.
- Live checks: popover lists 25 provider models, selecting one persists to `/config` and `liber.yaml`, settings drawer opens on any category, shortcut page renders both tables.
