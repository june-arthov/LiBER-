// src/daemon/core/providers.js — provider catalog, credential store, live checks.
//
// Keys live in .liber/credentials.json (mode 0600). Nothing here ever returns a
// secret to a client: status() reports presence, source and a last-4 hint only.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const STORE = () => path.resolve(process.cwd(), '.liber', 'credentials.json');

/**
 * Environment values, including the project's .env file. The daemon resolves
 * keys from .env at boot, so the Providers page must report the same truth.
 */
let dotenvCache = null;
let dotenvMtime = 0;
function dotenv() {
  try {
    const file = path.resolve(process.cwd(), '.env');
    const st = fs.statSync(file);
    if (dotenvCache && st.mtimeMs === dotenvMtime) return dotenvCache;
    const map = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k) map[k] = v;
    }
    dotenvCache = map;
    dotenvMtime = st.mtimeMs;
    return map;
  } catch {
    dotenvCache = {};
    return dotenvCache;
  }
}

function envValue(name) {
  if (!name) return null;
  if (process.env[name]) return process.env[name];
  const v = dotenv()[name];
  return v || null;
}

/** adapter: how the daemon talks to it. kind: api | local | custom */
const CATALOG = [
  // — OpenAI-compatible cloud APIs
  { id: 'openai', label: 'OpenAI', adapter: 'openai', base: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', docs: 'platform.openai.com/api-keys', kind: 'api' },
  { id: 'anthropic', label: 'Anthropic', adapter: 'anthropic', base: 'https://api.anthropic.com', env: 'ANTHROPIC_API_KEY', docs: 'console.anthropic.com', kind: 'api' },
  { id: 'google', label: 'Google Gemini', adapter: 'gemini', base: 'https://generativelanguage.googleapis.com', env: 'GEMINI_API_KEY', docs: 'aistudio.google.com/apikey', kind: 'api' },
  { id: 'xai', label: 'xAI Grok', adapter: 'openai', base: 'https://api.x.ai/v1', env: 'XAI_API_KEY', docs: 'console.x.ai', kind: 'api' },
  { id: 'groq', label: 'Groq', adapter: 'openai', base: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', docs: 'console.groq.com/keys', kind: 'api' },
  { id: 'mistral', label: 'Mistral', adapter: 'openai', base: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY', docs: 'console.mistral.ai', kind: 'api' },
  { id: 'deepseek', label: 'DeepSeek', adapter: 'openai', base: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY', docs: 'platform.deepseek.com', kind: 'api' },
  { id: 'together', label: 'Together AI', adapter: 'openai', base: 'https://api.together.xyz/v1', env: 'TOGETHER_API_KEY', docs: 'api.together.ai/settings/api-keys', kind: 'api' },
  { id: 'openrouter', label: 'OpenRouter', adapter: 'openai', base: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', docs: 'openrouter.ai/keys', kind: 'api' },
  { id: 'fireworks', label: 'Fireworks AI', adapter: 'openai', base: 'https://api.fireworks.ai/inference/v1', env: 'FIREWORKS_API_KEY', docs: 'fireworks.ai/account/api-keys', kind: 'api' },
  { id: 'cerebras', label: 'Cerebras', adapter: 'openai', base: 'https://api.cerebras.ai/v1', env: 'CEREBRAS_API_KEY', docs: 'cloud.cerebras.ai', kind: 'api' },
  { id: 'sambanova', label: 'SambaNova', adapter: 'openai', base: 'https://api.sambanova.ai/v1', env: 'SAMBANOVA_API_KEY', docs: 'cloud.sambanova.ai', kind: 'api' },
  { id: 'novita', label: 'Novita AI', adapter: 'openai', base: 'https://api.novita.ai/v3/openai', env: 'NOVITA_API_KEY', docs: 'novita.ai/settings/key-management', kind: 'api' },
  { id: 'hyperbolic', label: 'Hyperbolic', adapter: 'openai', base: 'https://api.hyperbolic.xyz/v1', env: 'HYPERBOLIC_API_KEY', docs: 'app.hyperbolic.xyz/settings', kind: 'api' },
  { id: 'deepinfra', label: 'DeepInfra', adapter: 'openai', base: 'https://api.deepinfra.com/v1/openai', env: 'DEEPINFRA_API_KEY', docs: 'deepinfra.com/dash/api_keys', kind: 'api' },
  { id: 'nebius', label: 'Nebius AI Studio', adapter: 'openai', base: 'https://api.studio.nebius.ai/v1', env: 'NEBIUS_API_KEY', docs: 'studio.nebius.ai', kind: 'api' },
  { id: 'lambda', label: 'Lambda Labs', adapter: 'openai', base: 'https://api.lambdalabs.com/v1', env: 'LAMBDA_API_KEY', docs: 'cloud.lambdalabs.com/api-keys', kind: 'api' },
  { id: 'perplexity', label: 'Perplexity', adapter: 'openai', base: 'https://api.perplexity.ai', env: 'PERPLEXITY_API_KEY', docs: 'perplexity.ai/settings/api', kind: 'api' },
  { id: 'cohere', label: 'Cohere', adapter: 'openai', base: 'https://api.cohere.ai/compatibility/v1', env: 'COHERE_API_KEY', docs: 'dashboard.cohere.com/api-keys', kind: 'api' },
  { id: 'ai21', label: 'AI21 Labs', adapter: 'openai', base: 'https://api.ai21.com/studio/v1', env: 'AI21_API_KEY', docs: 'studio.ai21.com/account/api-key', kind: 'api' },
  { id: 'reka', label: 'Reka', adapter: 'openai', base: 'https://api.reka.ai/v1', env: 'REKA_API_KEY', docs: 'platform.reka.ai', kind: 'api' },
  // — China / Asia providers
  { id: 'moonshot', label: 'Moonshot Kimi', adapter: 'openai', base: 'https://api.moonshot.ai/v1', env: 'MOONSHOT_API_KEY', docs: 'platform.moonshot.ai', kind: 'api' },
  { id: 'zai', label: 'Z.ai (GLM)', adapter: 'openai', base: 'https://api.z.ai/api/paas/v4', env: 'ZAI_API_KEY', docs: 'z.ai/manage-apikey', kind: 'api' },
  { id: 'qwen', label: 'Alibaba DashScope (Qwen)', adapter: 'openai', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', env: 'DASHSCOPE_API_KEY', docs: 'bailian.console.alibabacloud.com', kind: 'api' },
  { id: 'minimax', label: 'MiniMax', adapter: 'openai', base: 'https://api.minimax.io/v1', env: 'MINIMAX_API_KEY', docs: 'platform.minimax.io', kind: 'api' },
  { id: 'stepfun', label: 'StepFun', adapter: 'openai', base: 'https://api.stepfun.ai/v1', env: 'STEPFUN_API_KEY', docs: 'platform.stepfun.ai', kind: 'api' },
  { id: 'bytedance', label: 'ByteDance Ark (Doubao)', adapter: 'openai', base: 'https://ark.cn-beijing.volces.com/api/v3', env: 'ARK_API_KEY', docs: 'console.volcengine.com/ark', kind: 'api' },
  { id: 'baidu', label: 'Baidu Qianfan', adapter: 'openai', base: 'https://qianfan.baidubce.com/v2', env: 'QIANFAN_API_KEY', docs: 'console.bce.baidu.com', kind: 'api' },
  { id: 'lingyi', label: '01.AI (Yi)', adapter: 'openai', base: 'https://api.lingyiwanwu.com/v1', env: 'LINGYI_API_KEY', docs: 'platform.lingyiwanwu.com', kind: 'api' },
  { id: 'siliconflow', label: 'SiliconFlow', adapter: 'openai', base: 'https://api.siliconflow.cn/v1', env: 'SILICONFLOW_API_KEY', docs: 'cloud.siliconflow.cn', kind: 'api' },
  { id: 'upstage', label: 'Upstage', adapter: 'openai', base: 'https://api.upstage.ai/v1', env: 'UPSTAGE_API_KEY', docs: 'console.upstage.ai', kind: 'api' },
  // — gateways / aggregators
  { id: 'github-models', label: 'GitHub Models', adapter: 'openai', base: 'https://models.inference.ai.azure.com', env: 'GITHUB_TOKEN', docs: 'github.com/settings/tokens', kind: 'api' },
  { id: 'azure-openai', label: 'Azure OpenAI', adapter: 'openai', base: '', env: 'AZURE_OPENAI_API_KEY', docs: 'portal.azure.com', kind: 'custom' },
  { id: 'cloudflare', label: 'Cloudflare Workers AI', adapter: 'openai', base: 'https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1', env: 'CLOUDFLARE_API_TOKEN', docs: 'dash.cloudflare.com/profile/api-tokens', kind: 'custom' },
  { id: 'ollama-cloud', label: 'Ollama Cloud', adapter: 'openai', base: 'https://ollama.com/v1', env: 'OLLAMA_CLOUD_API_KEY', docs: 'ollama.com/settings/keys', kind: 'api' },
  // — local runtimes (no key)
  { id: 'ollama', label: 'Ollama (local)', adapter: 'ollama', base: 'http://localhost:11434', env: 'OLLAMA_HOST', docs: 'ollama.com', kind: 'local' },
  { id: 'lmstudio', label: 'LM Studio', adapter: 'openai', base: 'http://localhost:1234/v1', env: 'LMSTUDIO_API_KEY', docs: 'lmstudio.ai', kind: 'local' },
  { id: 'llamacpp', label: 'llama.cpp server', adapter: 'openai', base: 'http://localhost:8080/v1', env: 'LLAMACPP_API_KEY', docs: 'github.com/ggml-org/llama.cpp', kind: 'local' },
  { id: 'vllm', label: 'vLLM', adapter: 'openai', base: 'http://localhost:8000/v1', env: 'VLLM_API_KEY', docs: 'docs.vllm.ai', kind: 'local' },
  { id: 'tabby', label: 'TabbyAPI', adapter: 'openai', base: 'http://localhost:5000/v1', env: 'TABBY_API_KEY', docs: 'github.com/theroyallab/tabbyAPI', kind: 'local' }
];

/**
 * Subscription sign-in sources. We import what the vendor's own CLI already
 * stored — never passwords, never a fabricated OAuth client.
 */
const IMPORTS = [
  {
    id: 'claude-code', label: 'Claude Code (Claude Pro/Max)',
    file: () => path.join(os.homedir(), '.claude', '.credentials.json'),
    pick: (j) => {
      const o = j.claudeAiOauth || j;
      return { access_token: o.accessToken || o.access_token, refresh_token: o.refreshToken || o.refresh_token, expires_at: o.expiresAt || o.expires_at, plan: o.subscriptionType || null };
    },
    provider: 'anthropic'
  },
  {
    id: 'gemini-cli', label: 'Gemini CLI (Google account)',
    file: () => path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    pick: (j) => ({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expiry_date, id_token: j.id_token }),
    provider: 'google'
  },
  {
    id: 'codex-cli', label: 'Codex CLI (ChatGPT plan)',
    file: () => path.join(os.homedir(), '.codex', 'auth.json'),
    pick: (j) => ({ access_token: j.tokens?.access_token || j.OPENAI_API_KEY, refresh_token: j.tokens?.refresh_token, account: j.tokens?.account_id || null }),
    provider: 'openai'
  },
  {
    id: 'qwen-code', label: 'Qwen Code CLI',
    file: () => path.join(os.homedir(), '.qwen', 'oauth_creds.json'),
    pick: (j) => ({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expiry_date }),
    provider: 'qwen'
  },
  {
    id: 'github-copilot', label: 'GitHub CLI / Copilot',
    file: () => path.join(os.homedir(), '.config', 'gh', 'hosts.yml'),
    exec: () => {
      try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 4000, windowsHide: true }).trim(); } catch { return null; }
    },
    pick: () => ({}),
    provider: 'github-models'
  }
];

function readStore() {
  try {
    const raw = fs.readFileSync(STORE(), 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : { version: 1, providers: {} };
  } catch {
    return { version: 1, providers: {} };
  }
}

function writeStore(store) {
  const file = STORE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs */ }
  return file;
}

function hint(secret) {
  const s = String(secret || '');
  if (!s) return null;
  return s.length <= 8 ? '••••' : s.slice(0, 3) + '…' + s.slice(-4);
}

function entryFor(id) {
  return CATALOG.find(p => p.id === id) || null;
}

/** Store a manual API key (or OAuth token) for a provider or a custom endpoint. */
function setKey(id, key, extra = {}) {
  const s = String(key || '').trim();
  if (!s) return { ok: false, error: 'Empty key.' };
  if (s.length < 8) return { ok: false, error: 'Key looks too short to be valid.' };
  const store = readStore();
  store.providers[id] = {
    api_key: s,
    source: 'manual',
    updated_at: new Date().toISOString(),
    ...extra
  };
  writeStore(store);
  return { ok: true, id, hint: hint(s) };
}

function setToken(id, token, meta = {}) {
  const s = String(token || '').trim();
  if (!s) return { ok: false, error: 'Empty token.' };
  const store = readStore();
  store.providers[id] = {
    access_token: s,
    refresh_token: meta.refresh_token || null,
    expires_at: meta.expires_at || null,
    plan: meta.plan || null,
    source: meta.source || 'oauth',
    updated_at: new Date().toISOString()
  };
  writeStore(store);
  return { ok: true, id, hint: hint(s) };
}

function clear(id) {
  const store = readStore();
  if (!store.providers[id]) return { ok: false, error: 'Nothing stored for ' + id };
  delete store.providers[id];
  writeStore(store);
  return { ok: true, id };
}

function setCustom({ label, base, api_key, adapter }) {
  if (!label || !base) return { ok: false, error: 'label and base are required.' };
  if (!/^https?:\/\/\S+$/.test(base)) return { ok: false, error: 'base must be an http(s) URL.' };
  const id = 'custom:' + String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const store = readStore();
  store.providers[id] = {
    label, base,
    adapter: ['openai', 'anthropic', 'gemini', 'ollama'].includes(adapter) ? adapter : 'openai',
    api_key: api_key ? String(api_key).trim() : null,
    source: 'custom',
    updated_at: new Date().toISOString()
  };
  writeStore(store);
  return { ok: true, id };
}

/** Store-only resolution (no environment): what config-loader trusts first. */
function resolveStored(providerId, endpoint) {
  const store = readStore();
  const direct = store.providers[providerId];
  if (direct?.api_key) return direct.api_key;
  if (direct?.access_token) return direct.access_token;
  const ep = String(endpoint || '').toLowerCase();
  if (ep) {
    for (const [id, p] of Object.entries(store.providers)) {
      const base = String(p.base || (entryFor(id) || {}).base || '').toLowerCase();
      if (base && ep.startsWith(base.replace(/\/$/, ''))) {
        if (p.api_key) return p.api_key;
        if (p.access_token) return p.access_token;
      }
    }
  }
  return null;
}

/** Resolution order: stored credential → endpoint-matched store → provider env. */
function resolve(providerId, endpoint) {
  const store = readStore();
  const direct = store.providers[providerId];
  if (direct?.api_key) return direct.api_key;
  if (direct?.access_token) return direct.access_token;

  // endpoint match (custom endpoints and shared bases)
  const ep = String(endpoint || '').toLowerCase();
  if (ep) {
    for (const [id, p] of Object.entries(store.providers)) {
      const base = String(p.base || (entryFor(id) || {}).base || '').toLowerCase();
      if (base && ep.startsWith(base.replace(/\/$/, ''))) {
        if (p.api_key) return p.api_key;
        if (p.access_token) return p.access_token;
      }
    }
    // registry entry whose base matches the endpoint (Groq/DeepSeek/… env)
    const byBase = CATALOG.find(p => p.base && ep.startsWith(p.base.toLowerCase().replace(/\/$/, '')));
    if (byBase?.env && envValue(byBase.env)) return envValue(byBase.env);
  }

  const meta = entryFor(providerId);
  if (meta?.env && envValue(meta.env)) return envValue(meta.env);
  return null;
}

/** Public status: never the secret itself. */
function status() {
  const store = readStore();
  const rows = CATALOG.map(p => {
    const rec = store.providers[p.id] || {};
    const envVal = p.env ? envValue(p.env) : null;
    const has = !!(rec.api_key || rec.access_token || envVal);
    return {
      id: p.id, label: p.label, adapter: p.adapter, base: rec.base || p.base,
      kind: p.kind, env: p.env, docs: p.docs,
      configured: has,
      source: rec.api_key ? (rec.source || 'manual') : rec.access_token ? (rec.source || 'oauth') : envVal ? 'env' : null,
      hint: hint(rec.api_key || rec.access_token || envVal),
      expires_at: rec.expires_at || null,
      plan: rec.plan || null,
      updated_at: rec.updated_at || null
    };
  });
  const customs = Object.entries(store.providers)
    .filter(([id]) => id.startsWith('custom:'))
    .map(([id, p]) => ({ id, label: p.label || id, base: p.base, adapter: p.adapter, configured: !!p.api_key, hint: hint(p.api_key), kind: 'custom' }));
  return { providers: rows, custom: customs };
}

function imports() {
  return IMPORTS.map(i => {
    let present = false, when = null;
    try {
      const f = i.file();
      if (f && fs.existsSync(f)) { present = true; when = fs.statSync(f).mtime.toISOString(); }
    } catch { /* unreadable */ }
    if (!present && i.exec) {
      try { present = !!i.exec(); } catch { present = false; }
    }
    return { id: i.id, label: i.label, provider: i.provider, available: present, updated_at: when };
  });
}

function importFrom(id) {
  const spec = IMPORTS.find(i => i.id === id);
  if (!spec) return { ok: false, error: 'Unknown import source.' };
  let payload = null;
  try {
    if (spec.exec) {
      const tok = spec.exec();
      payload = tok ? { access_token: tok } : null;
    } else {
      const file = spec.file();
      if (!file || !fs.existsSync(file)) return { ok: false, error: 'No credentials file found for ' + spec.label + '.' };
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      payload = spec.pick(parsed);
    }
  } catch (e) {
    return { ok: false, error: 'Could not read credentials: ' + e.message };
  }
  const token = payload?.access_token || payload?.api_key;
  if (!token) {
    return {
      ok: false,
      error: payload
        ? spec.label + ' stored an empty token (the CLI needs to refresh). Run that CLI once, or paste a token in the Providers page.'
        : 'Credentials file had no usable token.'
    };
  }
  const r = setToken(spec.provider, token, {
    refresh_token: payload.refresh_token,
    expires_at: payload.expires_at,
    plan: payload.plan,
    source: 'import:' + spec.id
  });
  return { ...r, via: spec.id, expires_at: payload.expires_at || null };
}

/** Live probe: ask the provider for its model list with the resolved credential.
 *  opts.key tests an ad-hoc key before it is saved. */
async function test(id, opts = {}) {
  const store = readStore();
  const custom = id.startsWith('custom:') ? store.providers[id] : null;
  const meta = entryFor(id);
  if (!meta && !custom) return { ok: false, error: 'Unknown provider.' };

  const base = String(custom?.base || meta?.base || '').replace(/\/$/, '');
  const adapter = custom?.adapter || meta?.adapter || 'openai';
  const typedKey = typeof opts.key === 'string' && opts.key.trim() ? opts.key.trim() : null;
  const key = typedKey || resolve(id, base);
  const rec = store.providers[id];
  const isOauth = !!(rec && rec.access_token && !rec.api_key) && !typedKey;
  if (!base) return { ok: false, error: 'This provider needs an explicit base URL (set it in Custom Endpoints).' };
  if (!key && meta?.kind !== 'local') {
    return {
      ok: false,
      error: 'No credential for ' + (meta?.label || id) + ': nothing saved, and ' + (meta?.env || 'its env var') + ' is not set in the environment or .env.'
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const started = Date.now();
  try {
    let url, headers = {};
    if (adapter === 'anthropic') {
      url = base + '/v1/models?limit=20';
      headers = isOauth
        ? { Authorization: 'Bearer ' + key, 'anthropic-version': '2023-06-01' }
        : { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    } else if (adapter === 'gemini') {
      // OAuth access tokens go in the Authorization header; API keys as ?key=
      url = isOauth
        ? base + '/v1beta/models'
        : base + '/v1beta/models?key=' + encodeURIComponent(key || '');
      if (isOauth) headers = { Authorization: 'Bearer ' + key };
    } else if (adapter === 'ollama') {
      url = base + '/api/tags';
      if (key) headers = { Authorization: 'Bearer ' + key };
    } else {
      url = base + '/models';
      if (key) headers = { Authorization: 'Bearer ' + key };
    }
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let models = [];
    try {
      const json = JSON.parse(text);
      models = json.data || json.models || json.anchors || [];
    } catch { /* non-json */ }

    // Some providers serve their model list publicly. If the same URL answers
    // without credentials, a 200 says nothing about the key — say so instead of
    // claiming the credential was verified.
    let authChecked = true;
    if (res.ok && key && adapter !== 'ollama') {
      try {
        const pub = await fetch(url, { signal: controller.signal });
        if (pub.ok) authChecked = false;
      } catch { /* ignore */ }
    }

    return {
      ok: res.ok,
      status: res.status,
      latency_ms: Date.now() - started,
      model_count: Array.isArray(models) ? models.length : 0,
      sample: (models || []).slice(0, 5).map(m => m.id || m.name || m.model).filter(Boolean),
      auth_checked: authChecked,
      note: authChecked ? null : 'this provider lists models without credentials, so the key itself was not verified',
      error: res.ok ? null : String(text).slice(0, 200)
    };
  } catch (e) {
    return { ok: false, error: 'Request failed: ' + e.message, latency_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generic OAuth device flow. The caller supplies the client id and endpoints of
 * an app they control; we never invent one on the user's behalf.
 */
const devices = new Map();

async function deviceStart({ provider, client_id, device_code_url, token_url, scope, audience }) {
  if (!client_id || !device_code_url || !token_url) {
    return { ok: false, error: 'client_id, device_code_url and token_url are required.' };
  }
  const body = new URLSearchParams({ client_id, scope: scope || 'openid offline_access' });
  if (audience) body.set('audience', audience);
  const res = await fetch(device_code_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.device_code) {
    return { ok: false, error: json.error_description || json.error || ('HTTP ' + res.status) };
  }
  const state = {
    provider, client_id, token_url,
    device_code: json.device_code,
    interval: Number(json.interval) || 5,
    expires_at: Date.now() + (Number(json.expires_in) || 900) * 1000
  };
  devices.set(provider, state);
  return {
    ok: true,
    verification_uri: json.verification_uri || json.verification_url || null,
    verification_uri_complete: json.verification_uri_complete || null,
    user_code: json.user_code || null,
    interval: state.interval,
    expires_in: Math.round((state.expires_at - Date.now()) / 1000)
  };
}

async function devicePoll({ provider }) {
  const st = devices.get(provider);
  if (!st) return { ok: false, error: 'No pending sign-in for ' + provider + '.' };
  if (Date.now() > st.expires_at) { devices.delete(provider); return { ok: false, error: 'Device code expired — start again.' }; }
  const body = new URLSearchParams({
    client_id: st.client_id,
    device_code: st.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  });
  const res = await fetch(st.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (json.error === 'authorization_pending' || json.error === 'slow_down') {
    return { ok: false, pending: true, error: json.error };
  }
  if (!res.ok || !json.access_token) {
    devices.delete(provider);
    return { ok: false, error: json.error_description || json.error || ('HTTP ' + res.status) };
  }
  devices.delete(provider);
  const stored = setToken(provider, json.access_token, {
    refresh_token: json.refresh_token,
    expires_at: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
    source: 'oauth-device'
  });
  return { ...stored, ok: true, token_type: json.token_type || 'Bearer' };
}

module.exports = {
  CATALOG, IMPORTS,
  list: () => CATALOG.slice(),
  status, imports, importFrom,
  setKey, setToken, clear, setCustom,
  resolve, resolveStored, test, deviceStart, devicePoll,
  storePath: () => STORE()
};
