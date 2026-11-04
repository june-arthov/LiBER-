// Reproduces the false positive from a real turn: the receipt held
// "background RGB (6, 182, 212)" and the answer wrote "6,182,212". The audit
// compared raw substrings, so a correctly cited number was flagged
// NUMBER_UNSUPPORTED and the reply shipped with a warning banner.
const test = require('node:test');
const assert = require('node:assert');
const grounding = require('../src/daemon/core/grounding');
const { EvidenceLedger } = require('../src/daemon/core/evidence');

function auditWith(detail, text) {
  const ledger = new EvidenceLedger('test-agent');
  ledger.record('read_file', { path: 'src/cli/ui.js' }, { content: detail, lines_read: 1, total_lines: 1 });
  return grounding.audit(text, ledger, { requireReadback: false, requireCitations: true });
}

const numbers = res => (res.violations || []).filter(v => v.code === 'NUMBER_UNSUPPORTED');

test('a number written with different spacing than the receipt is still supported', () => {
  const detail = 'const ACCENT = [6, 182, 212]; // truecolor background';
  const res = auditWith(detail, 'The accent is RGB 6,182,212 [E1].');
  assert.equal(numbers(res).length, 0, `spacing should not create a violation: ${JSON.stringify(numbers(res))}`);
});

test('a number that is absent from the receipt is still flagged', () => {
  const detail = 'const ACCENT = [6, 182, 212];';
  const res = auditWith(detail, 'The accent is RGB 9,999,888 [E1].');
  assert.equal(numbers(res).length, 1, 'an invented number must not pass');
});

test('thousands separators do not matter in either direction', () => {
  const detail = 'total_tokens: 1,234,567';
  const res = auditWith(detail, 'The run used 1234567 tokens in total [E1].');
  assert.equal(numbers(res).length, 0, 'a formatted total should match the raw one');
});
