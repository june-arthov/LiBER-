# ◢ L I B E R ◣
> **Minimalist-Utilitarian AI Agent Orchestrator**  
> *Powered by the Merlin Cognitive Engine & Tactical Cyber-Obsidian Harness*

[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://python.org/)
[![Architecture](https://img.shields.io/badge/Architecture-Tier--3%20Cognitive-cyan.svg)](#architecture)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

---

## ⚡ Overview

**LiBER** is a high-performance, autonomous AI agent orchestrator designed for precision software engineering, DevOps automation, and multi-step task execution.

Infused with the **Merlin Agent Cognitive Core** (`G:\Merlin Agent\Merlin-Agent`), LiBER delivers:
- **Zero-Filler Directness:** High-density technical execution without conversational fluff.
- **Cognitive Pulse (`[THOUGHT: ...]`)**: Pre-action reasoning before invoking tools.
- **Merlin Tool Suite:** First-class surgical file manipulation, fuzzy patching, command execution, structured planning, and cross-session memory.
- **Dual Surface:**
  - **LiBER Terminal:** Clean VT100/TrueColor streaming CLI interface.
  - **Tactical Cyber-Obsidian TUI:** Full Textual + Rich reactive telemetry dashboard with Human-In-The-Loop (HITL) safety breakpoints.

---

## 🛠️ Tool Ecosystem

LiBER agents are equipped with Merlin's core toolsets:

| Tool | Capability |
|---|---|
| `read_file` | Line-numbered reading with offset, limit, and automatic budget truncation |
| `write_file` | Safe atomic file write with directory auto-creation |
| `patch` | Surgical code replacement with whitespace-tolerant fuzzy matching & diff preview |
| `search_files` | Recursive regex content search and file globbing |
| `terminal` | PowerShell / Bash host shell execution with timeout and output capture |
| `fetch_url` | HTTP(S) fetch with HTML→text extraction — ground external claims instead of guessing |
| `todo_list` | Structured multi-step task planning and dependency tracking |
| `memory` | Persistent cross-session knowledge bank (`.liber_memory.json`) |

---

## 🚀 Quick Start

### 1. Installation

```bash
git clone https://github.com/june-arthov/LiBER-.git
cd LiBER-
npm install
npm link
```

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
6. **Skills** — a real procedural library: `skills/<name>/SKILL.md` (global) and
   `.liber/skills/` (per project). The prompt carries a cheap index plus the always-on core
   procedures; the model loads a body with the `skill` tool, and matching triggers auto-select
   one for the task. Inspect with `liber skills [name]`.

**What it guarantees:** no unverified claim is delivered as verified fact — every auditable claim
is bound to a real receipt or explicitly labelled UNVERIFIED. It does not make the model
omniscient: receipt binding is syntactic (the claim cited *a* real receipt), so the doctrine still
obliges the model to cite the receipt that actually proves the claim.

Run the enforcement suite with `npm test` (64 tests, including a scripted model that hallucinates,
gets blocked, and is forced to read the file before answering).

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
| Live reasoning | Each model turn's reasoning is captured — tagged `[THOUGHT: …]` or untagged prose before a tool call — and streamed to the CLI/TUI as a `REASONING` block before the answer. |
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
  ├─ Merlin Engine (Autonomous Turn Loop)
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

