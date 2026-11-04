// The daemon's front door: per-client tokens, scopes, rate limits, audit.
// Each run uses its own .liber so it cannot touch the real clients file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-authclients-'));
process.chdir(dir);
fs.mkdirSync(path.join(dir, '.liber'), { recursive: true });
fs.writeFileSync(path.join(dir, '.liber', 'daemon.token'), 'bootstrap-token-1234567890');

const auth = require('../src/daemon/core/auth');

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } });

test('the existing daemon token becomes the local admin client', () => {
  const local = auth.verify('bootstrap-token-1234567890');
  assert.ok(local, 'the token already on disk must keep working');
  assert.equal(local.id, 'local');
  assert.ok(auth.can(local, 'admin'));
  assert.equal(auth.verify('wrong-token'), null);
  assert.equal(auth.verify(''), null);
});

test('tokens are stored hashed, never in the clear', () => {
  const created = auth.create('phone', { scopes: ['read', 'chat'] });
  assert.equal(created.ok, true);
  assert.match(created.token, /^lib_[0-9a-f]{48}$/);
  const raw = fs.readFileSync(auth.FILE(), 'utf8');
  assert.equal(raw.includes(created.token), false, 'the plaintext token must not be on disk');
  assert.ok(raw.includes(auth.hash(created.token)), 'the hash is what is stored');
});

test('scopes are mapped per endpoint and enforced per client', () => {
  const { token } = auth.create('reader', { scopes: ['read'] });
  const client = auth.verify(token);
  assert.ok(auth.can(client, 'read'));
  assert.equal(auth.can(client, 'chat'), false);
  assert.equal(auth.can(client, 'admin'), false);

  assert.equal(auth.scopeFor('GET', '/ps'), 'read');
  assert.equal(auth.scopeFor('POST', '/chat'), 'chat');
  assert.equal(auth.scopeFor('POST', '/chat/stream'), 'chat');
  assert.equal(auth.scopeFor('POST', '/shutdown'), 'admin');
  assert.equal(auth.scopeFor('GET', '/clients'), 'admin');
  assert.equal(auth.scopeFor('GET', '/config'), 'read');
  assert.equal(auth.scopeFor('POST', '/config/update'), 'admin');
});

test('admin is not a wildcard, "*" is, unknown scopes are refused', () => {
  const { token } = auth.create('ops', { scopes: ['admin'] });
  const client = auth.verify(token);
  assert.ok(auth.can(client, 'admin'));
  assert.equal(auth.can(client, 'chat'), false, 'admin must not silently imply chat');
  const wild = auth.create('root', { scopes: ['*'] });
  assert.equal(auth.can(auth.verify(wild.token), 'anything'), true);
  assert.equal(auth.create('nope', { scopes: ['teleport'] }).ok, false);
});

test('the rate limit drains and refills', () => {
  const { token } = auth.create('burst', { scopes: ['read'], perMin: 3 });
  const client = auth.verify(token);
  const t0 = 1_000_000;
  assert.equal(auth.rateLimit(client, t0).allowed, true);
  assert.equal(auth.rateLimit(client, t0 + 10).allowed, true);
  assert.equal(auth.rateLimit(client, t0 + 20).allowed, true);
  const blocked = auth.rateLimit(client, t0 + 30);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 20000, `retry hint was ${blocked.retryAfterMs}`);
  assert.equal(auth.rateLimit(client, t0 + 30_000).allowed, true, 'half a minute refills half the bucket');
});

test('rotation kills the old token immediately', () => {
  const created = auth.create('laptop', { scopes: ['chat'] });
  assert.ok(auth.verify(created.token));
  const rotated = auth.rotate(created.id);
  assert.equal(rotated.ok, true);
  assert.equal(auth.verify(created.token), null, 'the old token must stop working');
  assert.ok(auth.verify(rotated.token));
});

test('revoke removes a client; the local client is protected', () => {
  const created = auth.create('temp', { scopes: ['read'] });
  assert.equal(auth.revoke(created.id).ok, true);
  assert.equal(auth.verify(created.token), null);
  assert.equal(auth.revoke('local').ok, false);
  assert.equal(auth.revoke('does-not-exist').ok, false);
});

test('list never exposes a hash or a token', () => {
  const rows = auth.list();
  const asText = JSON.stringify(rows);
  assert.equal(/"hash"/.test(asText), false);
  assert.equal(/lib_[0-9a-f]{48}/.test(asText), false);
  const local = rows.find(r => r.id === 'local');
  assert.ok(local);
  assert.ok(local.scopes.includes('admin'));
});

test('audit lines are appended as JSON', () => {
  auth.audit({ client: 'local', method: 'POST', endpoint: '/chat', status: 200, ms: 12 });
  const lines = fs.readFileSync(auth.AUDIT(), 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.endpoint, '/chat');
  assert.equal(last.status, 200);
  assert.ok(last.ts);
});
