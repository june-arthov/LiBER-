// test/grounding.test.js — the audit must block invented claims and accept cited ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EvidenceLedger } = require('../src/daemon/core/evidence');
const grounding = require('../src/daemon/core/grounding');

function readReceipt(ledger, path = 'package.json') {
  return ledger.record('read_file', { path }, { content: '1 | {"version":"0.2.0"}', total_lines: 1, lines_read: 1 });
}

test('blocks an uncited claim about a project file', () => {
  const ledger = new EvidenceLedger('t1');
  const r = grounding.audit('package.json declares version 9.9.9.', ledger);
  assert.equal(r.passed, false);
  assert.ok(r.violations.some(v => v.code === 'UNCITED_CLAIM'));
});

test('accepts the same claim once cited to a real receipt', () => {
  const ledger = new EvidenceLedger('t2');
  const ev = readReceipt(ledger);
  const r = grounding.audit(`package.json declares version 0.2.0 [${ev.id}].`, ledger);
  assert.equal(r.passed, true, JSON.stringify(r.violations));
});

test('rejects a citation to a receipt that does not exist', () => {
  const ledger = new EvidenceLedger('t3');
  const r = grounding.audit('package.json declares version 0.2.0 [E9].', ledger);
  assert.equal(r.passed, false);
  assert.ok(r.violations.some(v => v.code === 'CITATION_UNKNOWN'));
});

test('rejects "I fixed it" with no tool receipt', () => {
  const ledger = new EvidenceLedger('t4');
  const r = grounding.audit('I fixed the bug. All tests pass.', ledger);
  assert.equal(r.passed, false);
  assert.ok(r.violations.some(v => ['PHANTOM_ACTION', 'UNVERIFIED_SUCCESS'].includes(v.code)));
});

test('rejects success claims after a write that was never read back', () => {
  const ledger = new EvidenceLedger('t5');
  ledger.record('write_file', { path: 'src/app.js', content: 'x' }, { success: true, bytes_written: 1 });
  const r = grounding.audit('I created src/app.js.', ledger);
  assert.equal(r.passed, false);
  assert.ok(r.violations.some(v => v.code === 'PENDING_MUTATION_UNVERIFIED'));
});

test('accepts success claims after read-back', () => {
  const ledger = new EvidenceLedger('t6');
  ledger.record('write_file', { path: 'src/app.js', content: 'x' }, { success: true, bytes_written: 1 });
  const read = ledger.record('read_file', { path: 'src/app.js' }, { content: '1 | x', total_lines: 1, lines_read: 1 });
  const r = grounding.audit(`I created src/app.js [${read.id}].`, ledger);
  assert.equal(r.passed, true, JSON.stringify(r.violations));
});

test('honest uncertainty always passes', () => {
  const ledger = new EvidenceLedger('t7');
  const r = grounding.audit('UNVERIFIED: package.json may declare 0.2.0 — no tool receipt.', ledger);
  assert.equal(r.passed, true, JSON.stringify(r.violations));
});

test('general, time-stable knowledge is not audited', () => {
  const ledger = new EvidenceLedger('t8');
  const r = grounding.audit('In JavaScript, Array.prototype.map returns a new array.', ledger);
  assert.equal(r.passed, true, JSON.stringify(r.violations));
});

test('code blocks are exempt so examples are not treated as claims', () => {
  const ledger = new EvidenceLedger('t9');
  const r = grounding.audit('Example:\n```js\nconst v = packageJson.version; // 9.9.9\n```', ledger);
  assert.equal(r.passed, true, JSON.stringify(r.violations));
});

test('user-attributed statements do not need a receipt', () => {
  const ledger = new EvidenceLedger('t10');
  const r = grounding.audit('You said package.json declares 9.9.9.', ledger);
  assert.equal(r.passed, true, JSON.stringify(r.violations));
});

test('inline-code claims are audited, not hidden', () => {
  const ledger = new EvidenceLedger('t10b');
  const r = grounding.audit('The version is `9.9.9`.', ledger);
  assert.equal(r.passed, false);
  assert.ok(r.violations.some(v => ['UNGROUNDED_FACT', 'UNCITED_CLAIM'].includes(v.code)));
});

test('prior-turn recall is accepted only when attributed and flagged stale', () => {
  const ledger = new EvidenceLedger('t10c');
  const r = grounding.audit("From the previous turn's receipts, `package.json` version was `0.3.0`, but it may be stale.", ledger);
  assert.equal(r.passed, true, JSON.stringify(r.violations));
});

test('tests-pass claim requires an executed test receipt', () => {
  const ledger = new EvidenceLedger('t11');
  ledger.record('terminal', { command: 'npm test' }, { exit_code: 0, output: 'ok' });
  const ev = ledger.entries[0];
  const r = grounding.audit(`All tests pass [${ev.id}].`, ledger);
  assert.equal(r.passed, true, JSON.stringify(r.violations));

  const ledger2 = new EvidenceLedger('t12');
  ledger2.record('read_file', { path: 'package.json' }, { content: 'x', total_lines: 1, lines_read: 1 });
  const ev2 = ledger2.entries[0];
  const r2 = grounding.audit(`All tests pass [${ev2.id}].`, ledger2);
  assert.equal(r2.passed, false);
  assert.ok(r2.violations.some(v => v.code === 'UNVERIFIED_SUCCESS'));
});

test('annotation never hides the unresolved claims', () => {
  const ledger = new EvidenceLedger('t13');
  const r = grounding.audit('I fixed the bug.', ledger);
  const out = grounding.annotate('I fixed the bug.', r, ledger);
  assert.match(out, /GROUNDING AUDIT/);
  assert.match(out, /I fixed the bug/);
});
