#!/usr/bin/env python3
"""
LIBER :: Autonomous Agent Harness TUI (Tactical Cyber-Obsidian)
Theme: Tactical Cyber-Obsidian
Stack: Textual + Rich Renderables + Async Engine Integration
"""

import sys
import os
import json
import asyncio
import subprocess
from pathlib import Path
from typing import Optional, AsyncGenerator, Dict, Any

import httpx
from rich.text import Text
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.reactive import reactive
from textual.widgets import Footer, RichLog, Static, Input
from textual.binding import Binding

DAEMON_URL = "http://127.0.0.1:4567"
ROOT_DIR = Path(__file__).resolve().parent.parent


def auth_headers() -> Dict[str, str]:
    """Bearer token written by the daemon at boot (.liber/daemon.token)."""
    token = os.environ.get("LIBER_TOKEN", "")
    if not token:
        try:
            token = (Path.cwd() / ".liber" / "daemon.token").read_text(encoding="utf-8").strip()
        except OSError:
            token = ""
    return {"Authorization": f"Bearer {token}"} if token else {}


# =====================================================================
# 1. VISUAL CUE & DESIGN SYSTEM HELPER
# =====================================================================

class LiberCue:
    """Helper untuk merender visual cue, pill badges, dan dynamic meters."""

    @staticmethod
    def badge(label: str, style: str) -> Text:
        """Membuat badge inverted pill dengan padding rapat."""
        return Text.assemble(
            (" ", style),
            (f"{label.upper()}", f"bold {style}"),
            (" ", style),
            (" ", "default")
        )

    @staticmethod
    def context_bar(used: int, total: int, width: int = 14) -> Text:
        """Merender bar kapasitas context window dengan transisi warna cerdas."""
        total = max(total, 1)
        pct = min(max(used / total, 0.0), 1.0)
        filled = int(pct * width)
        empty = width - filled

        if pct < 0.60:
            color = "#10B981"  # Mint Green
        elif pct < 0.85:
            color = "#F59E0B"  # Cyber Amber
        else:
            color = "bold #EF4444"  # Crimson Overflow Warning

        bar = "█" * filled + "░" * empty
        return Text.assemble(
            ("CTX [", "#52525B"),
            (bar, color),
            (f"] {int(pct * 100)}% ({used // 1000}k/{total // 1000}k)", "dim #E2E8F0")
        )

    @staticmethod
    def tool_dispatch_box(tool_name: str, cmd: str) -> Panel:
        """Panel khusus blok eksekusi tool/sandbox."""
        body = Text.assemble(
            ("⚡ COMMAND: ", "bold #00F0FF"),
            (f"{cmd}\n", "bright_white"),
            ("↳ ENV: ", "dim #71717A"),
            ("local://powershell-sandbox  ", "#10B981"),
            ("│ TIMEOUT: ", "dim #71717A"),
            ("30s", "white")
        )
        return Panel(
            body,
            title=f"[bold #00F0FF]TOOL DISPATCH :: {tool_name.upper()}[/bold #00F0FF]",
            border_style="#00F0FF",
            padding=(0, 1)
        )


# =====================================================================
# 2. CUSTOM REACTIVE WIDGETS
# =====================================================================

class HeaderBar(Static):
    """Header status bar dengan visual telemetry global."""
    latency = reactive(24)
    tok_speed = reactive(0.0)
    ctx_used = reactive(1800)
    ctx_total = 32000
    model_name = reactive("glm-5.3-flash:cloud")
    state_label = reactive("IDLE")

    def render(self) -> Panel:
        state_color = "#10B981" if self.state_label == "IDLE" else "#00F0FF"

        left_text = Text.assemble(
            (" ╭─ ", "#27272A"),
            ("LIBER", "bold #00FF87"),
            (" // AGENTIC HARNESS ", "dim white"),
            ("[STATE: ", "#52525B"),
            (self.state_label, f"bold {state_color}"),
            ("] ", "#52525B"),
            ("MODEL: ", "dim white"),
            (self.model_name, "bold white")
        )

        ctx_render = LiberCue.context_bar(self.ctx_used, self.ctx_total)

        right_text = Text.assemble(
            (f"⚡ {self.tok_speed:.1f} t/s ", "bold #00F0FF"),
            ("│ ", "#27272A"),
            (f"⏱ {self.latency}ms ", "#10B981"),
            ("│ ", "#27272A"),
            ctx_render,
            (" ─╮", "#27272A")
        )

        grid = Table.grid(expand=True)
        grid.add_column(justify="left")
        grid.add_column(justify="right")
        grid.add_row(left_text, right_text)

        return Panel(grid, style="on #08090A", border_style="#00FF87")


