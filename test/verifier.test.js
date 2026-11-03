// test/verifier.test.js — parsing and gating behaviour of the semantic auditor.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVerdict, buildReceipts, verify } = require('../src/daemon/core/verifier');
const { EvidenceLedger } = require('../src/daemon/core/evidence');

test('parses a verdict wrapped in prose or markdown', () => {
  const raw = 'Here you go:\n```json\n{"unsupported":[{"claim":"version 9.9.9","reason":"not in receipts","receipt":"E1"}]}\n```';
  const parsed = parseVerdict(raw);
  assert.equal(parsed.parse_error, false);
  assert.equal(parsed.unsupported.length, 1);
  assert.equal(parsed.unsupported[0].claim, 'version 9.9.9');
});

test('malformed output fails open as a parse error', () => {
  const parsed = parseVerdict('I could not comply.');
  assert.equal(parsed.parse_error, true);
  assert.deepEqual(parsed.unsupported, []);
});

test('entries without a claim are discarded', () => {
  const parsed = parseVerdict('{"unsupported":[{"reason":"no claim"},{"claim":"x","reason":"y"}]}');
  assert.equal(parsed.unsupported.length, 1);
  assert.equal(parsed.unsupported[0].claim, 'x');
});

test('receipts include the verbatim evidence detail', () => {
  const ledger = new EvidenceLedger('v');
  ledger.record('read_file', { path: 'package.json' }, { content: '1 | {"version":"0.1.0"}', total_lines: 1, lines_read: 1 });
  const text = buildReceipts(ledger);
  assert.match(text, /E1 \[read_file\] OK/);
  assert.match(text, /version/);
});

test('the verifier can see tail numbers of long command output', () => {
  const ledger = new EvidenceLedger('v-long');
  const long = 'line-a\n' + 'x'.repeat(5000) + '\nℹ pass 145\nℹ tests 145';
  ledger.record('terminal', { command: 'npm test' }, { exit_code: 0, output: long });
  const text = buildReceipts(ledger);
  // Root cause of false semantic failures: the pass summary sits at the END.
  assert.match(text, /pass 145/, 'tail must reach the semantic auditor');
});

test('verify skips turns with no receipts', async () => {
  const ledger = new EvidenceLedger('v2');
  const result = await verify({ candidate: 'anything', ledger, llmManager: { generate: async () => { throw new Error('must not call'); } } });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.unsupported, []);
});

test('claims the answer discloses as UNVERIFIED are dropped deterministically', async () => {
  const ledger = new EvidenceLedger('v3');
  ledger.record('read_file', { path: 'package.json' }, { content: '1 | {"version":"0.5.0"}', total_lines: 1, lines_read: 1 });

  let calls = 0;
  const llmManager = {
    generate: async () => {
      calls++;
      return JSON.stringify({ unsupported: [
        { claim: 'the project has 100 tests', reason: 'no receipt shows a test count' },
        { claim: 'version 9.9.9', reason: 'not in the receipt' }
      ] });
    }
  };

  const res = await verify({
    candidate: 'No. UNVERIFIED: the project has 100 tests — no tool receipt. The version is 9.9.9 [E1].',
    ledger,
    llmManager,
    disclosed: ['UNVERIFIED: the project has 100 tests — no tool receipt']
  });

  assert.equal(res.parse_error, false);
  assert.equal(res.unsupported.length, 1, 'the disclosed claim must be filtered out');
  assert.equal(res.unsupported[0].claim, 'version 9.9.9');
  assert.equal(calls, 1);
});

test('verify sends answer + receipts to the model and parses the reply', async () => {
  const ledger = new EvidenceLedger('v3');
  ledger.record('read_file', { path: 'package.json' }, { content: 'version 0.1.0', total_lines: 1, lines_read: 1 });
  let seen = null;
  const llmManager = {
    async generate(messages) {
      seen = messages;
      return '{"unsupported":[]}';
    }
  };
  const result = await verify({ candidate: 'version is 0.1.0 [E1]', ledger, llmManager });
  assert.equal(result.unsupported.length, 0);
  assert.match(seen[0].content, /evidence auditor/);
  assert.match(seen[1].content, /E1 \[read_file\]/);
});

test('verify retries once when the auditor returns prose instead of JSON', async () => {
  const ledger = new EvidenceLedger('v4');
  ledger.record('read_file', { path: 'package.json' }, { content: 'version 0.1.0', total_lines: 1, lines_read: 1 });

  let calls = 0;
  const llmManager = {
    async generate() {
      calls++;
      return calls === 1 ? 'Everything looks supported to me.' : '{"unsupported":[]}';
    }
  };

  const result = await verify({ candidate: 'version is 0.1.0 [E1]', ledger, llmManager });
  assert.equal(calls, 2);
  assert.equal(result.parse_error, false);
  assert.deepEqual(result.unsupported, []);
});

test('verify reports a parse error after both attempts fail', async () => {
  const ledger = new EvidenceLedger('v5');
  ledger.record('read_file', { path: 'package.json' }, { content: 'version 0.1.0', total_lines: 1, lines_read: 1 });

  let calls = 0;
  const llmManager = {
    async generate() {
      calls++;
      return 'still not json';
    }
  };

  const result = await verify({ candidate: 'version is 0.1.0 [E1]', ledger, llmManager });
  assert.equal(calls, 2);
  assert.equal(result.parse_error, true);
});
