// src/daemon/core/vault.js — encrypted secret store.
//
// Encryption at rest with AES-256-GCM. The key file sits next to the ciphertext,
// so this protects against a leaked vault.json, a synced folder, a backup, or a
// stray `cat` — not against an attacker who already reads the whole profile.
// Honest scope: better than plaintext, not a hardware enclave.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = () => path.resolve(process.env.LIBER_VAULT_DIR || path.join(process.cwd(), '.liber'));
const VAULT = () => path.join(DIR(), 'vault.json');
const KEYFILE = () => path.join(DIR(), 'vault.key');

let cachedKey = null;

function keyBytes() {
  if (cachedKey) return cachedKey;
  if (process.env.LIBER_VAULT_KEY) {
    cachedKey = crypto.scryptSync(process.env.LIBER_VAULT_KEY, 'liber-vault-v1', 32);
    return cachedKey;
  }
  const file = KEYFILE();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    cachedKey = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (cachedKey.length !== 32) throw new Error('vault key is not 32 bytes');
  } catch {
    cachedKey = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cachedKey.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  }
  return cachedKey;
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(VAULT(), 'utf8'));
    return { version: raw.version || 1, entries: raw.entries || {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

function write(state) {
  fs.mkdirSync(DIR(), { recursive: true });
  const tmp = VAULT() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 0), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, VAULT());
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(rec) {
  const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(rec.iv, 'base64'));
  d.setAuthTag(Buffer.from(rec.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(rec.ct, 'base64')), d.final()]).toString('utf8');
}

/** Store or replace a secret. The value never comes back out of this call. */
function set(name, value, meta = {}) {
  const key = String(name || '').trim();
  if (!key) return { ok: false, error: 'A secret needs a name.' };
  if (value === undefined || value === null || String(value) === '') {
    return { ok: false, error: 'A secret needs a value.' };
  }
  const state = read();
  state.entries[key] = {
    ...encrypt(String(value)),
    hint: String(value).slice(-4),
    bytes: String(value).length,
    meta,
    updatedAt: new Date().toISOString()
  };
  write(state);
  return { ok: true, name: key };
}

function get(name) {
  const state = read();
  const rec = state.entries[String(name || '')];
  if (!rec) return null;
  try { return decrypt(rec); } catch { return null; }
}

/** Metadata only: the list a UI or a model is allowed to see. */
function list() {
  const state = read();
  return Object.entries(state.entries).map(([name, r]) => ({
    name,
    hint: r.hint ? `…${r.hint}` : null,
    bytes: r.bytes || 0,
    meta: r.meta || {},
    updatedAt: r.updatedAt || null
  }));
}

function has(name) { return Boolean(read().entries[String(name || '')]); }

function remove(name) {
  const state = read();
  if (!state.entries[String(name || '')]) return { ok: false, error: `No secret named '${name}'.` };
  delete state.entries[String(name || '')];
  write(state);
  return { ok: true, removed: name };
}

/**
 * Replace plaintext keys in .liber/credentials.json with vault references.
 * Returns what moved, never what it moved.
 */
function migrateCredentials(file = path.join(DIR(), 'credentials.json')) {
  if (!fs.existsSync(file)) return { ok: true, moved: [], note: 'no credentials file' };
  let store;
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, error: e.message }; }
  const moved = [];
  for (const [id, rec] of Object.entries(store.providers || {})) {
    for (const field of ['api_key', 'access_token', 'refresh_token']) {
      const value = rec?.[field];
      if (typeof value === 'string' && value && !value.startsWith('vault:')) {
        const name = `${id}.${field}`;
        set(name, value, { provider: id, field });
        rec[field] = `vault:${name}`;
        moved.push(name);
      }
    }
  }
  if (moved.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
  return { ok: true, moved };
}

/** Resolve `vault:name` references; plain values pass through untouched. */
function resolveRef(value) {
  if (typeof value !== 'string' || !value.startsWith('vault:')) return value;
  return get(value.slice('vault:'.length));
}

function status() {
  return {
    entries: list().length,
    keySource: process.env.LIBER_VAULT_KEY ? 'env' : (fs.existsSync(KEYFILE()) ? 'file' : 'missing'),
    path: VAULT()
  };
}

/** Tests only: forget the cached key so a fresh key file is honoured. */
function _resetKeyCache() { cachedKey = null; }

module.exports = { set, get, list, has, remove, migrateCredentials, resolveRef, status, _resetKeyCache, VAULT, KEYFILE };
