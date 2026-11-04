// src/daemon/core/policy.js — write-scope policy for file mutations.
// Terminal commands are NOT sandboxed; this governs the file tools only.
const path = require('path');

const DEFAULTS = {
  write_roots: ['.'],
  allow_outside_workspace: false,
  terminal: { mode: 'prompt', allowlist: [], denylist: [], backend: 'powershell', sandbox: true }
};

let config = { ...DEFAULTS };

function configure(policyConfig = {}) {
  config = {
    write_roots: Array.isArray(policyConfig.write_roots) && policyConfig.write_roots.length
      ? policyConfig.write_roots
      : DEFAULTS.write_roots,
    allow_outside_workspace: policyConfig.allow_outside_workspace === true,
    terminal: {
      mode: ['read_only', 'allowlist', 'prompt', 'open'].includes(policyConfig.terminal?.mode)
        ? policyConfig.terminal.mode
        : DEFAULTS.terminal.mode,
      allowlist: (policyConfig.terminal?.allowlist || []).map(String),
      denylist: (policyConfig.terminal?.denylist || []).map(String),
      // Execution surface: which sandbox runs the command, and its limits.
      backend: ['powershell', 'docker'].includes(policyConfig.terminal?.backend)
        ? policyConfig.terminal.backend
        : DEFAULTS.terminal.backend,
      sandbox: policyConfig.terminal?.sandbox !== false,
      image: String(policyConfig.terminal?.image || 'alpine:latest'),
      allow_network: policyConfig.terminal?.allow_network === true,
      memory: String(policyConfig.terminal?.memory || '512m'),
      pids: Number(policyConfig.terminal?.pids) || 128
    }
  };
  return config;
}

function current() {
  return { ...config };
}

function terminalConfig() {
  return { ...config.terminal, allowlist: [...config.terminal.allowlist], denylist: [...config.terminal.denylist] };
}

function normalize(p) {
  const slashed = String(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

function roots() {
  return config.write_roots.map(r => path.resolve(process.cwd(), r));
}

function inside(absPath, root) {
  const a = normalize(absPath);
  const r = normalize(root).replace(/\/+$/, '');
  return a === r || a.startsWith(r + '/');
}

/**
 * @returns {{allowed:boolean, abs:string, reason?:string}}
 */
function checkWrite(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { allowed: false, abs: '', reason: 'Missing or invalid file path.' };
  }

  const abs = path.resolve(process.cwd(), filePath);

  if (config.allow_outside_workspace) {
    return { allowed: true, abs };
  }

  const allowedRoots = roots();
  if (allowedRoots.some(root => inside(abs, root))) {
    return { allowed: true, abs };
  }

  const readableRoots = allowedRoots.map(r => path.relative(process.cwd(), r) || '.').join(', ');
  return {
    allowed: false,
    abs,
    reason:
      `Write denied: '${filePath}' resolves outside the workspace (${readableRoots}). ` +
      'Set policy.allow_outside_workspace: true in liber.yaml only if you intend to allow it.'
  };
}

function isOutsideWorkspace(filePath) {
  return !checkWrite(filePath).allowed;
}

module.exports = {
  configure,
  current,
  terminalConfig,
  checkWrite,
  isOutsideWorkspace,
  roots
};
