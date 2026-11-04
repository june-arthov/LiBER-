// src/daemon/core/tools/terminal-tool.js — Liber Terminal Execution Engine
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
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

// Redirection and command substitution can write or execute whatever they
// produce, so no prefix entry can cover them: they are refused outright.
const REDIRECT_OR_SUBST = /(^|[^|])(>>?|<)|\$\(|`/;

/**
 * Remove the redirects that write nothing: merging stderr into stdout (`2>&1`)
 * and discarding to the null device. `npm test 2>&1 | tail -20` is a normal
 * daily command; refusing it taught the model to avoid piping output, which is
 * worse than the redirect itself. Real file redirects stay in and stay blocked.
 */
function stripBenignRedirects(command) {
  return String(command || '')
    .replace(/\d*>&\d+/g, ' ')
    .replace(/\d*>>?\s*(\/dev\/null|nul)\b/gi, ' ');
}

// Commands that only read. Listing a directory is not a privilege escalation,
// and a model that cannot even look at the tree burns its whole loop budget on
// denials (that is exactly what happened: three refused listings in one turn).
const READ_ONLY_PREFIXES = [
  'ls', 'dir', 'pwd', 'cd', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'rg',
  'stat', 'file', 'du', 'df', 'date', 'whoami', 'hostname', 'uname', 'echo', 'printenv',
  'git status', 'git log', 'git diff', 'git show', 'git rev-parse', 'git ls-files',
  'git remote -v', 'git remote show', 'git blame',
  'node --version', 'node -v', 'npm --version', 'npx --version', 'tsc --version',
  'python --version', 'py --version',
  'get-childitem', 'get-location', 'get-content', 'get-item', 'get-command',
  'test-path', 'resolve-path', 'select-object', 'select-string', 'where-object',
  'sort-object', 'measure-object', 'format-table', 'format-list', 'write-output',
  'out-string', 'get-process', 'get-date', 'get-host'
];

/**
 * Split a command into the stages a shell would actually run. Quotes are
 * respected so `echo "a | b"` stays one stage.
 */
function splitSegments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  const s = String(command || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ';' || c === '\n') { out.push(cur); cur = ''; continue; }
    if (c === '&' && s[i + 1] === '&') { out.push(cur); cur = ''; i++; continue; }
    if (c === '|' && s[i + 1] === '|') { out.push(cur); cur = ''; i++; continue; }
    if (c === '|' || c === '&') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

const isReadOnly = seg => matchesAllowEntry(READ_ONLY_PREFIXES, String(seg).trim().toLowerCase());

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
/** What the caller may run instead of hunting for a permitted spelling. */
function allowedHint(allowlist) {
  const list = [...allowlist.map(String), ...READ_ONLY_PREFIXES.slice(0, 12)];
  return list.filter(Boolean).slice(0, 24);
}

function evaluatePolicy(command, opts = {}) {
  const raw = String(command || '').trim();
  // Judge the command without the redirects that cannot write; splitting on the
  // raw string would also cut `2>&1` at the ampersand and invent a bad stage.
  const cmd = stripBenignRedirects(raw);
  const term = policy.terminalConfig();
  const lower = raw.toLowerCase();
  const segments = splitSegments(cmd);

  for (const pattern of term.denylist) {
    const p = String(pattern || '').trim().toLowerCase();
    if (!p) continue;
    const afterChain = CHAIN.test(cmd) && lower.includes(p);
    if (lower.startsWith(p) || afterChain || segments.some(seg => seg.toLowerCase().startsWith(p))) {
      return {
        denied: true,
        reason: `Command blocked by policy.terminal.denylist ('${pattern}'). A denylist entry cannot be approved away.`
      };
    }
  }

  // Human approval overrides the *mode* gate (prompt/allowlist/read_only) only,
  // never the denylist above.
  if (opts.approved === true) return { denied: false, approved: true };

  if (term.mode === 'open') return { denied: false };

  const redirect = REDIRECT_OR_SUBST.test(cmd);
  const hint = allowedHint(term.allowlist);

  // A stage is covered if an allowlist entry covers it, or if it only reads.
  const coveredSegments = redirect
    ? [] // redirection invalidates every stage: it writes or substitutes
    : segments.filter(seg => matchesAllowEntry(term.allowlist, seg.toLowerCase()) || isReadOnly(seg));
  const uncovered = redirect ? [cmd] : segments.filter(seg => !matchesAllowEntry(term.allowlist, seg.toLowerCase()) && !isReadOnly(seg));

  if (term.mode === 'allowlist') {
    if (redirect) {
      return {
        denied: true,
        reason: "Blocked: redirection (>, >>, <) and command substitution ($( ), backticks) are never covered by a prefix allowlist. Run the command without them, or ask the operator to widen policy.terminal.mode.",
        allowed_prefixes: hint
      };
    }
    if (uncovered.length) {
      return {
        denied: true,
        reason: `Command stage not allowed (mode 'allowlist'): '${uncovered[0].slice(0, 80)}'. Read-only inventory commands are always allowed (ls, dir, Get-ChildItem, cat, git log, …); pipelines are judged stage by stage. Allowed prefixes: ${hint.slice(0, 12).join(', ')}.`,
        allowed_prefixes: hint
      };
    }
    return { denied: false };
  }

  if (term.mode === 'prompt') {
    // Fail closed, and say a human could approve: the engine escalates on
    // needs_approval and re-dispatches with meta.approved.
    if (!redirect && coveredSegments.length === segments.length) return { denied: false };
    return {
      denied: true,
      needs_approval: true,
      reason: "Terminal mode 'prompt' needs human approval for commands that change state or redirect output. Read-only listing/reading is allowed without asking.",
      allowed_prefixes: hint
    };
  }

  if (term.mode === 'read_only' && MUTATION_PATTERNS.some(pattern => pattern.test(cmd))) {
    const allowlisted = !redirect && segments.length > 0 &&
      segments.every(seg => matchesAllowEntry(term.allowlist, seg.toLowerCase()));
    if (!allowlisted) {
      return {
        denied: true,
        reason: 'Command changes project/system state, blocked by read-only terminal policy. Allowlist it in liber.yaml or ask the operator to switch policy.terminal.mode.',
        allowed_prefixes: hint
      };
    }
  }

  return { denied: false };
}

/**
 * Sandbox profile.
 *
 * This is not a container. On Windows it runs the command in PowerShell
 * Constrained Language Mode, which refuses the .NET/COM surface that most
 * script-based escapes need ([System.IO.File]::WriteAllText, Add-Type,
 * reflection), and it hands the child a minimal environment so provider keys and
 * tokens are not inherited. With the prefix policy and a fixed cwd, that removes
 * the easiest ways a command walks out of the workspace.
 */
function sandboxPolicy() {
  const term = policy.terminalConfig();
  const requested = term.sandbox !== false;
  const supported = process.platform === 'win32';
  return { on: requested && supported, requested, supported };
}

/** Minimal environment: nothing secret is inherited by the child. */
function sandboxEnv() {
  const keep = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

function auditTerminal(entry) {
  try {
    const dir = path.resolve(process.cwd(), '.liber');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'terminal-audit.log'),
      new Date().toISOString() + ' ' + JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* auditing must never block a command */ }
}

/**
 * A real container, for when the language-mode sandbox is not enough.
 *
 * The command runs inside Docker with: no network, a read-only root filesystem,
 * a small tmpfs for /tmp, dropped capabilities, no-new-privileges, and a memory
 * and pid cap. The workspace is the only host path mounted, so the rest of the
 * machine — including the browser profile and SSH keys — is not reachable.
 */
function containerPolicy() {
  const term = policy.terminalConfig();
  const requested = term.backend === 'docker';
  const image = term.image || 'alpine:latest';
  const usable = requested ? containerUsable(false, image) : { ok: false, error: null };
  return {
    // A daemon that answers but cannot start a container would make every
    // command fail; treat "usable" as the condition, and say why otherwise.
    on: requested && usable.ok,
    requested,
    fallback_reason: requested && !usable.ok ? (usable.error || 'container runtime not usable') : null,
    image,
    network: term.allow_network === true,
    memory: term.memory || '512m',
    pids: Number(term.pids) || 128
  };
}

let _dockerCache = null;
/** Is a Docker daemon reachable? Cached for a minute; the check costs ~50ms. */
function containerAvailable(force = false) {
  if (!force && _dockerCache && Date.now() - _dockerCache.at < 60_000) return _dockerCache.ok;
  let ok = false;
  try {
    const out = require('child_process').execFileSync('docker', ['version', '--format', '{{.Server.Version}}'],
      { timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    ok = String(out).trim().length > 0;
  } catch { ok = false; }
  _dockerCache = { ok, at: Date.now() };
  return ok;
}

let _runCache = null;
/**
 * Can this machine actually START a container with the configured image?
 * A reachable daemon is not the same thing: a CI runner can have the CLI and a
 * server version and still refuse to run (no image, no permissions). Checking by
 * running is the only honest answer, and it is cached because it costs ~1s.
 */
function containerUsable(force = false, image = 'alpine:latest') {
  if (!force && _runCache && _runCache.image === image && Date.now() - _runCache.at < 300_000) return _runCache;
  if (!containerAvailable(force)) {
    _runCache = { ok: false, image, at: Date.now(), error: 'docker daemon not reachable' };
    return _runCache;
  }
  let ok = false;
  let error = null;
  try {
    require('child_process').execFileSync('docker', ['run', '--rm', '--network', 'none', image, 'true'],
      { timeout: 60000, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    ok = true;
  } catch (e) {
    error = String(e.stderr || e.message || 'container run failed').slice(0, 200);
  }
  _runCache = { ok, image, at: Date.now(), error };
  return _runCache;
}

function runContainer(command, { cwd, timeout, profile }) {
  const { execFile } = require('child_process');
  const mount = `${path.resolve(process.cwd())}:/work:rw`;
  // On POSIX hosts run as the invoking user: files the container writes land
  // owned by them instead of root, which is both safer and the only way a write
  // into the mount works under a rootless daemon.
  const asUser = process.platform !== 'win32' && typeof process.getuid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : [];
  const args = [
    'run', '--rm', '--interactive',
    ...(profile.network ? ['--network', 'bridge'] : ['--network', 'none']),
    ...asUser,
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--memory', profile.memory,
    '--pids-limit', String(profile.pids),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '-v', mount,
    '-w', '/work',
    profile.image,
    'sh', '-lc', command
  ];
  return new Promise((resolve) => {
    execFile('docker', args, { timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

/**
 * Run under Constrained Language Mode via a throwaway script file. A file avoids
 * every quoting trap that inline -Command has with quotes and $ signs.
 */
function runSandboxed(command, { cwd, timeout }) {
  const { execFile } = require('child_process');
  const tmpDir = path.resolve(process.cwd(), '.liber', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const script = path.join(tmpDir, 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.ps1');
  fs.writeFileSync(script,
    "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n" +
    "$ErrorActionPreference = 'Continue'\n" +
    command + '\n', 'utf8');

  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { cwd, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true, env: sandboxEnv() },
      (error, stdout, stderr) => {
        try { fs.unlinkSync(script); } catch { }
        resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
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
      allowed_prefixes: decision.allowed_prefixes || null,
      command
    };
  }

  const startTime = Date.now();
  const isWindows = process.platform === 'win32';
  const shellOption = isWindows ? 'powershell.exe' : '/bin/bash';
  const sandbox = sandboxPolicy();
  const container = containerPolicy();
  const backend = container.on ? 'docker' : (sandbox.on ? 'constrained-language' : 'none');
  auditTerminal({ decision: 'allow', command, cwd, sandbox: backend });

  const finish = (error, stdout, stderr) => {
    const durationMs = Date.now() - startTime;
    const outStr = String(stdout || '').trim();
    const errStr = String(stderr || '').trim();
    const MAX_OUTPUT = 15000;
    let truncated = false;
    let finalOut = outStr;
    if (finalOut.length > MAX_OUTPUT) {
      finalOut = finalOut.slice(0, MAX_OUTPUT) + `\n... [TRUNCATED: Output exceeded ${MAX_OUTPUT} characters]`;
      truncated = true;
    }
    const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
    auditTerminal({ decision: 'run', command, exit_code: exitCode, duration_ms: durationMs, sandbox: backend });
    if (error) {
      return {
        command,
        exit_code: exitCode,
        output: finalOut,
        error: errStr || error.message,
        duration_ms: durationMs,
        truncated,
        sandboxed: backend !== 'none',
        backend
      };
    }
    // stderr is not noise: a blocked call explains itself there and nowhere else
    const withErr = errStr
      ? (finalOut ? finalOut + "\n[stderr] " + errStr : "[stderr] " + errStr)
      : finalOut;
    return {
      command,
      exit_code: 0,
      output: withErr || '(command succeeded with no output)',
      duration_ms: durationMs,
      truncated,
      sandboxed: backend !== 'none',
      backend
    };
  };

  if (container.on) {
    const { error, stdout, stderr } = await runContainer(command, {
      cwd,
      timeout: parseInt(timeout, 10) || 45000,
      profile: container
    });
    return finish(error, stdout, stderr);
  }

  if (sandbox.on) {
    const { error, stdout, stderr } = await runSandboxed(command, {
      cwd,
      timeout: parseInt(timeout, 10) || 45000
    });
    return finish(error, stdout, stderr);
  }

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
      (error, stdout, stderr) => resolve(finish(error, stdout, stderr))
    );
  });
}

module.exports = {
  runTerminal,
  isCommandSensitive,
  evaluatePolicy,
  sandboxPolicy,
  sandboxEnv,
  containerPolicy,
  containerAvailable,
  containerUsable
};
