// test/grounding-eval.test.js — regression dataset for the grounding gate.
// Every case asserts the exact outcome: a claim that should be blocked must stay blocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EvidenceLedger } = require('../src/daemon/core/evidence');
const grounding = require('../src/daemon/core/grounding');
const cases = require('./fixtures/claims.json').cases;

let blocked = 0;
let passed = 0;

for (const c of cases) {
  test(`eval: ${c.id} (${c.expect})`, () => {
    const ledger = new EvidenceLedger(`eval-${c.id}`);
    for (const r of c.receipts || []) {
      ledger.record(r.tool, r.args || {}, r.result || {});
    }
    const res = grounding.audit(c.answer, ledger, { requireReadback: true, requireCitations: true });

    assert.equal(
      res.passed,
      c.expect === 'pass',
      `violations: ${JSON.stringify(res.violations)}`
    );

    for (const code of c.codes || []) {
      assert.ok(
        res.violations.some(v => v.code === code),
        `expected ${code}, got ${JSON.stringify(res.violations.map(v => v.code))}`
      );
    }

    if (c.expect === 'pass') passed++;
    else blocked++;
  });
}

test('eval dataset has a healthy mix of outcomes', () => {
  assert.ok(blocked >= 6, `too few blocked cases (${blocked})`);
  assert.ok(passed >= 6, `too few passing cases (${passed})`);
});
