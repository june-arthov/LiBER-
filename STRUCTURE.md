# LiBER — structure map

Reference for building a new shell/layout without breaking the engine. Everything
here is measured from this checkout (`main`, 0.5.7), not from memory.

```
                 ┌──────────────────────────────────────────────┐
   shell         │ desktop/app/index.html      (SPA, 3,975 lines)│
   (replaceable) │ Neutralino + WebView2 · 1400×900 · 980×640 min │
                 └───────────────┬──────────────────────────────┘
                                 │  HTTP + SSE, Bearer token
                 ┌───────────────▼──────────────────────────────┐
   daemon        │ src/daemon/liberd.js       (1,346 lines)      │
   (fixed)       │ auth → scope → rate limit → route → queue    │
                 └───────────────┬──────────────────────────────┘
                                 │
                 ┌───────────────▼──────────────────────────────┐
   engine        │ core/engine.js             (1,029 lines)      │
   (fixed)       │ turn loop · grounding gate · HITL · budget   │
                 └───┬──────────┬──────────┬──────────┬─────────┘
                     │          │          │          │
              ┌──────▼───┐ ┌────▼─────┐ ┌──▼──────┐ ┌─▼────────┐
              │ registry │ │ evidence │ │grounding│ │  memory  │
              │ 12 tools │ │ receipts │ │ verifier│ │ sessions │
              └──────┬───┘ └──────────┘ └─────────┘ └──────────┘
                     │
     ┌───────────────┼──────────────┬─────────────┬────────────┐
  file-tools     terminal-tool   web-tool     task-tool     browser
  read/write/    docker | CLM    fetch/search subagents      chromium
  patch/search   + policy gate
                     │
              ┌──────▼────────┐   ┌──────────────┐   ┌─────────────┐
              │ llm/manager   │   │ core/vault   │   │ core/providers│
              │ 4 adapters    │   │ AES-256-GCM  │   │ catalog+keys  │
              └───────────────┘   └──────────────┘   └───────────────┘
```

## One turn, end to end

1. Shell `POST /chat/stream` (SSE) with `{agentId, sessionId?, message}`.
2. `liberd.js` — `auth.verify` (token → client), `auth.scopeFor` (needs `chat`),
   `auth.rateLimit` (token bucket), then `queue.run(agentId, …)` so two turns for
   one agent never interleave (`core/lock.js`).
3. `core/engine.js` `runTurn` — loads memory window, injects the memory block,
   calls the provider, streams drafts.
4. Each tool call → `tool_dispatch` event → `registry.execute`. Terminal calls go
   through `policy` (denylist > approval > mode) and the sandbox backend.
5. Every tool result becomes a receipt in `core/evidence.js`; the model must cite
   `[E1]`, `[E2]`.
6. `core/grounding.js` audits the draft: uncited claims are repaired or labelled
   `UNVERIFIED`; `core/verifier.js` runs a second pass on numbers/entities.
7. Response + receipts are written to `core/journal.js` (resume) and
   `core/trace.js` (append-only audit), then `final` is emitted.

Events a shell must render (30 total): `start`, `draft_start/draft/draft_end`,
`reasoning_start/reasoning/reasoning_end`, `thought`, `tool_dispatch`,
`observation`, `todo`, `hitl_intercept`, `hitl_approved`, `grounding_audit`,
`grounding_pass`, `grounding_warning`, `injection_warning`, `loop_guard`,
`memory`, `subagent_start/subagent_end`, `fallback`, `telemetry`,
`budget_blocked`, `stopped`, `finalizing`, `converging`, `native_tools_unavailable`,
`done`.

## Layers

