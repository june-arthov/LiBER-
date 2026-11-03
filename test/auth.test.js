// test/auth.test.js — machine-local bearer token for the daemon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-auth-'));
process.chdir(tmp);

const auth = require('../src/daemon/core/auth');

test('ensureToken creates a strong token file once', () => {
  delete process.env.LIBER_TOKEN;
  const token = auth.ensureToken();
  assert.match(token, /^[a-f0-9]{64}$/);

  const file = auth.tokenPath();
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file, 'utf8').trim(), token);

  const again = auth.ensureToken();
  assert.equal(again, token, 'token must be stable across calls');
});

test('readToken returns the persisted token', () => {
  delete process.env.LIBER_TOKEN;
  const token = auth.ensureToken();
  assert.equal(auth.readToken(), token);
});

test('LIBER_TOKEN overrides the file', () => {
  process.env.LIBER_TOKEN = 'env-token-value';
  assert.equal(auth.readToken(), 'env-token-value');
  delete process.env.LIBER_TOKEN;
});

test('safeEqual rejects wrong and malformed tokens', () => {
  assert.equal(auth.safeEqual('abc', 'abc'), true);
  assert.equal(auth.safeEqual('abc', 'abd'), false);
  assert.equal(auth.safeEqual('short', 'a-much-longer-token'), false);
  assert.equal(auth.safeEqual('', 'abc'), false);
  assert.equal(auth.safeEqual(null, null), false);
});

test('isAuthorized accepts bearer and x-liber-token headers only', () => {
  const expected = 'secret-token';
  const bearer = { headers: { authorization: 'Bearer secret-token' } };
  const custom = { headers: { 'x-liber-token': 'secret-token' } };
  const bad = { headers: { authorization: 'Bearer nope' } };
  const none = { headers: {} };

  assert.equal(auth.isAuthorized(bearer, expected), true);
  assert.equal(auth.isAuthorized(custom, expected), true);
  assert.equal(auth.isAuthorized(bad, expected), false);
  assert.equal(auth.isAuthorized(none, expected), false);
});
