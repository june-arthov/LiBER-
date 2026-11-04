// Connector and JSON receipts must keep the field the model cites. Before this,
// a GitHub-shaped answer was "UNVERIFIED" because the excerpt stopped at 400
// characters of JSON.stringify — the default_branch field was simply not there.
const test = require('node:test');
const assert = require('node:assert');
const { EvidenceLedger } = require('../src/daemon/core/evidence');

function ledger() {
  return new EvidenceLedger('test-agent');
}

test('a JSON tool result keeps its scalar fields in the detail', () => {
  const L = ledger();
  const result = {
    connector: 'github',
    action: 'repo',
    status: 200,
    ok: true,
    body: {
      id: 1444603560,
      name: 'LiBER-',
      full_name: 'june-arthov/LiBER-',
      default_branch: 'main',
      stargazers_count: 0,
      pushed_at: '2026-11-04T15:06:46Z',
      owner: { login: 'june-arthov', type: 'User' },
      topics: ['agent', 'harness']
    }
  };
  const entry = L.record('conn_github', { action: 'repo' }, result, {});
  const detail = entry.detail;

  assert.match(detail, /default_branch=main/, 'the cited branch must be in the receipt');
  assert.match(detail, /stargazers_count=0/);
  assert.match(detail, /pushed_at=2026-11-04T15:06:46Z/);
  assert.match(detail, /body\.owner\.login=june-arthov/, 'nested fields keep their path');
});

test('fetch_url JSON text is flattened too, not truncated into the middle', () => {
  const L = ledger();
  const payload = JSON.stringify({ items: [{ title: 'first' }], meta: { total: 2 }, default_branch: 'main' });
  const entry = L.record('fetch_url', { url: 'https://api.example.com/x' }, { status: 200, chars: payload.length, content: payload }, {});
  assert.match(entry.detail, /default_branch=main/);
  assert.match(entry.detail, /meta\.total=2/);
});

test('plain text results are unchanged by the flattening', () => {
  const L = ledger();
  const entry = L.record('conn_x', { action: 'raw' }, { ok: true, body: 'line one\nline two' }, {});
  assert.match(entry.detail, /line one/);
  assert.match(entry.detail, /line two/);
});
