// src/daemon/core/tools/terminal-tool.js — Liber Terminal Execution Engine
const { exec } = require('child_process');
const path = require('path');
const policy = require('../policy');

// Destructive patterns that strictly require Human-In-The-Loop approval
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-rf?|-fr?)/i,
  /\bdel\s+(\/s|\/f|\/q)/i,
  /\brmdir\s+\/s/i,
  /\bformat\s+\S/i,
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
  /\b(format\s+\S|diskpart|reg|bcdedit|netsh|schtasks|sc\s)/i,
  />>\s*\S/,
  /(^|[\s])>\s*\S/,
  /\b(tee|clip)\b/i
];

function isCommandSensitive(command) {
  if (!command) return false;
  return DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(command));
}

// Characters that turn one command into several. A prefix match that runs past
// one of these is not a prefix match any more — it is a different command.
const CHAIN = /[;&|`<>]|\$\(/;

/**
 * Does `command` start with an allowlist entry and stay *inside* that entry?
 * 'git status -s' matches 'git status'; 'git status; rm -rf /' does not.
 */
function matchesAllowEntry(list, lower) {
  for (const rawEntry of list) {
    const entry = String(rawEntry || '').trim().toLowerCase();
    if (!entry) continue;
    if (!lower.startsWith(entry)) continue;
    const rest = lower.slice(entry.length);
    if (rest !== '' && !/^\s/.test(rest)) continue; // 'git statusX' is not 'git status'
    if (CHAIN.test(rest)) continue;                 // 'git status; evil' is not 'git status'
    return true;
  }
  return false;
}

/**
 * Terminal policy: denylist always wins; allowlist mode requires a prefix;
 * read_only blocks state-changing commands; prompt fails closed and reports
 * that a human could approve (the engine escalates and re-dispatches).
 */
function evaluatePolicy(command, opts = {}) {
  const cmd = String(command || '').trim();
  const term = policy.terminalConfig();
  const lower = cmd.toLowerCase();

  for (const pattern of term.denylist) {
    const p = String(pattern || '').trim().toLowerCase();
    if (!p) continue;
    const afterChain = CHAIN.test(cmd) && lower.includes(p);
    if (lower.startsWith(p) || afterChain) {
      return {
        denied: true,
        reason: `Command blocked by policy.terminal.denylist ('${pattern}'). A denylist entry cannot be approved away.`
      };
    }
  }

  // Human approval overrides the *mode* gate (prompt/allowlist/read_only) only,
  // never the denylist above.
  if (opts.approved === true) return { denied: false, approved: true };

  if (term.mode === 'allowlist') {
    if (!matchesAllowEntry(term.allowlist, lower)) {
      return {
        denied: true,
        reason: `Command not in policy.terminal.allowlist (mode 'allowlist'). Chained operators are not covered by a prefix entry.`
      };
    }
    return { denied: false };
  }

  if (term.mode === 'open') {
    return { denied: false };
  }

  if (term.mode === 'prompt') {
    // Fail closed, and say a human could approve: the engine escalates on
    // needs_approval and re-dispatches with meta.approved.
    if (matchesAllowEntry(term.allowlist, lower)) return { denied: false };
    return {
      denied: true,
      needs_approval: true,
      reason: "Terminal mode 'prompt' needs human approval for unlisted commands. Allowlist the prefix for repeat use, or set policy.terminal.mode."
    };
  }

  if (term.mode === 'read_only' && MUTATION_PATTERNS.some(pattern => pattern.test(cmd))) {
    if (!matchesAllowEntry(term.allowlist, lower)) {
      return {
        denied: true,
        reason: 'Command changes project/system state, blocked by read-only terminal policy. Allowlist it in liber.yaml or ask the operator to switch policy.terminal.mode.'
      };
    }
  }

  return { denied: false };
}

async function runTerminal({ command, timeout = 45000, cwd = process.cwd() }, meta = {}) {
  if (!command || typeof command !== 'string') {
    return { error: "Missing or invalid command argument." };
  }

  const decision = evaluatePolicy(command, { approved: meta && meta.approved === true });
  if (decision.denied) {
    // Keep the escalation signal: a consumer (registry/engine) needs to know the
    // difference between "policy says no" and "policy says ask a human".
    return {
      error: decision.reason,
      policy_denied: true,
      needs_approval: decision.needs_approval === true,
      command
    };
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
