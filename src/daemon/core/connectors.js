// src/daemon/core/connectors.js — HTTP connectors as first-class tools.
//
// A connector is a small declaration: a base URL, headers, and a list of actions.
// Each one becomes a tool the agent can call, so "check my repo issues" does not
// mean driving a browser. Secrets stay in the vault: a header written as
// "vault:github.token" is resolved at call time and never enters the prompt.
const fs = require('fs');
const path = require('path');
const vault = require('./vault');

const FILE = () => path.resolve(process.env.LIBER_CONNECTORS_FILE || path.join(process.cwd(), '.liber', 'connectors.json'));
const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const MAX_BODY = 8000;

/** Read and validate the declaration file. Bad entries are reported, not used. */
function load() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return { connectors: [], problems: [] }; }
  const list = Array.isArray(raw) ? raw : (raw.connectors || []);
  const problems = [];
  const connectors = [];

  for (const c of list) {
    const id = String(c?.id || '');
    if (!ID_RE.test(id)) { problems.push(`id '${id}' must be lowercase letters, digits, _ or -`); continue; }
    let base;
    try { base = new URL(String(c.baseUrl || '')); } catch { problems.push(`${id}: baseUrl is not a URL`); continue; }
    if (!['http:', 'https:'].includes(base.protocol)) { problems.push(`${id}: baseUrl must be http(s)`); continue; }
    const actions = (c.actions || []).filter(a => a && a.name && a.path).map(a => ({
      name: String(a.name),
      method: String(a.method || 'GET').toUpperCase(),
      path: String(a.path),
      description: String(a.description || ''),
      params: a.params || null
    }));
    if (!actions.length) { problems.push(`${id}: no actions`); continue; }
    connectors.push({
      id,
      label: String(c.label || id),
      baseUrl: base.toString().replace(/\/$/, ''),
      headers: c.headers || {},
      actions
    });
  }
  return { connectors, problems };
}

function fillPath(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key];
    if (value === undefined || value === null) throw new Error(`missing parameter '${key}' for path '${template}'`);
    return encodeURIComponent(String(value));
  });
}

function resolveHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const value = vault.resolveRef(String(v));
    if (value) out[k] = value;
  }
  return out;
}

async function call(connector, actionName, args = {}) {
  const action = connector.actions.find(a => a.name === actionName);
  if (!action) return { error: `'${actionName}' is not an action of ${connector.id}. Known: ${connector.actions.map(a => a.name).join(', ')}` };

  const params = args.params || {};
  let url;
  try { url = new URL(connector.baseUrl + fillPath(action.path, params)); }
  catch (e) { return { error: e.message }; }

  const init = { method: action.method, headers: { accept: 'application/json', ...resolveHeaders(connector.headers) } };
  if (action.method === 'GET' || action.method === 'DELETE') {
    for (const [k, v] of Object.entries(params)) {
      if (!action.path.includes(`{${k}}`)) url.searchParams.set(k, String(v));
    }
  } else {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(args.body ?? params ?? {});
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    const clipped = typeof body === 'string' && body.length > MAX_BODY;
    return {
      connector: connector.id,
      action: action.name,
      status: res.status,
      ok: res.ok,
      body: clipped ? body.slice(0, MAX_BODY) + '\n… [truncated]' : body
    };
  } catch (e) {
    return { error: `${connector.id}/${action.name} failed: ${e.name === 'AbortError' ? 'timed out after 15s' : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Register one tool per connector, named conn_<id>. */
function install(registry) {
  const { connectors, problems } = load();
  const installed = [];
  for (const c of connectors) {
    const toolName = `conn_${c.id}`;
    registry.register({
      name: toolName,
      description: `${c.label} over HTTP. Actions: ${c.actions.map(a => `${a.name}${a.description ? ' (' + a.description + ')' : ''}`).join(' · ')}`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: c.actions.map(a => a.name), description: 'Which action to call' },
          params: { type: 'object', description: 'Path/query parameters, e.g. {"owner":"me","repo":"app"}' },
          body: { type: 'object', description: 'JSON body for POST/PATCH/PUT actions' }
        },
        required: ['action']
      },
      handler: async (args) => call(c, String(args.action || ''), args)
    });
    installed.push(toolName);
  }
  return { installed, problems };
}

module.exports = { load, call, install, fillPath, resolveHeaders, FILE };
