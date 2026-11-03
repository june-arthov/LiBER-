// src/daemon/core/model-switch.js — validation + persistence for live model/provider switching.
const PROVIDERS = new Set(['openai', 'ollama', 'anthropic', 'gemini']);
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,64}$/;

function validateSwitch(body) {
  if (!body || typeof body !== 'object') {
    return { error: "Missing request body." };
  }
  const errors = [];

  const model = String(body.model ?? '').trim();
  if (!model) errors.push("Missing 'model' parameter.");
  else if (!MODEL_RE.test(model)) errors.push('Invalid model name.');

  let provider = null;
  if (body.provider != null && body.provider !== '') {
    provider = String(body.provider).toLowerCase();
    if (!PROVIDERS.has(provider)) errors.push(`Unknown provider '${body.provider}'.`);
  }

  let endpoint = null;
  if (body.endpoint != null && body.endpoint !== '') {
    endpoint = String(body.endpoint).trim();
    if (!/^https?:\/\/\S+$/.test(endpoint)) errors.push('Invalid endpoint URL.');
  }

  if (errors.length) return { error: errors.join(' ') };
  return { model, provider, endpoint };
}

/**
 * Patch only the engine keys in liber.yaml, preserving every comment and
 * every other line. Never rewrites the file through a YAML round-trip.
 */
function patchEngineYaml(text, changes) {
  let out = String(text || '');
  const patchKey = (key, value) => {
    if (value == null || value === '') return;
    const re = new RegExp(`^(\\s*${key}:\\s*)(["']?[^"'\\n#]*["']?)`, 'm');
    out = out.replace(re, `$1${JSON.stringify(String(value))}`);
  };
  patchKey('provider', changes.provider);
  patchKey('model', changes.model);
  patchKey('endpoint', changes.endpoint);
  return out;
}

/** Public engine view: never exposes credentials. */
function sanitizeEngine(engine) {
  const e = engine || {};
  return {
    provider: e.provider || null,
    model: e.model || null,
    endpoint: e.endpoint || null
  };
}

module.exports = { validateSwitch, patchEngineYaml, sanitizeEngine, PROVIDERS };
