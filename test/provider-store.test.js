// test/provider-store.test.js — provider catalog, credential store, resolution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-prov-'));
process.chdir(tmp);

const providers = require('../src/daemon/core/providers');

test('catalog is well formed and covers every adapter', () => {
  const list = providers.list();
  assert.ok(list.length >= 30, 'at least 30 providers, got ' + list.length);
  const ids = new Set();
  for (const p of list) {
    assert.ok(p.id && p.label, 'id and label required');
    assert.ok(!ids.has(p.id), 'duplicate id ' + p.id);
    ids.add(p.id);
    assert.ok(['openai', 'anthropic', 'gemini', 'ollama'].includes(p.adapter), 'adapter of ' + p.id);
    assert.ok(['api', 'local', 'custom'].includes(p.kind), 'kind of ' + p.id);
  }
  for (const must of ['openai', 'anthropic', 'google', 'xai', 'groq', 'openrouter', 'ollama', 'lmstudio']) {
    assert.ok(ids.has(must), 'missing ' + must);
  }
});

test('keys round-trip through the store without ever being returned', () => {
  const secret = 'sk-test-abcdef1234567890';
  const set = providers.setKey('groq', secret);
  assert.equal(set.ok, true);
  assert.notEqual(set.hint, secret);
  assert.ok(!JSON.stringify(set).includes('abcdef1234567890'), 'setKey must not echo the key');

  const st = providers.status();
  const groq = st.providers.find(p => p.id === 'groq');
  assert.equal(groq.configured, true);
  assert.equal(groq.source, 'manual');
  assert.ok(groq.hint.endsWith('7890'));
  assert.ok(!JSON.stringify(st).includes('abcdef1234567890'), 'status must not leak the key');

  assert.ok(fs.readFileSync(providers.storePath(), 'utf8').includes(secret), 'key is persisted');
});

test('resolve prefers the stored key over the environment', () => {
  providers.setKey('deepseek', 'sk-deep-000000000000');
  assert.equal(providers.resolve('deepseek'), 'sk-deep-000000000000');

  const prev = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk-from-env-111111';
  try {
    assert.equal(providers.resolve('groq'), 'sk-test-abcdef1234567890', 'stored key wins over env');
    assert.equal(providers.resolve('groq', 'https://api.groq.com/openai/v1'), 'sk-test-abcdef1234567890');
    assert.equal(providers.resolve('cerebras'), null);
  } finally {
    if (prev === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = prev;
  }
});

test('a custom endpoint credential resolves by base URL and clears cleanly', () => {
  const r = providers.setCustom({ label: 'My Gateway', base: 'https://llm.internal.example/v1', api_key: 'gw-key-000000000000', adapter: 'openai' });
  assert.equal(r.ok, true);
  assert.ok(r.id.startsWith('custom:'));
  assert.equal(providers.resolve('openai', 'https://llm.internal.example/v1'), 'gw-key-000000000000');

  const st = providers.status();
  assert.ok(st.custom.some(c => c.id === r.id && c.configured));

  assert.equal(providers.clear(r.id).ok, true);
  assert.equal(providers.resolve('openai', 'https://llm.internal.example/v1'), null);
});

test('invalid keys and endpoints are rejected', () => {
  assert.equal(providers.setKey('openai', '').ok, false);
  assert.equal(providers.setKey('openai', 'short').ok, false);
  assert.equal(providers.setCustom({ label: 'x', base: 'not-a-url' }).ok, false);
});

test('subscription imports declare availability and never invent a token', () => {
  const list = providers.imports();
  assert.ok(Array.isArray(list) && list.length >= 4);
  for (const i of list) {
    assert.ok(i.id && i.label && typeof i.available === 'boolean');
  }
  const bad = providers.importFrom('nope');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unknown import source/);
});

test('device flow validates parameters instead of guessing a client id', async () => {
  const r = await providers.deviceStart({ provider: 'demo' });
  assert.equal(r.ok, false);
  assert.match(r.error, /client_id/);
  const poll = await providers.devicePoll({ provider: 'demo' });
  assert.equal(poll.ok, false);
  assert.match(poll.error, /No pending sign-in/);
});

test('test() reports a clear error when no credential exists', async () => {
  const r = await providers.test('cerebras');
  assert.equal(r.ok, false);
  assert.match(r.error, /No credential/);
});

test('.env values count as configured, exactly like the daemon sees them', () => {
  fs.writeFileSync(path.join(process.cwd(), '.env'), 'CEREBRAS_API_KEY=cs-from-dotenv-123456\n', 'utf8');
  const st = providers.status();
  const c = st.providers.find(p => p.id === 'cerebras');
  assert.equal(c.configured, true);
  assert.equal(c.source, 'env');
  assert.equal(providers.resolve('cerebras'), 'cs-from-dotenv-123456');
  assert.equal(providers.resolveStored('cerebras'), null, 'stored-only never reads .env');
});

test('test() uses an ad-hoc key and reports whether the key was really checked', async () => {
  const original = global.fetch;
  const seen = [];
  global.fetch = async (url, opts = {}) => {
    seen.push({ url, auth: (opts.headers || {}).Authorization || null });
    // first call (with our key) = 200 + models, second (public probe) = 401
    if (seen.length === 1) {
      return new Response(JSON.stringify({ data: [{ id: 'm-1' }, { id: 'm-2' }] }), { status: 200 });
    }
    return new Response('{}', { status: 401 });
  };
  let out;
  try {
    out = await providers.test('ollama-cloud', { key: 'sk-ad-hoc-000000000' });
  } finally {
    global.fetch = original;
  }
  assert.equal(out.ok, true);
  assert.equal(out.model_count, 2);
  assert.equal(seen[0].auth, 'Bearer sk-ad-hoc-000000000', 'the pasted key is what gets sent');
  assert.equal(seen[1].auth, null, 'second probe is unauthenticated on purpose');
  assert.equal(out.auth_checked, true);
});
