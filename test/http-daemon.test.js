// The HTTP surface, exercised over a real socket: auth, CORS, the tokenless routes
// and the kill switch. Unit tests prove functions; this proves the product.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-http-'));
process.chdir(dir);
process.env.LIBER_PORT = '0';
process.env.LIBER_BUDGET_FILE = path.join(dir, '.liber', 'budget.json');

fs.writeFileSync(path.join(dir, 'liber.yaml'), [
  'agent:',
  '  name: "test-bot"',
  '  version: "0.0.1"',
  '  system_prompt: "test"',
  '  engine:',
  '    provider: "openai"',
  '    model: "test-model"',
  '    endpoint: "http://127.0.0.1:9/v1"',
  '    apiKey: "test-key"',
  'limits:',
  '  max_tokens_per_day: 0',
  'memory:',
  '  persist: false',
  'policy:',
  '  terminal:',
  '    mode: "allowlist"',
  ''
].join('\n'));

const daemon = require('../src/daemon/liberd');

let base = '';
let token = '';

test.before(async () => {
  await daemon.start(path.join(dir, 'liber.yaml'));
  const port = daemon.server.address().port;
  base = `http://127.0.0.1:${port}`;
  token = fs.readFileSync(path.join(dir, '.liber', 'daemon.token'), 'utf8').trim();
});

test.after(() => daemon.stop());

test('the daemon answers its liveness probe without a token', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true });
});

test('stateful routes refuse an unauthenticated caller', async () => {
  for (const route of ['/ps', '/config', '/sessions', '/vault']) {
    const res = await fetch(base + route);
    assert.strictEqual(res.status, 401, route);
    const body = await res.json();
    assert.strictEqual(body.success, false);
  }
});

test('a bearer token opens the same routes', async () => {
  const res = await fetch(`${base}/ps`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.success, true);
  assert.ok(Array.isArray(body.data));
});

test('a wrong token is refused, not silently downgraded', async () => {
  const res = await fetch(`${base}/ps`, { headers: { Authorization: 'Bearer nope' } });
  assert.strictEqual(res.status, 401);
});

test('CORS reflects loopback only', async () => {
  const hostile = await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(hostile.headers.get('access-control-allow-origin'), null);

  const shell = await fetch(`${base}/healthz`, { headers: { Origin: 'http://127.0.0.1:5173' } });
  assert.strictEqual(shell.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
  assert.strictEqual(shell.headers.get('vary'), 'Origin');
});

test('an unknown share id is a 404 with no token, and never cached', async () => {
  const res = await fetch(`${base}/shared/deadbeefdeadbeefdeadbeefdeadbeef`);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
});

test('the kill switch is reachable and answers with the agent it marked', async () => {
  const res = await fetch(`${base}/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'test-bot' })
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.agentId, 'test-bot');
  assert.strictEqual(typeof body.killed, 'number');
});

test('sharing a session that does not exist is refused', async () => {
  const res = await fetch(`${base}/sessions/share`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'test-bot#missing' })
  });
  assert.strictEqual(res.status, 404);
});
