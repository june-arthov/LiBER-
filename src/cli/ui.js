// src/cli/ui.js — Liber Agy-Style Terminal Interface
const readline = require('readline');
const path = require('path');
const fs = require('fs');

// Terminal capability detection: default to rich colors unless explicitly disabled with NO_COLOR
const noColor = process.env.NO_COLOR !== undefined;

// Color and styling engine with TrueColor + 256-color VT100 fallbacks
const C = {
  // Brand colors
  cyan: (s) => (noColor ? s : `\x1b[38;2;6;182;212m${s}\x1b[0m`),
  sky: (s) => (noColor ? s : `\x1b[38;2;56;189;248m${s}\x1b[0m`),
  blue: (s) => (noColor ? s : `\x1b[38;2;59;130;246m${s}\x1b[0m`),
  purple: (s) => (noColor ? s : `\x1b[38;2;168;85;247m${s}\x1b[0m`),
  green: (s) => (noColor ? s : `\x1b[38;2;16;185;129m${s}\x1b[0m`),
  amber: (s) => (noColor ? s : `\x1b[38;2;245;158;11m${s}\x1b[0m`),
  red: (s) => (noColor ? s : `\x1b[38;2;239;68;68m${s}\x1b[0m`),
  dim: (s) => (noColor ? s : `\x1b[38;2;148;163;184m${s}\x1b[0m`),
  darkDim: (s) => (noColor ? s : `\x1b[38;2;71;85;105m${s}\x1b[0m`),
  bold: (s) => (noColor ? s : `\x1b[1m${s}\x1b[22m`),
  italic: (s) => (noColor ? s : `\x1b[3m${s}\x1b[23m`),
  underline: (s) => (noColor ? s : `\x1b[4m${s}\x1b[24m`),

  // Solid background badges / pills
  badgeCyan: (s) => (noColor ? `[${s}]` : `\x1b[48;2;6;182;212m\x1b[38;2;15;23;42m\x1b[1m ${s} \x1b[0m`),
  badgeBlue: (s) => (noColor ? `[${s}]` : `\x1b[48;2;30;64;175m\x1b[38;2;241;245;249m\x1b[1m ${s} \x1b[0m`),
  badgeGreen: (s) => (noColor ? `[${s}]` : `\x1b[48;2;16;185;129m\x1b[38;2;15;23;42m\x1b[1m ${s} \x1b[0m`),
  badgeAmber: (s) => (noColor ? `[${s}]` : `\x1b[48;2;217;119;6m\x1b[38;2;15;23;42m\x1b[1m ${s} \x1b[0m`),
  badgePurple: (s) => (noColor ? `[${s}]` : `\x1b[48;2;147;51;234m\x1b[38;2;241;245;249m\x1b[1m ${s} \x1b[0m`),
  badgeRed: (s) => (noColor ? `[${s}]` : `\x1b[48;2;220;38;38m\x1b[38;2;255;255;255m\x1b[1m ${s} \x1b[0m`),
  badgeDark: (s) => (noColor ? `[${s}]` : `\x1b[48;2;30;41;59m\x1b[38;2;148;163;184m\x1b[1m ${s} \x1b[0m`),
};

// Strip ANSI escape sequences to compute true visual string width
function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// Window width helper
function getCols() {
  return Math.min(process.stdout.columns || 80, 100);
}

// Format a single box row with pixel-perfect right border alignment
function formatBoxRow(content, innerWidth) {
  const visibleLen = stripAnsi(content).length;
  const pad = Math.max(0, innerWidth - visibleLen);
  return '  ' + C.darkDim('│') + ' ' + content + ' '.repeat(pad) + ' ' + C.darkDim('│');
}