class TelemetrySidebar(Static):
    """Sidebar kanan berisi metrik performa, DAG topology, dan memory bank."""
    tok_velocity = reactive(" ▂▃▅▇█▇▆▅ — t/s")
    cost_accum = reactive(0.0)
    active_node = reactive("Orchestrator")
    gateway = reactive("LiberDaemon:4567")

    def render(self) -> Panel:
        content = Text()

        # Topology DAG Tree
        content.append("⎔ AGENT TOPOLOGY\n", "bold #8B5CF6")
        content.append(" ├─ [✓] ", "#10B981")
        content.append("Orchestrator (Root)\n", "white")
        content.append(" ├─ [✓] ", "#10B981")
        content.append("EnvScanner\n", "white")
        content.append(" └─ [▶] ", "bold #00F0FF")
        content.append(f"{self.active_node}\n", "bold #00F0FF")
        content.append("    └─ [◌] ", "#52525B")
        content.append("SafetyAuditor\n\n", "dim white")

        # Telemetry Data
        content.append("⎔ RUNTIME TELEMETRY\n", "bold #00F0FF")
        content.append(" • Velocity : ", "dim white")
        content.append(f"{self.tok_velocity}\n", "bright_white")
        content.append(" • Cost Acc : ", "dim white")
        content.append(f"${self.cost_accum:.4f}\n", "bold #F59E0B")
        content.append(" • Gateway  : ", "dim white")
        content.append(f"{self.gateway}\n", "#38BDF8")
        content.append(" • Isolation: ", "dim white")
        content.append("Local Sandbox\n\n", "#10B981")

        # Memory Slots
        content.append("⎔ MEMORY POOL (Cognitive)\n", "bold #F59E0B")
        content.append(" • Working Memory  : ", "dim white")
        content.append("sliding-window (10)\n", "white")
        content.append(" • Active Context  : ", "dim white")
        content.append("Cognitive Pulse [ON]\n", "white")
        content.append(" • Circuit Breaker : ", "dim white")
        content.append("5 loops max\n", "dim #52525B")

        return Panel(
            content,
            title="[bold #8B5CF6]MISSION INSPECTOR[/bold #8B5CF6]",
            border_style="#27272A",
            padding=(1, 1)
        )


class HitlGate(Static):
    """Dock panel for Human-In-The-Loop interventions."""
    hitl_active = reactive(False)
    action_target = reactive("system_call")

    def render(self) -> Panel:
        if not self.hitl_active:
            msg = Text.assemble(
                ("● MODE: ", "#52525B"),
                ("AUTONOMOUS EXECUTION", "bold #10B981"),
                (" │ Press ", "dim white"),
                ("[SPACE]", "bold white"),
                (" to pause execution loop. Type instructions below.", "dim white")
            )
            return Panel(msg, border_style="#27272A", style="on #08090A")

        msg = Text.assemble(
            ("⚠️  HITL INTERCEPT ACTIVE: ", "bold black on #F59E0B"),
            (f" Agent requested operator authorization for: `{self.action_target}`\n", "bold white"),
            ("❯ Choose Action: ", "bold #F59E0B"),
            ("[A]", "bold #10B981"), (" Approve  ", "white"),
            ("[D]", "bold #EF4444"), (" Deny & Abort  ", "white"),
            ("[SPACE]", "bold #00F0FF"), (" Toggle Pause", "white")
        )
        return Panel(msg, border_style="#F59E0B", style="on #0D1117")


# =====================================================================
# 3. ROOT TUI APPLICATION
# =====================================================================

