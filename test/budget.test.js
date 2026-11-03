// test/budget.test.js — daily token/cost guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-budget-'));
process.chdir(tmp);

const budget = require('../src/daemon/core/budget');

test('token budget blocks once exhausted', () => {
  budget.reset();
  const limits = { max_tokens_per_day: 100 };

  assert.equal(budget.check(limits, {}).allowed, true);
  budget.record({ prompt_tokens: 60, completion_tokens: 50, total_tokens: 110 }, {});

  const after = budget.check(limits, {});
  assert.equal(after.allowed, false);
  assert.match(after.reason, /token budget exhausted/i);
});

test('cost budget is enforced only when prices are configured', () => {
  budget.reset();
  const limits = { max_cost_per_day: 0.01 };
  const engine = { price_in_per_1k: 1, price_out_per_1k: 1 };

  assert.equal(budget.check(limits, engine).allowed, true);
  budget.record({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, engine);

  const after = budget.check(limits, engine);
  assert.equal(after.allowed, false);
  assert.match(after.reason, /cost budget exhausted/i);
  assert.ok(after.spent_usd >= 0.01);

  // Without prices the same spend is not treated as a monetary breach.
  const unpriced = budget.check(limits, {});
  assert.equal(unpriced.allowed, true);
});

test('state persists to disk and resets per day', () => {
  budget.reset();
  budget.record({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, {});

  const file = path.resolve(tmp, '.liber', 'budget.json');
  assert.ok(fs.existsSync(file));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.total_tokens, 10);

  const stale = { ...saved, date: '1999-01-01' };
  fs.writeFileSync(file, JSON.stringify(stale), 'utf8');

  // Force a reload by resetting the module cache state via a fresh require.
  delete require.cache[require.resolve('../src/daemon/core/budget')];
  const fresh = require('../src/daemon/core/budget');
  assert.equal(fresh.snapshot().total_tokens, 0, 'a new day starts at zero');
});
