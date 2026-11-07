// Share links: a capability URL that reads one session, never writes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-shares-'));
process.env.LIBER_SHARES_FILE = path.join(dir, 'shares.json');
const shares = require('../src/daemon/core/shares');

test('a created link resolves to its session and counts the view', () => {
  const rec = shares.create({ key: 'dev-bot#abc', title: 'Demo' });
  assert.match(rec.id, /^[0-9a-f]{32}$/, '128-bit capability id');

  const got = shares.resolve(rec.id);
  assert.ok(got, 'the link reads');
  assert.strictEqual(got.key, 'dev-bot#abc');
  assert.strictEqual(got.views, 1);
});

test('a revoked link stops resolving', () => {
  const rec = shares.create({ key: 'dev-bot#revoke-me' });
  assert.strictEqual(shares.revoke(rec.id), true);
  assert.strictEqual(shares.resolve(rec.id), null);
  assert.strictEqual(shares.resolve('does-not-exist'), null);
});

test('an expired link stops resolving even though it is still on disk', () => {
  const rec = shares.create({ key: 'dev-bot#expiring', ttlHours: 1 });
  const store = JSON.parse(fs.readFileSync(process.env.LIBER_SHARES_FILE, 'utf8'));
  assert.ok(store.shares[rec.id], 'recorded');

  // Move the expiry into the past by writing it, not by sleeping: a millisecond TTL
  // made this test depend on the clock advancing between two calls, which passed on
  // Windows and failed on a fast Linux runner.
  store.shares[rec.id].expires_at = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(process.env.LIBER_SHARES_FILE, JSON.stringify(store, null, 2), 'utf8');

  assert.strictEqual(shares.resolve(rec.id), null, 'expiry is checked at read time');
});

test('the shared payload never carries tool output or the machine path', () => {
  const messages = [
    { role: 'user', content: 'what is in my config?' },
    { role: 'assistant', content: 'reading it now' },
    { role: 'user', content: 'OBSERVATION [E1] read_file OK: API_KEY=sk-live-abcd1234secret' },
    { role: 'user', content: 'DENIED: approval was not granted.' },
    { role: 'assistant', content: 'Your key lives in C:\\Users\\june\\projects\\app\\.env' }
  ];
  const clean = shares.sanitize(messages);

  assert.deepStrictEqual(clean.map(m => m.role), ['user', 'assistant', 'assistant'],
    'observation and denial entries are dropped');
  const text = JSON.stringify(clean);
  assert.ok(!text.includes('OBSERVATION'), 'tool output never ships');
  assert.ok(!text.includes('sk-live-abcd1234'), 'secrets are redacted');
  assert.ok(!/C:\\\\Users\\\\june/i.test(text), 'the account path is replaced');
  assert.ok(clean.some(m => m.content.includes('~')), 'the path still says where it was, generically');
});

test('one long message cannot turn a link into a data dump', () => {
  const clean = shares.sanitize([{ role: 'assistant', content: 'x'.repeat(20000) }]);
  assert.strictEqual(clean.length, 1);
  assert.ok(clean[0].content.length < 8100, `got ${clean[0].content.length}`);
  assert.match(clean[0].content, /truncated in the shared copy/);
});

test('publicPayload is read-only and does not leak the session key', () => {
  const rec = shares.create({ key: 'dev-bot#secret-key', title: 'Shared' });
  const payload = shares.publicPayload(rec, [{ role: 'user', content: 'hello' }]);
  assert.strictEqual(payload.share.read_only, true);
  assert.ok(!JSON.stringify(payload.share).includes('secret-key'), 'the key is not served');
  assert.strictEqual(payload.messages.length, 1);
});

test('the list reports expiry without exposing it as usable', () => {
  const rows = shares.list();
  assert.ok(rows.length >= 1);
  const revoked = rows.find(r => r.revoked);
  assert.ok(revoked && revoked.expired === true, 'revoked reads as expired');
});
