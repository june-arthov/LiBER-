// test/evidence.test.js — receipts, verification tracking, and digests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EvidenceLedger } = require('../src/daemon/core/evidence');

test('records sequential receipt ids with tool metadata', () => {
  const ledger = new EvidenceLedger('a');
  const e1 = ledger.record('read_file', { path: 'a.txt' }, { content: 'x', total_lines: 1, lines_read: 1 });
  const e2 = ledger.record('terminal', { command: 'node -v' }, { exit_code: 0, output: 'v26.12.1' });
  assert.equal(e1.id, 'E1');
  assert.equal(e2.id, 'E2');
  assert.equal(e1.kind, 'read');
  assert.equal(e2.kind, 'command');
  assert.equal(e2.exit_code, 0);
  assert.ok(e1.hash && e1.hash.length === 12);
});

test('failed tools never count as verification', () => {
  const ledger = new EvidenceLedger('b');
  const ev = ledger.record('terminal', { command: 'npm test' }, { exit_code: 1, output: '1 failing' });
  assert.equal(ev.ok, false);
  assert.equal(ledger.okEntries().length, 0);
});

test('write sets pending verification; read-back clears it', () => {
  const ledger = new EvidenceLedger('c');
  ledger.record('write_file', { path: 'src/x.js', content: 'a' }, { success: true, bytes_written: 1 });
  assert.equal(ledger.unresolvedPending().length, 1);

  ledger.record('read_file', { path: 'src/x.js' }, { content: 'a', total_lines: 1, lines_read: 1 });
  assert.equal(ledger.unresolvedPending().length, 0);
});

test('green test run verifies outstanding mutations', () => {
  const ledger = new EvidenceLedger('d');
  ledger.record('patch', { path: 'src/x.js', old_string: 'a', new_string: 'b' }, { success: true, strategy: 'exact' });
  assert.equal(ledger.unresolvedPending().length, 1);
  ledger.record('terminal', { command: 'npm test' }, { exit_code: 0, output: 'pass' });
  assert.equal(ledger.unresolvedPending().length, 0);
});

test('red test run keeps the mutation unverified', () => {
  const ledger = new EvidenceLedger('e');
  ledger.record('write_file', { path: 'src/x.js', content: 'a' }, { success: true, bytes_written: 1 });
  ledger.record('terminal', { command: 'npm test' }, { exit_code: 1, output: 'fail' });
  assert.equal(ledger.unresolvedPending().length, 1);
});

test('digest exposes ids the model can cite', () => {
  const ledger = new EvidenceLedger('f');
  ledger.record('read_file', { path: 'package.json' }, { content: '{}', total_lines: 1, lines_read: 1 });
  const digest = ledger.digest();
  assert.match(digest, /E1 read_file ok/);
  assert.match(digest, /package\.json/);
});

test('invalid-argument results are recorded as failures', () => {
  const ledger = new EvidenceLedger('g');
  const ev = ledger.record('read_file', {}, { error: 'Invalid arguments', validation_failed: true });
  assert.equal(ev.ok, false);
});

test('ledger round-trips through toJSON/fromJSON for resume', () => {
  const ledger = new EvidenceLedger('r');
  const a = ledger.record('read_file', { path: 'a.txt' }, { content: 'x', total_lines: 1, lines_read: 1 });
  const b = ledger.record('write_file', { path: 'b.txt', content: 'y' }, { success: true, bytes_written: 1 });

  const restored = EvidenceLedger.fromJSON(ledger.toJSON());
  assert.equal(restored.entries.length, 2);
  assert.equal(restored.entries[0].id, a.id);
  assert.equal(restored.entries[1].id, b.id);
  assert.equal(restored.unresolvedPending().length, 1);
  assert.equal(restored.hasReceipt('E1'), true);
  // New receipts continue the sequence, never collide.
  const c = restored.record('terminal', { command: 'echo hi' }, { exit_code: 0, output: 'hi' });
  assert.equal(c.id, 'E3');
});

test('command receipts keep both head and tail of long output', () => {
  const ledger = new EvidenceLedger('t-long');
  const long = 'HEAD-MARKER\n' + 'x'.repeat(5000) + '\nℹ pass 145\nℹ tests 145';
  const ev = ledger.record('terminal', { command: 'npm test' }, { exit_code: 0, output: long });
  assert.ok(ev.detail.includes('HEAD-MARKER'), 'head must be kept');
  assert.ok(ev.detail.includes('pass 145'), 'tail must be kept');
  assert.match(ev.detail, /chars omitted/);
});

test('read receipts keep both head and tail of long files', () => {
  const ledger = new EvidenceLedger('t-longread');
  const long = 'first-line\n' + 'y'.repeat(1500) + '\nlast-line-visible';
  const ev = ledger.record('read_file', { path: 'big.txt' }, { content: long, total_lines: 3, lines_read: 3 });
  assert.ok(ev.detail.includes('first-line'));
  assert.ok(ev.detail.includes('last-line-visible'));
});
