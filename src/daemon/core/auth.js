// src/daemon/core/auth.js — who may talk to the daemon, and how often.
//
// One shared token is fine for a single desktop app and wrong for anything else:
// it cannot be revoked without breaking every client, it cannot be limited, and
// an audit line saying "someone did this" is useless. This module keeps a client
// per token, each with scopes and a rate limit, and never stores the token
// itself — only its SHA-256.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = () => path.resolve(process.cwd(), '.liber');
const tokenPath = () => path.join(DIR(), 'daemon.token');
const FILE = () => path.join(DIR(), 'clients.json');
const AUDIT = () => path.join(DIR(), 'auth-audit.log');

const SCOPES = ['read', 'chat', 'tools', 'admin'];
const DEFAULT_LIMIT = 240; // requests per minute per client

/** Scope a request needs. Unlisted endpoints fall back to `tools`. */
function scopeFor(method, endpoint) {
  if (endpoint === '/shutdown' || endpoint.startsWith('/clients')) return 'admin';
  if (endpoint.startsWith('/config') || endpoint === '/vault/migrate') return method === 'GET' ? 'read' : 'admin';
  if (endpoint === '/chat' || endpoint === '/chat/stream' || endpoint === '/model/switch' || endpoint.endsWith('/run')) return 'chat';
  if (endpoint.startsWith('/hitl') || endpoint.startsWith('/memory') || endpoint.startsWith('/budget') || endpoint.startsWith('/sessions')) return 'chat';
  if (method === 'GET' || method === 'HEAD') return 'read';
  return 'tools';
}

const hash = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return { clients: Array.isArray(raw.clients) ? raw.clients : [] };
  } catch { return { clients: [] }; }
}

function write(state) {
  fs.mkdirSync(DIR(), { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, FILE());
}

/**
 * First boot: adopt the existing daemon.token as an admin client so the desktop
 * app keeps working without re-authenticating, and create the token if missing.
 */
function bootstrap() {
  const state = read();
  if (state.clients.length) return state;

  let token = null;
  try { token = fs.readFileSync(tokenPath(), 'utf8').trim(); } catch { /* create below */ }
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(DIR(), { recursive: true });
    fs.writeFileSync(tokenPath(), token, { encoding: 'utf8', mode: 0o600 });
  }
  state.clients.push({
    id: 'local',
    label: 'This machine (desktop app)',
    hash: hash(token),
    scopes: ['read', 'chat', 'tools', 'admin'],
    perMin: 600,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    calls: 0
  });
  write(state);
  return state;
}

function sameHash(a, b) {
  const ab = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Resolve a bearer token to a client record, or null. */
function verify(token) {
  if (!token) return null;
  const wanted = hash(token);
  const state = bootstrap();
  for (const c of state.clients) if (sameHash(c.hash, wanted)) return c;
  return null;
}

/** Record use; best effort, never rejects a request. */
function touch(client) {
  try {
    const state = read();
    const c = state.clients.find(x => x.id === client.id);
    if (!c) return;
    c.lastUsedAt = new Date().toISOString();
    c.calls = (c.calls || 0) + 1;
    write(state);
  } catch { /* usage tracking is not worth failing a call over */ }
}

const buckets = new Map(); // clientId -> { tokens, updatedAt }

/** Token bucket, refilled continuously at `perMin` per minute. */
function rateLimit(client, now = Date.now()) {
  const perMin = Math.max(1, Number(client.perMin) || DEFAULT_LIMIT);
  const b = buckets.get(client.id) || { tokens: perMin, updatedAt: now };
  const elapsed = Math.max(0, now - b.updatedAt) / 60000;
  b.tokens = Math.min(perMin, b.tokens + elapsed * perMin);
  b.updatedAt = now;
  if (b.tokens < 1) {
    buckets.set(client.id, b);
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(((1 - b.tokens) / perMin) * 60000), limit: perMin };
  }
  b.tokens -= 1;
  buckets.set(client.id, b);
  return { allowed: true, remaining: Math.floor(b.tokens), limit: perMin };
}

function can(client, scope) {
  const list = client?.scopes || [];
  return list.includes('*') || list.includes(scope);
}

function audit(entry) {
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.appendFileSync(AUDIT(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* never block on audit */ }
}

/** Create a client. The plaintext token is returned exactly once. */
function create(label, { scopes = ['read', 'chat', 'tools'], perMin = DEFAULT_LIMIT } = {}) {
  const state = bootstrap();
  const clean = (Array.isArray(scopes) ? scopes : ['read']).filter(s => SCOPES.includes(s) || s === '*');
  if (!clean.length) return { ok: false, error: `scopes must be one of ${SCOPES.join(', ')}` };
  const token = 'lib_' + crypto.randomBytes(24).toString('hex');
  const client = {
    id: 'c_' + crypto.randomBytes(4).toString('hex'),
    label: String(label || 'client').slice(0, 60),
    hash: hash(token),
    scopes: clean,
    perMin: Math.max(1, Math.min(10000, Number(perMin) || DEFAULT_LIMIT)),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    calls: 0
  };
  state.clients.push(client);
  write(state);
  return { ok: true, id: client.id, token, scopes: client.scopes, perMin: client.perMin };
}

function list() {
  return bootstrap().clients.map(c => ({
    id: c.id, label: c.label, scopes: c.scopes, perMin: c.perMin,
    createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, calls: c.calls || 0
  }));
}

function revoke(id) {
  const state = bootstrap();
  if (id === 'local') return { ok: false, error: 'The local desktop client cannot be revoked — rotate it instead.' };
  const before = state.clients.length;
  state.clients = state.clients.filter(c => c.id !== id);
  if (state.clients.length === before) return { ok: false, error: `No client '${id}'.` };
  write(state);
  buckets.delete(id);
  return { ok: true, revoked: id };
}

/** New token for an existing client; the old one stops working immediately. */
function rotate(id) {
  const state = bootstrap();
  const c = state.clients.find(x => x.id === id);
  if (!c) return { ok: false, error: `No client '${id}'.` };
  const token = id === 'local' ? crypto.randomBytes(32).toString('hex') : 'lib_' + crypto.randomBytes(24).toString('hex');
  c.hash = hash(token);
  c.createdAt = new Date().toISOString();
  write(state);
  if (id === 'local') fs.writeFileSync(tokenPath(), token, { encoding: 'utf8', mode: 0o600 });
  return { ok: true, id, token };
}

/* ── legacy helpers, kept so existing callers keep working ────────────────── */
function readToken() {
  if (process.env.LIBER_TOKEN) return process.env.LIBER_TOKEN.trim();
  try { return fs.readFileSync(tokenPath(), 'utf8').trim() || null; } catch { return null; }
}
function ensureToken() {
  const existing = readToken();
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DIR(), { recursive: true });
  fs.writeFileSync(tokenPath(), token, { encoding: 'utf8', mode: 0o600 });
  return token;
}
function extract(req) {
  const auth = req.headers?.authorization || req.headers?.['x-liber-token'] || '';
  return String(auth).replace(/^Bearer\s+/i, '').trim();
}
function safeEqual(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function isAuthorized(req, expected) {
  return safeEqual(extract(req), expected);
}

module.exports = {
  bootstrap, verify, touch, rateLimit, can, scopeFor, audit, create, list, revoke, rotate, hash,
  SCOPES, DEFAULT_LIMIT, FILE, AUDIT,
  tokenPath, readToken, ensureToken, extract, safeEqual, isAuthorized
};
