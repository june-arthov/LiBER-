// src/daemon/core/tools/terminal-tool.js — Merlin Terminal Execution Engine
const { exec } = require('child_process');
const path = require('path');
const policy = require('../policy');

// Destructive patterns that strictly require Human-In-The-Loop approval
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-rf?|-fr?)/i,
  /\bdel\s+(\/s|\/f|\/q)/i,
  /\brmdir\s+\/s/i,
  /\bformat\b/i,
  /\bdrop\s+(database|table)\b/i,
  /\btruncate\s+table\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkill\s+-9\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\b/i,
  /\bdiskpart\b/i,
  /\breg\s+(add|delete|import)\b/i,
  /\bbcdedit\b/i,
  /\bnetsh\b/i,
  /\bcurl[^\n|]*\|\s*(sh|bash|powershell|pwsh)\b/i,
  /\bwget[^\n|]*\|\s*(sh|bash)\b/i
];

// Commands that change system/project state — blocked in read_only mode unless allowlisted
const MUTATION_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade|init|publish|login|logout|link|unlink|ci)\b/i,
  /\b(pip|pip3|python\s+-m\s+pip)\s+(install|uninstall|upgrade)\b/i,
  /\b(cargo|go)\s+(install|add|update)\b/i,
  /\bgit\s+(commit|push|checkout|reset|rebase|merge|branch|tag|clean|revert|cherry-pick|rm|add)\b/i,
  /\b(rm|del|erase|rmdir|mv|move|ren|rename|cp|copy|scp|rsync)\b/i,
  /\b(set-content|out-file|add-content|new-item|remove-item|move-item|copy-item|rename-item|set-item)\b/i,
  /\b(chmod|chown|sudo)\b/i,
  /\b(format|diskpart|reg|bcdedit|netsh|schtasks|sc\s)\b/i,
  />>\s*\S/,
  /(^|[\s])>\s*\S/,
  /\b(tee|clip)\b/i
];

function isCommandSensitive(command) {
  if (!command) return false;
  return DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(command));
}

/**
 * Terminal policy: denylist always wins; allowlist mode requires a prefix;
 * read_only blocks state-changing commands.
 */
function evaluatePolicy(command) {
  const cmd = String(command || '').trim();
  const term = policy.terminalConfig();
  const lower = cmd.toLowerCase();

  for (const pattern of term.denylist) {
    if (pattern && lower.startsWith(String(pattern).toLowerCase())) {
      return {
        denied: true,
        reason: `Command blocked by policy.terminal.denylist ('${pattern}').`
      };
    }
  }

  if (term.mode === 'allowlist') {
    const ok = term.allowlist.some(p => p && lower.startsWith(String(p).toLowerCase()));
    if (!ok) {
      return {
        denied: true,
        reason: `Command not in policy.terminal.allowlist (mode 'allowlist').`
      };
    }
    return { denied: false };
  }

  if (term.mode === 'read_only' && MUTATION_PATTERNS.some(pattern => pattern.test(cmd))) {
    const allowed = term.allowlist.some(p => p && lower.startsWith(String(p).toLowerCase()));
    if (!allowed) {
      return {
        denied: true,
        reason: 'Command changes project/system state, blocked by read-only terminal policy. Allowlist it in liber.yaml or ask the operator to switch policy.terminal.mode.'
      };
    }
  }

  return { denied: false };
}

async function runTerminal({ command, timeout = 45000, cwd = process.cwd() }) {
  if (!command || typeof command !== 'string') {
    return { error: "Missing or invalid command argument." };
  }

  const decision = evaluatePolicy(command);
  if (decision.denied) {
    return { error: decision.reason, policy_denied: true, command };
  }

  const startTime = Date.now();
  const isWindows = process.platform === 'win32';
  const shellOption = isWindows ? 'powershell.exe' : '/bin/bash';

  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: parseInt(timeout, 10) || 45000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        shell: shellOption,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime;
        const outStr = (stdout || '').trim();
        const errStr = (stderr || '').trim();

        // Safe truncation to avoid blowing LLM context (cap at 15,000 characters)
        const MAX_OUTPUT = 15000;
        let truncated = false;
        let finalOut = outStr;

        if (finalOut.length > MAX_OUTPUT) {
          finalOut = finalOut.slice(0, MAX_OUTPUT) + `\n... [TRUNCATED: Output exceeded ${MAX_OUTPUT} characters]`;
          truncated = true;
        }

        if (error) {
          resolve({
            command,
            exit_code: error.code || 1,
            output: finalOut,
            error: errStr || error.message,
            duration_ms: durationMs,
            truncated
          });
        } else {
          resolve({
            command,
            exit_code: 0,
            output: finalOut || (errStr ? `[stderr] ${errStr}` : '(command succeeded with no output)'),
            duration_ms: durationMs,
            truncated
          });
        }
      }
    );
  });
}

module.exports = {
  runTerminal,
  isCommandSensitive,
  evaluatePolicy
};
