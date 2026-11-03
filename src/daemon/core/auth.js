// src/daemon/core/auth.js — local daemon bearer token.
// The daemon has no user database: one machine-local token protects the API.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function tokenPath() {
  return path.resolve(process.cwd(), '.liber', 'daemon.token');
}

function readToken() {
  if (process.env.LIBER_TOKEN) return process.env.LIBER_TOKEN.trim();
  try {
    const t = fs.readFileSync(tokenPath(), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * Load the existing token or create one. Written 0600 under .liber/.
 */
function ensureToken() {
  const existing = readToken();
  if (existing) return existing;

  const token = crypto.randomBytes(32).toString('hex');
  const file = tokenPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
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
  tokenPath,
  readToken,
  ensureToken,
  extract,
  safeEqual,
  isAuthorized
};
