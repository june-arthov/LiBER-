// src/daemon/core/shares.js — read-only session links (capability URLs).
//
// A share is a 128-bit id that maps to one session key. Whoever holds the id can
// read that session; nobody can write through it. The daemon binds to 127.0.0.1,
// so the link is only reachable from this machine (or a tunnel the operator
// chooses). Expiry and revoke are first-class, not an afterthought.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const secrets = require('./secrets');

const MAX_MESSAGES = 400;
const MAX_CHARS_PER_MESSAGE = 8000;
const DEFAULT_TTL_HOURS = 24 * 7;

function dir() {
  return path.resolve(process.cwd(), '.liber');
}
function file() {
  return process.env.LIBER_SHARES_FILE || path.join(dir(), 'shares.json');
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { version: 1, shares: raw && typeof raw.shares === 'object' ? raw.shares : {} };
  } catch {
    return { version: 1, shares: {} };
  }
}

function write(state) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows has no POSIX mode; its ACL applies */ }
  fs.renameSync(tmp, target);
}

function newId() {
  return crypto.randomBytes(16).toString('hex');   // 32 hex chars = 128 bits
}

function create({ key, title = null, ttlHours = DEFAULT_TTL_HOURS } = {}) {
  const sessionKey = String(key || '').trim();
  if (!sessionKey) throw new Error('A session key is required to share.');

  const hours = Number(ttlHours);
  const ttl = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 365) : DEFAULT_TTL_HOURS;

  const state = read();
  const id = newId();
  const now = Date.now();
  const record = {
    id,
    key: sessionKey,
    title: title ? String(title).slice(0, 120) : null,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl * 3600 * 1000).toISOString(),
    revoked: false,
    views: 0,
    last_viewed_at: null
  };
  state.shares[id] = record;
  write(state);
  return record;
}

function list() {
  const state = read();
  return Object.values(state.shares)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(r => ({ ...r, expired: isExpired(r) }));
}

function isExpired(record) {
  return !record || record.revoked === true || Date.parse(record.expires_at) <= Date.now();
}

/** Resolve a link for reading. Returns null for unknown, revoked or expired ids. */
function resolve(id) {
  const state = read();
  const record = state.shares[String(id || '')];
  if (!record || isExpired(record)) return null;

  record.views = (record.views || 0) + 1;
  record.last_viewed_at = new Date().toISOString();
  try { write(state); } catch { /* a read must not fail because the counter could not be saved */ }
  return record;
}

function revoke(id) {
  const state = read();
  const key = String(id || '');
  if (!state.shares[key]) return false;
  state.shares[key].revoked = true;
  state.shares[key].revoked_at = new Date().toISOString();
  write(state);
  return true;
}

// Turns the model's own scaffolding into noise the reader never asked for, and
// keeps anything that could identify this machine out of a link.
const INTERNAL = /^(OBSERVATION \[E|DENIED:|GROUNDING AUDIT|STOP —|You have at most|You returned an empty response|Your reply contained no \[FINAL|Your previous answer)/;
const HOME_PATHS = [
  [new RegExp(String(process.env.USERPROFILE || '').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'gi'), '~'],
  // C:\Users\<name>\... and the POSIX equivalent, so a shared link never carries
  // the account name of the machine it came from.
  [/[A-Z]:\\Users\\[^\\\s"']+/gi, '~'],
  [/\/home\/[^/\s"']+/g, '~'],
  [/\/Users\/[^/\s"']+/g, '~']
];

function sanitize(messages = []) {
  const out = [];
  for (const m of messages) {
    const role = m && m.role ? String(m.role) : 'user';
    let content = String((m && m.content) || '');
    if (INTERNAL.test(content)) continue;                 // tool output, retries, audits
    content = secrets.redact(content);                    // keys, tokens, cards
    for (const [rx, to] of HOME_PATHS) if (rx.source) content = content.replace(rx, to);
    if (content.length > MAX_CHARS_PER_MESSAGE) {
      content = content.slice(0, MAX_CHARS_PER_MESSAGE) + '\n… [truncated in the shared copy]';
    }
    out.push({ role, content, ts: (m && m.ts) || null });
    if (out.length >= MAX_MESSAGES) break;
  }
  return out;
}

/** The only thing a public link ever returns. */
function publicPayload(record, messages) {
  return {
    success: true,
    share: {
      id: record.id,
      title: record.title,
      created_at: record.created_at,
      expires_at: record.expires_at,
      read_only: true
    },
    messages: sanitize(messages)
  };
}

module.exports = {
  create, list, resolve, revoke, sanitize, publicPayload,
  isExpired,
  storePath: () => file()
};