| Area | Files | Lines | Role |
|---|---|---|---|
| Shell | `desktop/app/index.html` | 3,975 | the only UI: sidebar, chat, right overview, settings drawer |
| Shell host | `desktop/neutralino.config.json` | 46 | appId `com.liber.desktop`, window, native allowlist |
| Daemon | `src/daemon/liberd.js` | 1,346 | HTTP/SSE, auth, 51 routes, timers |
| Engine | `src/daemon/core/engine.js` | 1,029 | turn loop, gate wiring, subagents |
| Grounding | `grounding.js` 420 · `evidence.js` 306 · `verifier.js` 4.3 KB · `injection.js` | ~800 | audit, receipts, second pass |
| Tools | `core/tools/*` + `registry.js` (356) | ~2,200 | 12 tools + `task`/`tasks` + `image_generate`, `video_generate` |
| Providers | `core/providers.js` 540 · `llm/manager.js` + 4 adapters | ~900 | catalog, keys, adapters |
| State | `memory.js`, `journal.js`, `trace.js`, `session`, `budget.js` | ~600 | context, resume, audit, spend |
| Safety | `policy.js`, `terminal-tool.js` (488), `auth.js` (~240), `vault.js`, `stops.js` | ~1,200 | scope, sandbox, tokens, secrets, kill switch |
| Sharing | `shares.js` | ~180 | read-only capability links, server-side sanitizing |
| Extras | `automations.js`, `connectors.js`, `voice.js`, `skills.js`, `workspace.js` | ~900 | scheduling, HTTP tools, TTS, skills |
| CLI | `bin/liber` (722), `src/cli/ui.js` (520), `bin/liber-tui.py` (825) | ~2,000 | terminal surfaces, separate from the desktop shell |
| Installer | `installer/*` (`build.ps1`, `launch.ps1`, `liber.nsi`, `LiBER-Setup.ps1`) | ~700 | payload → NSIS setup → Program Files |

## UI contract (what a new layout must implement)

The engine does not care how the shell looks. It cares about these 51 routes;
a layout only has to call them. Groups:

- **Turn**: `POST /chat`, `POST /chat/stream` (SSE), `POST /stop`, `POST /hitl/verdict`,
  `POST /resume`, `POST /resume/stream`
- **Session**: `GET /sessions`, `GET /sessions/history?key=`, `GET/POST/DELETE /sessions/share`,
  `GET /shared/<id>` (no token: the id is the credential), `GET /sessions/search?q=`,
  `DELETE /sessions?key=`, `POST /session/clear`, `POST /compact`
- **Config**: `GET/POST /config`, `GET /config/export`, `POST /config/reset`,
  `POST /config/backup`
- **Models**: `GET /models`, `POST /model/switch`, `GET /providers`,
  `POST /providers/{key,clear,custom,import,test}`, `POST /providers/oauth/{start,poll}`
- **Safety**: `GET /sandbox`, `GET/POST/DELETE /vault`, `POST /vault/migrate`,
  `GET /clients`, `POST /clients`, `POST /clients/rotate`, `DELETE /clients?id=`,
  `GET /clients/audit?tail=`
- **Work**: `GET /ps`, `GET /turns`, `DELETE /turns?agentId=`, `GET /workspace`,
  `POST /workspace/switch`, `POST /git`, `POST /git/fetch`, `POST /git/checkout`,
  `POST /revert`
- **Media**: `GET /media` (what this machine can actually do: provider, ffmpeg), tools
  `image_generate` / `video_generate` writing to `artifacts/media/`
- **Extras**: `/automations*`, `/connectors*`, `/voice`, `/voice/speak`,
  `/skills`, `/memory`, `/budget`, `/budget/limit`
- **Meta**: `GET /healthz`, `GET /whoami`, `POST /shutdown`

Shape of a streaming turn (what the shell renders):

```
POST /chat/stream  {agentId, sessionId, message}
  ← start → reasoning/draft tokens → tool_dispatch → observation …
  ← hitl_intercept  → shell asks the human → POST /hitl/verdict {verdict}
  ← grounding_audit → grounding_pass | grounding_warning
  ← final {response, receipts[], grounded, repairs} → done
```

Auth: `Authorization: Bearer <token>`. The shell bootstraps the token by asking
`GET /whoami` (unauthenticated) for `token_path`, then reading that file through
`Neutralino.filesystem.readFile`; `LIBER_TOKEN` in the environment wins if set.
Token file: `%LOCALAPPDATA%\LiBER\.liber\daemon.token`.
Scopes: `read` < `chat` < `tools` < `admin`; `admin` is not a wildcard.

## Visual tokens the current shell defines (`:root`)

