// The budget guard blocked a working agent twice in one day, and the settings
// panel documents 0 as "unlimited" while the guard read it as "zero allowed".
// Both are the same class of bug: a limit that cannot be escaped without
// editing JSON by hand.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const BUDGET_FILE = path.join(require('os').tmpdir(), `liber-budget-test-${process.pid}.json`);
process.env.LIBER_BUDGET_FILE = BUDGET_FILE;
const budget = require('../src/daemon/core/budget');

const FILE = BUDGET_FILE;

function withState(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, calls: 0, ...state
  }, null, 2), 'utf8');
  budget.reload();
}

test('a limit of 0 means unlimited, as the settings panel promises', () => {
  withState({ total_tokens: 5_000_000 });
  const r = budget.check({ max_tokens_per_day: 0 }, {});
  assert.equal(r.allowed, true, '0 must not mean "zero tokens allowed"');
  assert.equal(r.limit_tokens, null);
});

test('a real limit still blocks once it is reached', () => {
  withState({ total_tokens: 2_000_010 });
  const r = budget.check({ max_tokens_per_day: 2_000_000 }, {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /token budget/i);
});

test('raising the limit unblocks the same spent state', () => {
  withState({ total_tokens: 2_000_010 });
  assert.equal(budget.check({ max_tokens_per_day: 2_000_000 }, {}).allowed, false);
  assert.equal(budget.check({ max_tokens_per_day: 8_000_000 }, {}).allowed, true);
});

test('reset clears the day so the next turn can run', () => {
  withState({ total_tokens: 2_000_010 });
  assert.equal(budget.check({ max_tokens_per_day: 2_000_000 }, {}).allowed, false);
  budget.reset();
  const r = budget.check({ max_tokens_per_day: 2_000_000 }, {});
  assert.equal(r.allowed, true);
  assert.equal(r.spent_tokens, 0);
});

test('a cost limit of 0 means unlimited too', () => {
  withState({ cost_usd: 99 });
  const r = budget.check({ max_cost_per_day: 0 }, { price_in_per_1k: 1, price_out_per_1k: 1 });
  assert.equal(r.allowed, true);
});

test('the summary reports remaining headroom for the UI', () => {
  withState({ total_tokens: 1_500_000 });
  const s = budget.summary({ max_tokens_per_day: 2_000_000 }, {});
  assert.equal(s.spent_tokens, 1_500_000);
  assert.equal(s.remaining_tokens, 500_000);
  assert.equal(s.percent_used, 75);
  assert.equal(s.allowed, true);
});
