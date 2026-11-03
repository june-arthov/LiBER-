// test/secrets.test.js — durable state must never store credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-secrets-'));
process.chdir(tmp);

const { find, redact } = require('../src/daemon/core/secrets');
const trace = require('../src/daemon/core/trace');

test('finds common credential shapes', () => {
  const hits = find('api key is sk-abcdefghijklmnopqrstuvwxyz123456 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd');
  assert.ok(hits.some(h => h.type === 'openai_key'));
  assert.ok(hits.some(h => h.type === 'github_token'));
});

test('redacts credentials while keeping surrounding text', () => {
  const out = redact('Send with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 to the server');
  assert.ok(!out.includes('eyJhbGci'));
  assert.match(out, /\[REDACTED:bearer\]/);
});

test('no false positives on ordinary content', () => {
  assert.deepEqual(find('The test suite passes with 45 tests.'), []);
  assert.equal(redact('npm test && node --test'), 'npm test && node --test');
});

test('trace records are written redacted', () => {
  const file = trace.appendTurn({
    agentId: 's',
    model: 'm',
    userMessage: 'use token sk-abcdefghijklmnopqrstuvwxyz123456',
    result: {
      response: 'done with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd',
      grounded: true,
      grounding: { status: 'PASS', ledger: { receipts: [] } }
    }
  });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('sk-abcdef'), 'trace must not store the key');
  assert.ok(!raw.includes('ghp_ABCDEF'), 'trace must not store the token');
});
