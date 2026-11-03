// src/daemon/core/tools/terminal-tool.js — Merlin Terminal Execution Engine
const { exec } = require('child_process');
const path = require('path');

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
  /\bgit\s+reset\s+--hard\b/i
];

function isCommandSensitive(command) {
  if (!command) return false;
  return DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(command));
}

async function runTerminal({ command, timeout = 45000, cwd = process.cwd() }) {
  if (!command || typeof command !== 'string') {
    return { error: "Missing or invalid command argument." };
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
  isCommandSensitive
};