```
--gold #E5B25C   --bg #0d0e10   --panel #141519  --panel2 #1a1c21  --panel3 #202329
--border #232630 --text #dfe3ea --muted #8b93a3 --dim #5a6172
--accent #39c5f0 --green #2fd07a --amber #f2b544 --red #f0616d --violet #a78bfa
--mono Cascadia Mono/JetBrains Mono · --sans Segoe UI Variable
--sidebar 256px · --overview 318px
accents: #39c5f0 #2fd07a #f2b544 #a78bfa #f0616d
```

Settings drawer categories (`NAV`): general, model, permissions, grounding,
appearance, memory, skills, sessions, shortcuts, about.

## Where to attach a new layout

1. **Replace or fork `desktop/app/index.html`.** Nothing in `src/` knows about it;
   the app loads `documentRoot: /app/` + `url: /index.html`. Keep the file at that
   path, or change both in `desktop/neutralino.config.json` (`applicationId`,
   window size, native allowlist).
2. **Keep the event names.** A shell that ignores `hitl_intercept` silently turns
   the approval gate into an auto-deny; one that ignores `grounding_warning` ships
   unverified text to the user.
3. **Do not compute policy client-side.** `GET /config` returns the truth;
   `PRESETS` in the shell are only labels for `policy.terminal.mode`.
4. **Assets**: icons live in `resources/icons/` and are copied to
   `desktop/resources/icons/` for the shell; `resources/icons/make-atom.js`
   regenerates them (plated + `--transparent`).
5. **Build**: `powershell -File installer/build.ps1` stages the payload,
   `installer/build-installer.ps1` produces `installer/dist/LiBER-Setup-<ver>.exe`.

## Adding capability (server side)

- **Media**: `tools/media-tool.js` is provider-backed and refuses to claim a capability
  without a key; extend `policy()` when you add a provider, never the reply text.
- **Tool**: write `src/daemon/core/tools/<name>-tool.js`, register it in
  `registry.js` with `{name, description, parameters, handler}` — the schema is
  validated by `core/validate.js`, so a bad argument never reaches the handler.
  If it mutates state, add it to `MUTATION_PATTERNS` in `terminal-tool.js` or to
  the policy check, and give it an audit line.
- **Provider**: add an adapter under `src/daemon/llm/adapters/`, map it in
  `llm/manager.js` `adapters`, and add a catalogue entry in `core/providers.js`
  (`id, label, adapter, base, env, kind`). `engineDefaults()` then resolves
  `provider: null` installs automatically.
- **Scheduled job**: the engine already runs automations through the same turn
  loop; a new trigger only needs `core/automations.js` `isDue()` support.
- **HTTP connector**: `core/connectors.js` turns a JSON declaration into a
  `conn_<id>` tool with named actions; headers support `vault:<name>` refs.

## Data on disk (`%LOCALAPPDATA%\LiBER`)

```
liber.yaml            config the daemon reads at start (engine, policy, limits)
.env                  provider keys (plaintext, user-only ACL)
.liber_memory.json    long-term memory store
.liber/daemon.token   auth token (SYSTEM/Administrators/user only)
.liber/clients.json   per-client tokens, stored as SHA-256 only
.liber/auth-audit.log per-request auth decisions (JSON lines)
.liber/terminal-audit.log  allow/run/deny decisions + exit code + duration + agentId/client/turnId
.liber/shares.json    share links: id, key, expiry, revoked, views
.liber/budget.json    daily spend guard
.liber/traces/*.jsonl one line per finished turn (prompt, response, receipts)
.liber/turns/         crash-safe journal for /resume
.liber/session.json   window state
```

## Invariants — a new layout must not break these

- `test/purity.test.js` — zero mentions of other products' names in `src/`.
- Grounding: no final answer without receipts; `repairs` counts the fix-ups.
- Fail-closed: `/chat` (non-SSE) refuses an action that would need approval.
- Policy order: denylist → approval → mode. A denylist entry cannot be approved away.
- Auth: token hashed at rest, scopes per endpoint (`scopeFor`), rate limited per client.
- A share link is read-only and sanitized **server-side** (`shares.sanitize`): tool
  observations, denials, credentials and account paths never reach it.
- `POST /stop` marks the turn and kills its child processes; the engine also clears
  the flag at turn start so one stop cannot poison the next turn.
- Every claim about remote state (npm publish, CI, install) is verified by a read,
  never by memory.
