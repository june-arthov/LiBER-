// A connector is only real if a call lands on a server. This spins one up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-conn-'));
process.env.LIBER_CONNECTORS_FILE = path.join(dir, 'connectors.json');
const vault = require('../src/daemon/core/vault');
const connectors = require('../src/daemon/core/connectors');

let server;
let base;
const seen = [];

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
      if (req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: true, received: body }));
      } else if (req.url.startsWith('/issues')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: req.url, auth: req.headers.authorization }));
      } else {
        res.writeHead(404); res.end('nope');
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server?.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } });

function writeConfig(list) {
  fs.writeFileSync(process.env.LIBER_CONNECTORS_FILE, JSON.stringify({ connectors: list }));
}

test('a declared connector loads and registers a callable tool', async () => {
  writeConfig([{
    id: 'demo', label: 'Demo API', baseUrl: base,
    headers: { authorization: 'Bearer fixed-token' },
    actions: [
      { name: 'listIssues', method: 'GET', path: '/issues/{owner}/{repo}', description: 'list open issues' },
      { name: 'createIssue', method: 'POST', path: '/issues', description: 'open a new issue' }
    ]
  }]);

  const { connectors: parsed, problems } = connectors.load();
  assert.deepEqual(problems, []);
  assert.equal(parsed[0].id, 'demo');

  const registered = [];
  connectors.install({ register: (t) => registered.push(t) });
  const tool = registered.find(t => t.name === 'conn_demo');
  assert.ok(tool, 'a tool named conn_demo must exist');
  assert.deepEqual(tool.parameters.properties.action.enum, ['listIssues', 'createIssue']);

  const out = await tool.handler({ action: 'listIssues', params: { owner: 'june', repo: 'LiBER-' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.path, '/issues/june/LiBER-');
  assert.equal(out.body.auth, 'Bearer fixed-token');
});

test('POST sends a JSON body and returns the server answer', async () => {
  const [demo] = connectors.load().connectors;
  const out = await connectors.call(demo, 'createIssue', { body: { title: 'from the agent' } });
  assert.equal(out.status, 201);
  assert.equal(out.body.created, true);
  assert.match(out.body.received, /from the agent/);
});

test('a vault reference becomes a real header at call time', async () => {
  vault.set('demo.token', 'Bearer secret-from-vault');
  writeConfig([{
    id: 'secured', label: 'Secured', baseUrl: base,
    headers: { authorization: 'vault:demo.token' },
    actions: [{ name: 'list', method: 'GET', path: '/issues/a/b' }]
  }]);
  const [secured] = connectors.load().connectors;
  const out = await connectors.call(secured, 'list', {});
  assert.equal(out.body.auth, 'Bearer secret-from-vault');
});

test('bad declarations are reported and skipped, not installed half-working', () => {
  writeConfig([
    { id: 'Bad Id', baseUrl: base, actions: [{ name: 'x', path: '/' }] },
    { id: 'ftpish', baseUrl: 'ftp://example.com', actions: [{ name: 'x', path: '/' }] },
    { id: 'empty', baseUrl: base, actions: [] },
    { id: 'good', baseUrl: base, actions: [{ name: 'ping', path: '/issues' }] }
  ]);
  const { connectors: ok, problems } = connectors.load();
  assert.equal(ok.length, 1);
  assert.equal(ok[0].id, 'good');
  assert.equal(problems.length, 3);
});

test('an unknown action names the ones that exist; a missing path param explains itself', async () => {
  writeConfig([{ id: 'demo2', baseUrl: base, actions: [{ name: 'get', method: 'GET', path: '/issues/{owner}/{repo}' }] }]);
  const [demo2] = connectors.load().connectors;
  const wrong = await connectors.call(demo2, 'nope', {});
  assert.match(wrong.error, /Known: get/);
  const missing = await connectors.call(demo2, 'get', { params: { owner: 'a' } });
  assert.match(missing.error, /missing parameter 'repo'/);
});