class LiberApp(App):
    """Aplikasi TUI Utama Harness Liber."""

    CSS = """
    Screen {
        background: #08090A;
        color: #E2E8F0;
    }

    HeaderBar {
        height: 3;
        margin: 0;
        padding: 0;
    }

    #main-container {
        height: 1fr;
    }

    #stream-pane {
        width: 70%;
        border: round #27272A;
        background: #08090A;
        margin-right: 1;
    }

    #sidebar-pane {
        width: 30%;
    }

    HitlGate {
        height: 4;
        margin-top: 0;
        margin-bottom: 0;
    }

    #prompt-input {
        dock: bottom;
        height: 3;
        border: round #00F0FF;
        background: #0D1117;
        color: #E2E8F0;
        padding: 0 1;
        margin-bottom: 0;
    }

    RichLog {
        background: #08090A;
        color: #E2E8F0;
        scrollbar-gutter: stable;
        padding: 0 1;
    }
    """

    BINDINGS = [
        Binding("space", "toggle_pause", "Pause/Resume"),
        Binding("a", "approve_action", "Approve HITL"),
        Binding("d", "deny_action", "Deny HITL"),
        Binding("c", "clear_logs", "Clear Logs"),
        Binding("q", "quit", "Quit Liber")
    ]

    def compose(self) -> ComposeResult:
        yield HeaderBar(id="header-bar")
        with Horizontal(id="main-container"):
            with Vertical(id="stream-pane"):
                yield RichLog(id="agent-log", wrap=True, highlight=False, markup=True)
            with Vertical(id="sidebar-pane"):
                yield TelemetrySidebar(id="telemetry-sidebar")
        yield HitlGate(id="hitl-gate")
        yield Input(placeholder="Type instructions for agent (Press Enter to send)...", id="prompt-input")
        yield Footer()

    async def on_mount(self) -> None:
        """Initialize daemon connection and mount widgets."""
        self.log_widget = self.query_one("#agent-log", RichLog)
        self.hitl_widget = self.query_one("#hitl-gate", HitlGate)
        self.sidebar_widget = self.query_one("#telemetry-sidebar", TelemetrySidebar)
        self.header_widget = self.query_one("#header-bar", HeaderBar)
        self.prompt_input = self.query_one("#prompt-input", Input)

        self.hitl_signal: Optional[asyncio.Event] = None
        self.hitl_verdict: bool = False
        self.agent_busy: bool = False

        # Welcome operator in stream log
        self.log_widget.write(
            Text.assemble(
                LiberCue.badge("SYSTEM", "black on #00FF87"),
                (" Liber Agentic Harness v0.2.0 active. Engine: ", "bold white"),
                (f"{DAEMON_URL}\n", "#38BDF8"),
                ("  Type commands in input bar below or press ", "dim white"),
                ("[SPACE]", "bold white"),
                (" to toggle pause.\n", "dim white")
            )
        )

        # Check daemon availability
        asyncio.create_task(self.check_and_ensure_daemon())

    async def check_and_ensure_daemon(self) -> None:
        """Verify daemon status and fetch active agent profile."""
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                res = await client.get(f"{DAEMON_URL}/ps", headers=auth_headers())
                if res.status_code == 200:
                    data = res.json()
                    agents = data.get("data", [])
                    if agents:
                        agent = agents[0]
                        model = agent.get("model") or agent.get("config", {}).get("engine", {}).get("model", "glm-5.3-flash:cloud")
                        self.header_widget.model_name = model
                        self.log_widget.write(
                            Text.assemble(
                                LiberCue.badge("DAEMON", "black on #00F0FF"),
                                (f" Connected to agent: `{agent.get('id', 'dev-bot')}` [ONLINE]\n", "#10B981")
                            )
                        )
                        return
        except Exception:
            pass

        # Offline guidance
        self.log_widget.write(
            Text.assemble(
                LiberCue.badge("OFFLINE", "black on #F59E0B"),
                (" Daemon is offline on port 4567. Run 'liber spawn' in terminal or wait for auto-spawn...", "dim #F59E0B")
            )
        )

    # -----------------------------------------------------------------
    # Event-Driven Backend Streaming Queue
    # -----------------------------------------------------------------

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        """Triggered when the operator submits an instruction in the prompt bar."""
        prompt = event.value.strip()
        if not prompt or self.agent_busy:
            return

        self.prompt_input.value = ""
        asyncio.create_task(self.dispatch_agent_cycle(prompt))

    async def dispatch_agent_cycle(self, prompt: str) -> None:
        """Connects prompt to backend engine real-time SSE stream."""
        self.agent_busy = True
        self.header_widget.state_label = "EXECUTING"
        self.query_one("#stream-pane").styles.border = ("round", "#00F0FF")

        # Display operator prompt in log stream
        self.log_widget.write(
            Text.assemble(
                LiberCue.badge("OPERATOR", "black on #00F0FF"),
                (f" {prompt}", "bold bright_white")
            )
        )

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                # Streaming POST ke /chat/stream
                async with client.stream(
                    "POST",
                    f"{DAEMON_URL}/chat/stream",
                    json={"agentId": "dev-bot", "message": prompt},
                    headers=auth_headers()
                ) as response:
                    if response.status_code != 200:
                        self.log_widget.write(
                            Text.assemble(
                                LiberCue.badge("ERROR", "white on #EF4444"),
                                (f" Gateway HTTP {response.status_code}: Gagal memulai stream.", "red")
                            )
                        )
                        return

                    current_event = ""
                    async for line in response.aiter_lines():
                        line = line.strip()
                        if not line:
                            continue

                        if line.startswith("event:"):
                            current_event = line.replace("event:", "").strip()
                            continue

                        if line.startswith("data:"):
                            raw_data = line.replace("data:", "").strip()
                            try:
                                payload = json.loads(raw_data)
                            except Exception:
                                payload = {"content": raw_data}

                            await self.handle_backend_event(current_event, payload)

        except httpx.ConnectError:
            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("ERROR", "white on #EF4444"),
                    (" Unable to connect to Liber daemon (127.0.0.1:4567). Ensure daemon is running.", "#EF4444")
                )
            )
        except Exception as e:
            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("EXCEPTION", "white on #EF4444"),
                    (f" {str(e)}", "red")
                )
            )
        finally:
            self.agent_busy = False
            self.header_widget.state_label = "IDLE"
            self.query_one("#stream-pane").styles.border = ("round", "#27272A")

    async def handle_backend_event(self, event: str, data: Dict[str, Any]) -> None:
        """
        Event Parser for agent harness:
        - thought -> LiberCue.badge("THOUGHT", ...)
        - tool_dispatch -> LiberCue.tool_dispatch_box(tool_name, cmd)
        - hitl_intercept -> Trigger breakpoint HITL
        - observation -> LiberCue.badge("OBSERVE", ...)
        - telemetry -> Reactive updates on header and sidebar
        - final -> Output final answer
        """
        # 0. Live draft stream (raw model output, not yet audited)
        if event == "draft_start":
            self.header_widget.state_label = "DRAFTING"
            return
        if event == "draft":
            return
        if event == "draft_end":
            self.header_widget.state_label = "IDLE"
            if data.get("failed"):
                self.log_widget.write(
                    Text.assemble(
                        LiberCue.badge("DRAFT", "white on #F59E0B"),
                        (" stream interrupted — falling back to a complete audited answer", "dim #F59E0B")
                    )
                )
            else:
                self.log_widget.write(
                    Text.assemble(
                        LiberCue.badge("DRAFT", "white on #8B5CF6"),
                        (f" {data.get('chars', 0)} chars streamed · UNVERIFIED until the audit passes", "dim #A78BFA")
                    )
                )
            return

        # 1. Thought / Reasoning
        if event == "thought":
            thought_text = data.get("content", "")
            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("REASONING", "black on #8B5CF6"),
                    (f" {thought_text}", "italic #E2E8F0")
                )
            )

        # 2. Tool Dispatch
        elif event == "tool_dispatch":
            tool_name = data.get("tool", "sandbox_exec")
            cmd = data.get("command", "")
            self.log_widget.write(LiberCue.tool_dispatch_box(tool_name, cmd))

        # 3. Sensitive Action -> HITL Breakpoint
        elif event == "hitl_intercept":
            target = data.get("target", "command")
            self.hitl_widget.action_target = target
            self.hitl_widget.hitl_active = True
            self.query_one("#stream-pane").styles.border = ("round", "#F59E0B")

            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("CRIT/WARN", "black on #F59E0B"),
                    (f" [BREAKPOINT ACTIVATED] Policy requires manual operator authorization for: `{target}`", "bold #F59E0B")
                )
            )

            # Signal barrier
            self.hitl_signal = asyncio.Event()
            await self.hitl_signal.wait()

            # Send verdict back to daemon backend
            verdict_str = "approve" if self.hitl_verdict else "deny"
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    await client.post(f"{DAEMON_URL}/hitl/verdict", json={"verdict": verdict_str}, headers=auth_headers())
            except Exception:
                pass

        # 4. Observation Stage
        elif event == "observation":
            output = data.get("output", "")
            exit_code = data.get("exit_code", 0)
            duration_ms = data.get("duration_ms", 0)
            approved = data.get("approved", True)

            color = "#10B981" if approved and exit_code == 0 else "#EF4444"
            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("OBSERVE", "white on #27272A"),
                    (f" STDOUT: {output}\n", color),
                    (f"↳ EXIT: {exit_code} │ DURATION: {duration_ms}ms │ POLICY: OK", "dim #71717A")
                )
            )

        # 5. Reactive Telemetry Updates
        elif event == "telemetry":
            if "tok_speed" in data:
                self.header_widget.tok_speed = float(data["tok_speed"])
            if "ctx_used" in data:
                self.header_widget.ctx_used = int(data["ctx_used"])
            if "ctx_total" in data:
                self.header_widget.ctx_total = int(data["ctx_total"])
            if "latency" in data:
                self.header_widget.latency = int(data["latency"])
            if "cost_accum" in data:
                self.sidebar_widget.cost_accum = float(data["cost_accum"])
            if "active_node" in data:
                self.sidebar_widget.active_node = data["active_node"]

        # 5b. Grounding gate events (zero-hallucination layer)
        elif event == "grounding_audit":
            codes = ", ".join(sorted({v.get("code", "?") for v in data.get("violations", [])}))
            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("GROUNDING", "black on #F59E0B"),
                    (f" repair {data.get('attempt', 1)}/{data.get('max_repairs', 2)} — blocked unverified claims: {codes}", "bold #F59E0B")
                )
            )

        elif event == "grounding_warning":
            n = len(data.get("violations", []))
            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("UNVERIFIED", "white on #EF4444"),
                    (f" {n} claim(s) shipped without receipts — see GROUNDING AUDIT footer", "bold #EF4444")
                )
            )

        elif event == "grounding_pass":
            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("GROUNDED", "black on #10B981"),
                    (f" {data.get('claims_checked', 0)} claim(s) bound to {data.get('receipts', 0)} receipt(s)", "dim #10B981")
                )
            )

        # 6. Final Agent Response
        elif event == "final":
            final_text = data.get("response", "")
            duration = data.get("durationMs", 0)
            iterations = data.get("iterations", 1)
            grounding = data.get("grounding") or {}
            status = grounding.get("status", "DISABLED")

            if status == "PASS":
                cycle = f"↳ [CYCLE COMPLETE: {duration}ms │ {iterations} turns │ GROUNDED · {len(grounding.get('ledger', {}).get('receipts', []))} receipts]"
                cycle_style = "dim #10B981"
            elif status == "REPAIR":
                cycle = f"↳ [CYCLE COMPLETE: {duration}ms │ {iterations} turns │ ⚠ {len(grounding.get('violations', []))} UNVERIFIED CLAIM(S)]"
                cycle_style = "bold #F59E0B"
            else:
                cycle = f"↳ [CYCLE COMPLETE: {duration}ms │ {iterations} turns]"
                cycle_style = "dim #10B981"

            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("RESPONSE", "black on #00FF87"),
                    (f" {final_text}\n", "bright_white"),
                    (cycle, cycle_style)
                )
            )

        # 7. Error event
        elif event == "error":
            err_msg = data.get("error", "Unknown error")
            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("ERROR", "white on #EF4444"),
                    (f" {err_msg}", "bold #EF4444")
                )
            )

    # -----------------------------------------------------------------
    # Key Action Handlers (Operator Interventions)
    # -----------------------------------------------------------------

    def action_toggle_pause(self) -> None:
        """Pause or resume the execution loop."""
        self.hitl_widget.hitl_active = not self.hitl_widget.hitl_active
        if self.hitl_widget.hitl_active:
            self.query_one("#stream-pane").styles.border = ("round", "#F59E0B")
            self.log_widget.write(
                Text.assemble(LiberCue.badge("PAUSED", "black on #F59E0B"), (" Execution halted by operator.", "white"))
            )
        else:
            self.query_one("#stream-pane").styles.border = ("round", "#27272A")
            self.log_widget.write(
                Text.assemble(LiberCue.badge("RESUMED", "black on #10B981"), (" Resuming agent loop cycle...", "white"))
            )

    def action_approve_action(self) -> None:
        """Approve sensitive tool/command execution."""
        if self.hitl_widget.hitl_active:
            self.hitl_widget.hitl_active = False
            self.hitl_verdict = True
            self.query_one("#stream-pane").styles.border = ("round", "#10B981")
            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("APPROVED", "black on #10B981"),
                    (f" Authorization granted for `{self.hitl_widget.action_target}`. Executing...", "white")
                )
            )
            if self.hitl_signal:
                self.hitl_signal.set()

    def action_deny_action(self) -> None:
        """Deny sensitive action and require agent to re-plan."""
        if self.hitl_widget.hitl_active:
            self.hitl_widget.hitl_active = False
            self.hitl_verdict = False
            self.query_one("#stream-pane").styles.border = ("round", "#EF4444")
            self.log_widget.write(
                Text.assemble(
                    LiberCue.badge("REJECTED", "white on #EF4444"),
                    (f" Action `{self.hitl_widget.action_target}` denied by operator. Sending feedback to agent.", "bold #EF4444")
                )
            )
            if self.hitl_signal:
                self.hitl_signal.set()

    def action_clear_logs(self) -> None:
        """Clear log pane."""
        self.log_widget.clear()


if __name__ == "__main__":
    app = LiberApp()
    app.run()

