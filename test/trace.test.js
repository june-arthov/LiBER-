// test/trace.test.js — every completed turn leaves an auditable JSONL record.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-trace-'));
process.chdir(tmp);

const trace = require('../src/daemon/core/trace');

test('appendTurn writes a parseable audit record', () => {
  const file = trace.appendTurn({
    agentId: 'dev-bot',
    model: 'test-model',
    userMessage: 'read package.json',
    result: {
      response: 'version 0.1.0 [E1]',
      grounded: true,
      repairs: 1,
      iterations: 2,
      durationMs: 120,
      grounding: {
        status: 'PASS',
        ledger: { receipts: [{ id: 'E1', tool: 'read_file', ok: true }] }
      }
    }
  });

  assert.ok(file && fs.existsSync(file));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.agentId, 'dev-bot');
  assert.equal(rec.grounding_status, 'PASS');
  assert.deepEqual(rec.receipts, ['E1:read_file']);
  assert.equal(rec.repairs, 1);
});

test('a broken result does not throw', () => {
  assert.doesNotThrow(() => trace.appendTurn({ agentId: 'x', userMessage: 'y', result: {} }));
});
