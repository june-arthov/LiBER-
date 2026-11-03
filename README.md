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
  - **Agy Terminal:** Clean VT100/TrueColor streaming CLI interface.
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

#### Launch Interactive Agy Terminal
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
  ├─ Agy Terminal (CLI REPL)
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