// Modern LiBER Terminal Header Banner
function printAgyBanner(info = {}) {
  const width = Math.max(getCols(), 76);
  const innerWidth = width - 2;
  const agent = info.agent || 'dev-bot';
  const model = info.model || 'glm-5.3-flash:cloud';
  const port = info.port || 4567;
  const status = info.online ? C.green('● Online') : C.amber('○ Offline');
  const cwd = process.cwd();
  const displayCwd = cwd.length > (innerWidth - 8) ? '...' + cwd.slice(-(innerWidth - 11)) : cwd;

  const titleBar = C.cyan(C.bold(' LIBER 2.0 '));
  const titleLen = stripAnsi(titleBar).length;
  const topBar = C.darkDim('  ╭─') + titleBar + C.darkDim('─'.repeat(Math.max(0, innerWidth - titleLen)) + '─╮');
  const bottomBar = C.darkDim('  ╰─') + C.darkDim('─'.repeat(innerWidth) + '─╯');

  const label = C.cyan(C.bold('▲ LIBER TERMINAL')) + C.dim('  Autonomous AI Agent Orchestrator');
  const ver = C.purple('v0.2.0');
  const padLen = Math.max(0, innerWidth - stripAnsi(label).length - stripAnsi(ver).length);
  const row1 = label + ' '.repeat(padLen) + ver;
  const row2 = C.dim('Agent: ') + C.bold(C.sky(agent)) + '  ' + C.dim('Model: ') + C.amber(model) + '  ' + C.dim('Daemon: ') + C.dim(`:${port}`) + ' [' + status + ']';
  const row3 = C.dim('Dir: ') + C.dim(displayCwd);

  console.log();
  console.log(topBar);
  console.log(formatBoxRow(row1, innerWidth));
  console.log(formatBoxRow(row2, innerWidth));
  console.log(formatBoxRow(row3, innerWidth));
  console.log(bottomBar);
  console.log(
    '  ' + C.dim('Type prompt to begin, or ') +
    C.cyan('/help') + C.dim(' for commands (') +
    C.dim('/status, /tools, /model, /logs, /tui, /clear, /exit') + C.dim(')')
  );
  console.log();
}

// Spinner for agent thought process
function startSpinner(label = 'Thinking...') {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const startTime = Date.now();
  let timer = null;

  if (process.stdout.isTTY) {
    process.stdout.write(`  ${C.cyan(frames[0])} ${C.dim(label)}`);
    timer = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      process.stdout.write(`\r\x1b[2K  ${C.cyan(frames[i++ % frames.length])} ${C.dim(label)} ${C.darkDim(`(${elapsed}s)`)}`);
    }, 80);
  } else {
    console.log(`  ${C.cyan('◇')} ${C.dim(label)}`);
  }

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        process.stdout.write('\r\x1b[2K');
      }
    }
  };
}

