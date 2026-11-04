# ◢ L I B E R ◣
> **Minimalist-Utilitarian AI Agent Orchestrator**  
> *An original, self-contained harness — its own cognitive engine, no third-party agent framework.*

[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://python.org/)
[![Architecture](https://img.shields.io/badge/Architecture-Tier--3%20Cognitive-cyan.svg)](#architecture)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

```bash
npm i -g @arthovlabs/liber
liber --version
```

---

## ⚡ Overview

**LiBER** is a high-performance, autonomous AI agent orchestrator designed for precision software engineering, DevOps automation, and multi-step task execution.

LiBER is an original codebase — not a fork of, and containing no code from, Hermes Agent (Nous Research) or any other agent framework. It delivers:
- **Zero-Filler Directness:** High-density technical execution without conversational fluff.
- **Cognitive Pulse (`[THOUGHT: ...]`)**: Pre-action reasoning before invoking tools.
- **Tool Suite:** First-class surgical file manipulation, fuzzy patching, command execution, structured planning, and cross-session memory.
- **Dual Surface:**
  - **LiBER Terminal:** Clean VT100/TrueColor streaming CLI interface.
  - **Tactical Cyber-Obsidian TUI:** Full Textual + Rich reactive telemetry dashboard with Human-In-The-Loop (HITL) safety breakpoints.
- **Enforced Grounding, Not Requested:** A gate audits every auditable sentence against tool receipts and blocks, repairs, or labels what it cannot verify — the model cannot talk its way past it.
- **Works While You Don't:** Scheduled automations run prompts through the same engine, gate and policy, each in its own session.
- **Reach Beyond the Repo:** A headless Chromium the agent drives (open, click, type, screenshot) and HTTP connectors that turn any API into a tool — secrets resolved from the vault at call time, never in the prompt.
- **Contained by Default:** Commands run in a container (no network, read-only root, workspace-only mount) or, where Docker is absent, PowerShell Constrained Language Mode — with the fallback stated instead of hidden.
- **Multi-Client by Design:** One token per client with scopes, per-minute rate limits, rotation, and an audit line for every request.

---

## 🛠️ Tool Ecosystem

LiBER agents are equipped with a first-class toolset:

| Tool | Capability |
|---|---|
| `read_file` | Line-numbered reading with offset, limit, and automatic budget truncation |
| `write_file` | Safe atomic file write with directory auto-creation |
| `patch` | Surgical code replacement with whitespace-tolerant fuzzy matching & diff preview |
| `search_files` | Recursive regex content search and file globbing |
| `terminal` | Host shell execution with timeout and output capture — sandboxed: container by default (no network, read-only root, workspace-only mount), Constrained Language Mode as fallback |
| `browser` | Real headless Chromium over CDP: `open`, `click` (selector or visible text), `type`, `press`, `extract`, `screenshot`, `eval` — for pages that need JavaScript, a login, or interaction |
| `fetch_url` | HTTP(S) fetch with HTML→text extraction — ground external claims instead of guessing |
| `web_search` | Keyless web search (DuckDuckGo → SearXNG fallback) returning titles/URLs/snippets |
| `vault` | AES-256-GCM secret store: list (names + last-4 only), set, remove; reading a value back into a prompt is opt-in |
| `conn_<id>` | One tool per declared HTTP connector, generated from `.liber/connectors.json`; `vault:name` headers resolve at call time |
| `task` / `tasks` | Subagent orchestration: one isolated child turn, or up to 4 in parallel |
| `todo_list` | Structured multi-step task planning and dependency tracking |
| `memory` | Persistent cross-session knowledge bank (`.liber_memory.json`) |

---

## 🚀 Quick Start

### Install from npm

```bash
npm i -g @arthovlabs/liber
liber --version
```

Both commands are installed: `liber` (CLI / TUI) and `liberd` (daemon).

### Or from source

```bash
git clone https://github.com/june-arthov/LiBER-.git
cd LiBER-
npm install
npm link
```

> **Linux/WSL: use the full setup script** — it handles the pieces `npm link`
> needs sudo for, creates an isolated `.venv` for the Python TUI (textual + httpx),
> and copies `.env` from the template:
>
> ```bash
> bash scripts/setup.sh
> ```
>
> Manual fallback: `sudo npm link` (or run `node bin/liber` without linking) and
> `python3 -m pip install --user textual httpx` for the TUI.

*(Optional Python TUI dependencies)*
```bash
pip install rich textual httpx
```

### 2. Configuration

Create your local `.env`:
```bash
cp .env.example .env
```
Add your API key (e.g. Ollama Cloud or OpenAI compatible):
```env
OLLAMA_CLOUD_API_KEY=your_key_here
```

### 3. Usage

#### Start the Background Daemon
```powershell
liber spawn
```

#### Launch Interactive LiBER Terminal
```powershell
liber
```
*Available slash commands inside the terminal: `/help`, `/status`, `/tools`, `/model`, `/logs`, `/clear`, `/tui`, `/exit`.*

#### Launch Tactical Cyber-Obsidian TUI Dashboard
```powershell
liber tui
```
*Or directly via Python:*
```powershell
python bin/liber-tui.py
```

#### One-Shot CLI Execution
```powershell
liber chat dev-bot "audit project directory and verify package.json"
```

#### Manage Fleet
```powershell
liber ps          # Check agent fleet status and uptime
liber logs -n 25  # View structured telemetry stream
liber skills      # List procedural skills (liber skills <name> to print one)
liber resume      # Continue an interrupted turn from .liber/turns/
liber reset       # Clear the persisted conversation window
liber bench       # Run the 8-case model-compliance benchmark (grounded, honesty, tools)
liber desktop     # Launch the LiBER desktop shell (LiBER.exe — OpenCode-style UI)
liber stop        # Gracefully shutdown daemon
```

---

## 🧿 Zero-Hallucination Protocol

Prompt wording alone cannot stop a model from inventing claims, so LiBER enforces grounding
mechanically on every turn:

1. **Evidence ledger** — every tool result becomes a numbered receipt (`E1`, `E2`, …) with tool,
   arguments, exit code, output hash and excerpt. The ledger is injected into the system prompt.
2. **Grounding gate** — before any answer is returned, `src/daemon/core/grounding.js` audits every
   auditable sentence (file paths, commands, test results, versions, dates, "I did X" claims).
   Each must cite a receipt that exists in this turn's ledger.
3. **Repair loop** — a failing answer is blocked and sent back with its exact violations. The model
   must gather the missing receipts or write the claim as `UNVERIFIED: …`. After `max_repairs`
   (default 2) the answer ships with a visible `GROUNDING AUDIT` footer naming every unproven claim.
4. **Read-back enforcement** — `write_file` / `patch` put the file into a pending-verification set;
   success cannot be claimed until the file is read back or a test/build runs green.
5. **Argument validation** — tool calls are validated against their schema before execution;
   missing, typo'd or ill-typed arguments are rejected and fed back, never executed.
6. **Semantic verifier** — after the syntactic gate passes, a second pass asks whether the cited
   receipt actually *entails* each claim. Unsupported claims are sent back for repair.
7. **Skills** — a real procedural library: `skills/<name>/SKILL.md` (global) and
   `.liber/skills/` (per project). The prompt carries a cheap index plus the always-on core
   procedures; the model loads a body with the `skill` tool, and matching triggers auto-select
   one for the task. Inspect with `liber skills [name]`.

**What it guarantees:** no unverified claim is delivered as verified fact — every auditable claim
is bound to a real receipt or explicitly labelled UNVERIFIED, and a second model pass checks whether
the cited receipt actually entails it. It is still not a proof system: the semantic verifier can miss
subtle unsupported claims or flag supported ones, and a verifier outage fails open (recorded as
`semantic: error`, never silently as `pass`).

Run the enforcement suite with `npm test` (242 tests: a scripted model that hallucinates, gets
blocked, and is forced to read the file before answering; a 15-case grounding regression dataset;
the terminal policy incl. per-stage pipeline evaluation; the approval-channel wiring; the budget
guard; and the git/workspace surface). CI runs the suite on Linux and Windows via
`.github/workflows/ci.yml`.

## 🔌 Providers

Liber talks to any provider through one of four adapters. The key goes in `.env`
(or your shell environment) — never in `liber.yaml`.

| Adapter | Provider(s) | `provider` | `endpoint` | Key env var |
|---|---|---|---|---|
| OpenAI-compatible | OpenAI, Groq, Mistral, DeepSeek, OpenRouter, xAI, Together, Ollama Cloud | `openai` | e.g. `https://api.openai.com/v1` | `OPENAI_API_KEY` (falls back to `OLLAMA_CLOUD_API_KEY`) |
| Anthropic | Claude models | `anthropic` | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| Google | Gemini models | `gemini` | `https://generativelanguage.googleapis.com` | `GEMINI_API_KEY` (falls back to `GOOGLE_API_KEY`) |
| Ollama native | local Ollama servers | `ollama` | e.g. `http://localhost:11434` | none required |

Details:

- **OpenAI-compatible** covers every provider that speaks `/chat/completions`. Change
  `engine.provider`, `engine.endpoint`, `engine.model` and the key — nothing else.
- **Anthropic** is a dedicated adapter: system messages move to the `system` parameter,
  consecutive same-role turns are merged (the Messages API rejects repeats), and native
  tool calling is translated both ways (`tool_calls` ↔ `tool_use`/`tool_result`).
- **Gemini** translates roles into `contents`/`systemInstruction` and streams via
  `streamGenerateContent?alt=sse`. Native tool calling is not implemented — the engine
  falls back to the text protocol automatically.
- **Streaming** works on all adapters; a failed stream always falls back to a full,
  audited completion.

## 🖥️ Desktop Shell (LiBER.exe)

An original Neutralino/WebView2 shell (~3 MB, no Electron) with an OpenCode-style
interface: left sidebar shows the real agent fleet and a live model picker
(`/model/switch`), the main pane streams the turn over SSE (reasoning, tool
receipts, grounding audit, cited answers), and the input bar is keyboard-first
(Enter send, Ctrl+M model, Ctrl+L clear).

Build once:

```bash
cd desktop
npm i -D @neutralinojs/neu
npx neu update
npx neu build
```

The binary lands at `desktop/dist/liber-desktop/LiBER.exe` — double-click it or
run `liber desktop`. It talks to the local daemon (`127.0.0.1:4567`): the daemon's
unauthenticated `GET /whoami` reports only the token **file path** (never the
token), the shell reads the file through the Neutralino filesystem API, and all
stateful calls keep the bearer token. The daemon also gained CORS headers and an
OPTIONS handler so local shells can call it without weakening auth.

## 📚 Skill Library

Skills are procedures, not prompt text: each one is a `SKILL.md` with a one-line "use when"
description, optional triggers, and a body. They are discovered at boot, indexed cheaply, and
loaded only when needed.

- **Global** — `skills/<name>/SKILL.md` (shipped with Liber).
- **Project** — `.liber/skills/<name>/SKILL.md` (overrides a global skill of the same name).
- **On demand** — `[TOOL: skill({"action":"view","name":"..."})]`; `list` / `search` also available.
- **Auto-select** — a trigger match injects the body for that turn.
- **Authoring** — `skill` action `create`/`update` writes to `.liber/skills/` and requires HITL approval.
- **Attachments** — `references/`, `scripts/`, `templates/` next to `SKILL.md` are listed by `view`.

Shipped skills: `iron-law` (always), `grounding-protocol` (always), `systematic-debugging`,
`verification-first`, `surgical-precision`, `honest-refusal`, `instruction-fidelity`,
`codebase-orientation`, `performance-triage`.

## ⚙️ Harness Capabilities

| Capability | Behaviour |
|---|---|
| Daemon auth | Every endpoint except `/healthz` needs a bearer token, resolved to a client with scopes (`read`, `chat`, `tools`, `admin`), a per-minute token bucket (429 + `Retry-After`) and one audit line per request in `.liber/auth-audit.log`. The desktop token in `.liber/daemon.token` is adopted as the `local` admin client; other clients get their own once-only token from `/clients`, and can be rotated or revoked without touching anyone else. |
| Command sandbox | `policy.terminal.backend` selects the execution surface: `docker` runs in a container (no network, read-only root, `--cap-drop ALL`, `no-new-privileges`, memory/pids caps, only the workspace mounted) and `powershell` runs in Constrained Language Mode with a scrubbed environment. Docker unreachable means a stated fallback, never a silent one. Every decision and run is appended to `.liber/terminal-audit.log`. |
| Secret vault | AES-256-GCM at rest (`.liber/vault.json`, key `0600`), listing exposes only the last four characters, tampered ciphertext fails closed, and connectors reference secrets as `vault:name` so they are resolved at call time. |
| Automations | Interval or daily-at jobs stored in `.liber/automations.json`, run by one daemon timer through the same engine, gate and policy; `markRun()` makes a tick idempotent and a running job is never started twice. |
| Turn serialization | One turn at a time per agent — simultaneous chats queue instead of interleaving observations into each other's context. |
| Deterministic receipt checks | A cited receipt must actually mention the file and contain the numbers, quoted strings and line numbers claimed — enforced by code, no model involved. |
| Secret redaction | Credential-shaped text (API keys, PATs, Bearer tokens, private keys) is redacted before session, journal and trace data reach disk. |
| Injection defense | `fetch_url` output is wrapped in an `UNTRUSTED` marker, instruction-like tool output is flagged and labelled DATA ONLY, and the doctrine forbids obeying content. |
| Write policy | `write_file` / `patch` are confined to `policy.write_roots`. The terminal has its own policy: `read_only` blocks state-changing commands (with an allowlist), `allowlist` restricts to listed prefixes, `prompt` keeps HITL only. Read-only inventory commands (`ls`, `dir`, `Get-ChildItem`, `cat`, `git log`, …) are allowed in every mode, pipelines are judged stage by stage, and redirection (`>`, `>>`, `<`) or command substitution (`$( )`, backticks) is always refused — no prefix entry can cover it. A denial names the allowed prefixes so the agent can adapt instead of retrying. |
| Native tool calling | `engine.native_tools: true` uses the provider's tool API with canonical assistant/tool messages; falls back to the text protocol if the provider rejects it. |
| Budget guard | `limits.max_tokens_per_day` and (when prices are set) `max_cost_per_day` are enforced before every model call; state in `.liber/budget.json`. |
| Settings API | `GET /config` (sanitized) and `POST /config` (whitelisted keys) let the desktop shell read and change engine, grounding, terminal policy, limits, memory and telemetry settings live, persisted to `liber.yaml` with comments intact. `POST /model/switch` and `POST /config/backup` are covered too. |
| Settings parity | The desktop drawer mirrors a full settings tree (Model, Chat, Appearance, Workspace, Safety, Browser, Passwords, Memory, Voice, Advanced, Notifications, Billing, Providers, Gateways, Shortcuts, Tools, Sessions, About) with subpages, search and Export / Reset. Panels without a daemon backend say so instead of faking a save. |
| Providers API | `GET /providers` (catalog of 40 providers + configured state with last-4 hints), `POST /providers/key`, `/providers/clear`, `/providers/custom`, `/providers/test` (live model-list probe) and `/providers/import` (subscription tokens already stored by Claude Code, Gemini CLI, Codex, Qwen, gh). Credentials live in `.liber/credentials.json` (0600) and are never returned to a client. |
| Workspace API | `GET /workspace` returns the real cwd, git branch, changed files with `+/-` line counts (from `git status` + `git diff --numstat`) and the tool steps this daemon actually executed. `GET /skills` lists installed skills; `POST /compact` summarizes history with the active model (falls back to trim); `POST /revert` drops the last exchange. |
| Subagents | `task` runs one isolated child turn; `tasks` runs up to 4 in parallel. Children get their own ledger, read-only tools, no recursion, and return a cited report as a receipt. |
| Resume | The turn journal (`.liber/turns/`) is written every iteration; after a crash `liber resume` continues from the last completed iteration with its receipts intact. |
| Live reasoning | Each model turn's reasoning is captured — tagged `[THOUGHT: …]` or untagged prose before a tool call — and streamed to the CLI/TUI as a `REASONING` block before the answer. |
| Draft streaming | With `engine.stream: true`, raw model output types out live in a `DRAFT · UNVERIFIED` line while the answer is still being generated. The audited answer replaces it; a partial stream is discarded and regenerated. Token usage is preserved via `stream_options.include_usage`. |
| Streaming CLI | `liber` and `liber chat` consume `/chat/stream`, so reasoning, tool calls and observations appear as they happen instead of only at the end. |
| Retry with backoff | 429/5xx/timeout are retried up to `retry_attempts` (default 3); auth/4xx errors are never retried. |
| Session persistence | The conversation window survives daemon restarts in `.liber/session.json` (`liber reset` clears it). |
| Trace audit | Every completed turn appends one JSONL record to `.liber/traces/YYYY-MM-DD.jsonl`. |
| Real usage | Provider `usage` is reported per turn; `cost_estimate` appears only when prices are configured. |
| Loop guard | Identical repeated tool calls are suppressed after two attempts and the model is forced to answer or declare the gap. |

## 🛡️ Human-In-The-Loop (HITL) Safety

LiBER automatically intercepts sensitive or destructive operations:
- File mutations (`write_file`, `patch`)
- Destructive commands (`rm -rf`, `format`, `del /s`, force push, drop table)

When intercepted, execution pauses and alerts the operator:
- **`[A]`**: Approve execution
- **`[D]`**: Deny execution and prompt agent to adapt

### Where commands actually run

`policy.terminal.backend` picks the execution surface, and the gate is enforced by
the machine rather than by the prompt:

| backend | isolation | what it means |
| --- | --- | --- |
| `docker` | container | no network, read-only root filesystem, dropped capabilities, `no-new-privileges`, memory and pid caps, and **only the workspace** mounted (at `/work`, read-write). The Windows filesystem, browser profile and SSH keys are not reachable. |
| `powershell` | language mode | same machine, but PowerShell runs in **Constrained Language Mode**, which refuses `[System.IO.File]`, `Add-Type` and reflection; the child gets a scrubbed environment so provider keys are not inherited. |

Every decision and every run is appended to `.liber/terminal-audit.log`, and
`GET /sandbox` reports which surfaces are actually available on this machine.
Docker Desktop must be running for the container backend; when it is not, LiBER
falls back to Constrained Language Mode and says so instead of pretending.

---

## 🔑 Clients and tokens

Each client gets its own token, scopes (`read`, `chat`, `tools`, `admin`) and a
per-minute rate limit. Tokens are stored as SHA-256 only, shown once at creation,
and can be rotated or revoked without touching other clients. Every request is
appended to `.liber/auth-audit.log` with the client id, scope, status and
duration. Manage them in **Settings → Access & Tokens** (`GET/POST/DELETE
/clients`, `POST /clients/rotate`).

---

## 🔐 Secrets

Provider keys and tokens live in an AES-256-GCM vault (`.liber/vault.json`, key at
`.liber/vault.key`, `0600`); listings expose only the last four characters, a
tampered ciphertext fails closed, and connectors may reference a secret as
`vault:name` so it is resolved at call time and never enters a prompt.

---

## 📄 Architecture

```text
[Operator Interface]
  ├─ LiBER Terminal (CLI REPL)
  └─ Cyber-Obsidian Dashboard (Textual TUI)
            │
            │ HTTP / Server-Sent Events (SSE)
            ▼
[Liber Daemon (liberd)]
  ├─ Liber Engine (Autonomous Turn Loop)
  ├─ Cognitive Pulse (Reasoning Parser)
  ├─ Tool Registry (file, terminal, todo, memory)
  ├─ Circuit Breaker & Self-Healing Guard
  └─ Context Compressor (Sliding Window & Semantic Summary)
            │
            ▼
[LLM Gateway / Model Provider] (Ollama Cloud, OpenAI, Custom)
```

---

## 📜 License
MIT © 2026 June Arthov

