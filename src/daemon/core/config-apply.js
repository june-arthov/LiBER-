// src/daemon/core/config-apply.js — whitelisted live config updates.
// Every key a client may change is declared here with a type; anything else is
// rejected. Persistence patches only the targeted YAML lines, comments intact.
const PROVIDERS = new Set(['openai', 'ollama', 'anthropic', 'gemini']);
const TERMINAL_MODES = new Set(['read_only', 'allowlist', 'prompt', 'open']);
const REASONING_EFFORTS = new Set(['auto', 'low', 'medium', 'high']);
const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,64}$/;

const SCHEMA = {
  'engine.provider': { kind: 'enum', values: PROVIDERS },
  'engine.model': { kind: 'model' },
  'engine.endpoint': { kind: 'endpoint' },
  'engine.context_window_override': { kind: 'int', min: 0, max: 1_048_576 },
  'engine.reasoning_effort': { kind: 'enum', values: REASONING_EFFORTS },
  'engine.max_tokens': { kind: 'int', min: 0, max: 1_048_576 },
  'engine.temperature': { kind: 'float', min: 0, max: 2 },
  'engine.fallback_models': { kind: 'string_list' },
  'engine.top_p': { kind: 'float', min: 0, max: 1 },
  'grounding.enabled': { kind: 'boolean' },
  'grounding.max_repairs': { kind: 'int', min: 0, max: 5 },
  'grounding.require_readback': { kind: 'boolean' },
  'grounding.require_citations': { kind: 'boolean' },
  'grounding.semantic_verifier': { kind: 'boolean' },
  'policy.write_roots': { kind: 'string_list' },
  'policy.terminal.mode': { kind: 'enum', values: TERMINAL_MODES },
  'policy.terminal.allowlist': { kind: 'string_list' },
  'policy.terminal.denylist': { kind: 'string_list' },
  'policy.terminal.backend': { kind: 'enum', values: new Set(['powershell', 'docker']) },
  'policy.terminal.image': { kind: 'string' },
  'policy.terminal.allow_network': { kind: 'boolean' },
  'limits.max_tokens_per_day': { kind: 'int', min: 0 },
  'limits.max_cost_per_day': { kind: 'float', min: 0 },
  'limits.circuit_breaker.max_loops': { kind: 'int', min: 1, max: 100 },
  'memory.window_size': { kind: 'int', min: 1, max: 200 },
  'memory.persist': { kind: 'boolean' },
  'telemetry.trace': { kind: 'boolean' }
};

function validateConfigUpdate(body) {
  if (!body || typeof body !== 'object') return { error: 'Missing request body.' };
  const changes = {};
  for (const [path, value] of Object.entries(body)) {
    const spec = SCHEMA[path];
    if (!spec) return { error: `Unknown config key '${path}'.` };
    switch (spec.kind) {
      case 'boolean':
        if (typeof value !== 'boolean') return { error: `'${path}' must be a boolean.` };
        break;
      case 'int': {
        const n = Number(value);
        if (!Number.isInteger(n)) return { error: `'${path}' must be an integer.` };
        if (n < spec.min || n > spec.max) return { error: `'${path}' must be within ${spec.min}..${spec.max}.` };
        changes[path] = n;
        continue;
      }
      case 'float': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return { error: `'${path}' must be a non-negative number.` };
        changes[path] = n;
        continue;
      }
      case 'enum':
        if (!spec.values.has(String(value))) return { error: `'${path}' must be one of: ${[...spec.values].join(', ')}.` };
        break;
      case 'model':
        if (!MODEL_RE.test(String(value || ''))) return { error: `'${path}' has an invalid model name.` };
        break;
      case 'endpoint':
        if (value !== '' && value != null && !/^https?:\/\/\S+$/.test(String(value))) {
          return { error: `'${path}' must be a valid URL.` };
        }
        break;
      case 'string_list':
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
          return { error: `'${path}' must be an array of strings.` };
        }
        break;
    }
    changes[path] = value;
  }
  return { changes };
}

function yamlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(v => JSON.stringify(v)).join(', ')}]`;
  return JSON.stringify(value);
}

/**
 * Patch one dotted key (a.b.c) in liber.yaml text, keeping every comment and
 * every other line. Returns the text unchanged when the path does not exist.
 */
function patchYamlKey(text, path, value) {
  const lines = String(text || '').split(/\r?\n/);
  const parts = String(path).split('.');
  let pos = 0;
  let depth = 0;

  for (const parent of parts.slice(0, -1)) {
    let found = -1;
    for (let i = pos; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/);
      if (m && m[2] === parent && m[1].length === depth) { found = i; break; }
    }
    if (found < 0) return text;
    pos = found + 1;
    depth += 2;
  }

  const last = parts[parts.length - 1];
  for (let i = pos; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    if (m[1].length < depth) break;
    if (m[2] === last && m[1].length === depth) {
      const comment = m[3].match(/\s*(#.*)$/);
      const trail = comment ? ` ${comment[1]}` : '';
      lines[i] = `${m[1]}${last}: ${yamlValue(value)}${trail}`;
      return lines.join('\n');
    }
  }

  // The key does not exist yet: a setting the UI can change must be persistable,
  // otherwise it silently disappears at the next daemon start. Insert it at the
  // end of its parent block, matching that block's indentation.
  if (depth > 0) {
    let insertAt = pos;
    for (let i = pos; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)([A-Za-z_][\w-]*):/);
      if (m && m[1].length < depth) break;
      if (String(lines[i]).trim()) insertAt = i + 1;
    }
    const pad = ' '.repeat(depth);
    lines.splice(insertAt, 0, `${pad}${last}: ${yamlValue(value)}`);
    return lines.join('\n');
  }
  return text;
}

function patchYamlKeys(text, changes) {
  let out = String(text || '');
  for (const [path, value] of Object.entries(changes)) {
    out = patchYamlKey(out, path, value);
  }
  return out;
}

/** Public view: the full effective grounding config, live. */
function sanitizeConfig(config, traceEnabled, cwd) {
  const engine = config?.engine || {};
  return {
    agent: { name: config?.name || null, version: config?.version || null },
    engine: {
      provider: engine.provider || null,
      model: engine.model || null,
      endpoint: engine.endpoint || null,
      context_window: engine.context_window || 32000,
      context_window_override: engine.context_window_override || 0,
      fallback_models: Array.isArray(engine.fallback_models) ? engine.fallback_models.slice(0, 8) : [],
      reasoning_effort: engine.reasoning_effort || 'auto',
      max_tokens: engine.max_tokens || null,
      temperature: engine.temperature ?? null,
      top_p: engine.top_p ?? null
    },
    grounding: { ...(config?.grounding || {}) },
    policy: sanitizePolicy(),
    limits: { ...(config?.limits || {}) },
    memory: { ...(config?.memory || {}) },
    telemetry: { trace: !!traceEnabled },
    cwd
  };
}

function sanitizePolicy() {
  try {
    const policy = require('./policy');
    const cur = policy.current();
    return {
      write_roots: cur.write_roots,
      allow_outside_workspace: cur.allow_outside_workspace,
      terminal: policy.terminalConfig()
    };
  } catch {
    return null;
  }
}

module.exports = { SCHEMA, validateConfigUpdate, patchYamlKey, patchYamlKeys, sanitizeConfig, sanitizePolicy, defaults };

/** "Reset to defaults": the values this build ships with. */
const DEFAULTS = {
  'engine.reasoning_effort': 'auto',
  'engine.max_tokens': 4096,
  'engine.temperature': 0.2,
  'engine.fallback_models': [],
  'engine.top_p': 1,
  'engine.context_window_override': 0,
  'grounding.enabled': true,
  'grounding.max_repairs': 2,
  'grounding.require_readback': true,
  'grounding.require_citations': true,
  'grounding.semantic_verifier': true,
  'policy.terminal.mode': 'allowlist',
  'policy.terminal.allowlist': ['npm test', 'node --test', 'git status', 'git diff', 'git add', 'git commit', 'git push'],
  'policy.terminal.denylist': [],
  'policy.terminal.backend': 'docker',
  'policy.terminal.image': 'alpine:latest',
  'policy.terminal.allow_network': false,
  'policy.write_roots': ['.'],
  'limits.max_tokens_per_day': 2000000,
  'limits.max_cost_per_day': 1,
  'limits.circuit_breaker.max_loops': 12,
  'memory.window_size': 20,
  'memory.persist': true,
  'telemetry.trace': true
};

function defaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}
