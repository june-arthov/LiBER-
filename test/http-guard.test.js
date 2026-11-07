// Hardening at the HTTP edge: which origin may read a response, and how fast an
// address without a token may knock.
const test = require('node:test');
const assert = require('node:assert');
const { allowOrigin, createThrottle } = require('../src/daemon/core/http-guard');

test('only loopback origins are echoed back', () => {
  for (const ok of ['http://127.0.0.1:5173', 'http://localhost:8080', 'https://127.0.0.1', 'http://[::1]:3000']) {
    assert.strictEqual(allowOrigin(ok), ok, ok);
  }
  for (const bad of ['https://evil.example', 'http://127.0.0.1.evil.example', 'null', '', 'file://']) {
    assert.strictEqual(allowOrigin(bad), null, `must not reflect: ${bad || '(empty)'}`);
  }
});

test('a page hosted elsewhere cannot read the daemon even if it guesses the port', () => {
  // the old wildcard answered 'Access-Control-Allow-Origin: *' to this request
  assert.strictEqual(allowOrigin('https://attacker.test'), null);
});

test('the unauthenticated routes stop answering after the ceiling', () => {
  const gate = createThrottle({ limit: 3, windowMs: 1000 });
  const t0 = 1_000_000;
  assert.strictEqual(gate.check('1.2.3.4', t0).allowed, true);
  assert.strictEqual(gate.check('1.2.3.4', t0 + 1).allowed, true);
  assert.strictEqual(gate.check('1.2.3.4', t0 + 2).allowed, true);

  const blocked = gate.check('1.2.3.4', t0 + 3);
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0, 'and says when to come back');

  assert.strictEqual(gate.check('5.6.7.8', t0 + 3).allowed, true, 'other addresses are unaffected');

  const next = gate.check('1.2.3.4', t0 + 1001);
  assert.strictEqual(next.allowed, true, 'the window resets');
});

test('the default ceiling matches the documented 240/min', () => {
  const gate = createThrottle();
  assert.strictEqual(gate.limit, 240);
});