// Markdown formatter with syntax boxes and highlights
function formatMarkdown(text) {
  const lines = String(text).split('\n');
  const result = [];
  let inCode = false;
  let codeLang = '';
  const width = Math.max(getCols(), 70);

  for (let line of lines) {
    const trimmed = line.trim();

    // Code fence toggle
    if (trimmed.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeLang = trimmed.slice(3).trim() || 'code';
        result.push(C.darkDim('  ╭─ ') + C.blue(C.bold(codeLang)) + ' ' + C.darkDim('─'.repeat(Math.max(0, width - codeLang.length - 10))));
      } else {
        inCode = false;
        result.push(C.darkDim('  ╰─' + '─'.repeat(Math.max(0, width - 8))));
      }
      continue;
    }

    if (inCode) {
      result.push(C.darkDim('  │ ') + C.amber(line));
      continue;
    }

    // Markdown Headers
    if (/^###\s+/.test(trimmed)) {
      result.push('\n  ' + C.bold(C.sky('■ ' + trimmed.replace(/^###\s+/, ''))));
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      result.push('\n  ' + C.bold(C.cyan('▲ ' + trimmed.replace(/^##\s+/, ''))));
      continue;
    }
    if (/^#\s+/.test(trimmed)) {
      result.push('\n  ' + C.bold(C.cyan('◆ ' + trimmed.replace(/^#\s+/, ''))));
      continue;
    }

    // Bullet points
    if (/^[\*\-]\s+/.test(trimmed)) {
      line = '  ' + C.cyan('• ') + line.replace(/^[\*\-]\s+/, '');
    } else {
      line = '  ' + line;
    }

    // Bold, inline code, links
    line = line
      .replace(/\*\*(.*?)\*\*/g, (_, m) => C.bold(m))
      .replace(/`([^`]+)`/g, (_, m) => C.amber(m))
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => C.cyan(C.underline(text)) + C.dim(` (${url})`));

    result.push(line);
  }

  return result.join('\n');
}

// Render cognitive pulse thought card
function printThought(thought) {
  const width = Math.max(getCols(), 70);
  console.log(C.darkDim('  ╭─ ') + C.amber('🧠 Cognitive Pulse ') + C.darkDim('─'.repeat(Math.max(0, width - 24))));
  thought.split('\n').forEach(line => {
    console.log(C.darkDim('  │ ') + C.dim(line));
  });
  console.log(C.darkDim('  ╰─' + '─'.repeat(Math.max(0, width - 8))));
  console.log();
}

// Render tool execution card
function printToolExecution(tool) {
  const width = Math.max(getCols(), 70);
  const toolName = tool.name || (tool.command ? 'terminal' : 'tool');
  const details = tool.command || (tool.args ? JSON.stringify(tool.args) : '');
  console.log(C.darkDim('  ╭─ ') + C.purple(`⚡ Tool: ${toolName} `) + C.darkDim('─'.repeat(Math.max(0, width - toolName.length - 17))));
  if (details) {
    console.log(C.darkDim('  │ ') + C.dim('Args: ') + C.cyan(C.bold(details)));
  }
  
  if (tool.result) {
    const out = tool.result.output || (tool.result.error ? C.red(tool.result.error) : JSON.stringify(tool.result));
    const lines = String(out).trim().split('\n').slice(0, 8);
    console.log(C.darkDim('  │ ') + C.dim('Output:'));
    lines.forEach(l => console.log(C.darkDim('  │   ') + C.dim(l)));
  }

  const duration = tool.durationMs !== undefined ? ` in ${tool.durationMs}ms` : '';
  console.log(C.darkDim('  │ ') + C.green(`✔ Success${duration}`));
  console.log(C.darkDim('  ╰─' + '─'.repeat(Math.max(0, width - 8))));
  console.log();
}

// Render agent answer
function printAgentResponse(agent, responseData) {
  const isString = typeof responseData === 'string';
  const text = isString ? responseData : responseData.response || '';
  const trace = (!isString && responseData.trace) || [];
  const durationMs = (!isString && responseData.durationMs) || null;
  const iterations = (!isString && responseData.iterations) || null;

  // Print execution traces (thoughts & tool calls)
  for (const step of trace) {
    if (step.type === 'thought' && step.content) {
      printThought(step.content);
    } else if (step.type === 'tool') {
      printToolExecution(step);
    }
  }

  // Header for agent response
  console.log('  ' + C.badgeCyan(agent.toUpperCase()) + ' ' + C.dim(new Date().toTimeString().slice(0, 8)));
  console.log();
  console.log(formatMarkdown(text));
  console.log();

  // Metrics footer
  const stats = [];
  if (durationMs) stats.push(`took ${(durationMs / 1000).toFixed(1)}s`);
  if (iterations) stats.push(`${iterations} iteration${iterations > 1 ? 's' : ''}`);
  if (stats.length) {
    console.log('  ' + C.darkDim(`[${stats.join(' · ')}]`));
    console.log();
  }
}

// Launch the interactive Agy Terminal session
function startAgySession({ agent, port, ask, commands, getAgentInfo }) {
  let activeAgent = agent || 'dev-bot';
  let activeModel = 'glm-5.3-flash:cloud';
  let isOnline = true;

  // Load config details if available
  try {
    const configPath = path.resolve(process.cwd(), process.env.LIBER_CONFIG || 'liber.yaml');
    if (fs.existsSync(configPath)) {
      const yaml = require('js-yaml');
      const doc = yaml.load(fs.readFileSync(configPath, 'utf8'));
      if (doc?.agent?.name) activeAgent = doc.agent.name;
      if (doc?.agent?.engine?.model) activeModel = doc.agent.engine.model;
    }
  } catch { /* use defaults */ }

  printAgyBanner({ agent: activeAgent, model: activeModel, port, online: isOnline });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let isBusy = false;
  let messageCount = 0;

  function renderPrompt() {
    const promptText = `\n${C.darkDim('╭─')} ${C.sky(C.bold(activeAgent))} ${C.darkDim('·')} ${C.darkDim('~/Liber')}\n${C.darkDim('╰─')}${C.green(C.bold('❯'))} `;
    rl.setPrompt(promptText);
    rl.prompt(true);
  }

  // Help command display
  function showHelp() {
    const width = Math.max(getCols(), 70);
    console.log();
    console.log(C.darkDim('  ╭─ ') + C.cyan(C.bold('AVAILABLE COMMANDS')) + ' ' + C.darkDim('─'.repeat(Math.max(0, width - 26))));
    const list = [
      ['/help', 'Display this command reference'],
      ['/status, /ps', 'Show real-time agent metrics and health'],
      ['/tools', 'List registered tool capabilities'],
      ['/model', 'Inspect active LLM engine & parameters'],
      ['/logs [n]', 'View recent telemetry events from liber.log'],
      ['/clear', 'Clear screen and refresh Agy banner'],
      ['/tui', 'Launch the blessed dashboard interface'],
      ['/exit, /quit', 'Exit the LiBER Terminal'],
    ];

    list.forEach(([cmd, desc]) => {
      console.log('  ' + C.darkDim('│ ') + C.sky(cmd.padEnd(16)) + C.dim(desc));
    });
    console.log(C.darkDim('  ╰─' + '─'.repeat(Math.max(0, width - 8))));
    console.log();
  }

  rl.on('line', async (line) => {
    if (isBusy) return;
    const input = line.trim();
    if (!input) {
      renderPrompt();
      return;
    }

    // Handle slash commands
    if (input.startsWith('/')) {
      const parts = input.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ');

      if (cmd === 'exit' || cmd === 'quit') {
        console.log(C.dim('\n  Goodbye from Liber. 👋\n'));
        process.exit(0);
      }

      if (cmd === 'clear') {
        console.clear();
        printAgyBanner({ agent: activeAgent, model: activeModel, port, online: isOnline });
        renderPrompt();
        return;
      }

      if (cmd === 'help') {
        showHelp();
        renderPrompt();
        return;
      }

      if (cmd === 'tui') {
        console.log(C.cyan('\n  Launching Tactical Cyber-Obsidian TUI Dashboard...\n'));
        const { spawn } = require('child_process');
        const pythonTui = path.join(__dirname, '..', '..', 'bin', 'liber-tui.py');
        if (fs.existsSync(pythonTui)) {
          spawn('python', [pythonTui], { stdio: 'inherit' });
        } else {
          spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'liber-tui')], { stdio: 'inherit' });
        }
        return;
      }

      if (commands && commands[cmd]) {
        try {
          const res = await commands[cmd](arg);
          if (res) console.log(res);
        } catch (err) {
          console.log(`  ${C.red('✖ Error:')} ${err.message}`);
        }
        renderPrompt();
        return;
      }

      console.log(`  ${C.red('✖ Unknown command:')} ${C.dim(input)}. Type ${C.cyan('/help')} for list.`);
      renderPrompt();
      return;
    }

    // Regular conversation input
    isBusy = true;
    console.log();
    const spinner = startSpinner('Cognitive Pulse thinking...');

    try {
      const data = await ask(input);
      spinner.stop();
      messageCount++;
      printAgentResponse(activeAgent, data);
    } catch (err) {
      spinner.stop();
      console.log(`  ${C.red('✖ Error:')} ${err.message}\n`);
    }

    isBusy = false;
    renderPrompt();
  });

  rl.on('SIGINT', () => {
    console.log(C.dim('\n\n  Exiting Liber. Bye! 👋\n'));
    process.exit(0);
  });

  rl.on('close', () => {
    console.log(C.dim('\n  Session closed.\n'));
    process.exit(0);
  });

  renderPrompt();
}

module.exports = {
  startAgySession,
  printAgyBanner,
  formatMarkdown,
  printAgentResponse,
  C
};
