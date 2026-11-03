// src/daemon/core/budget.js — daily spend/token guard.
// Money is enforced only when per-1k prices are configured; tokens are always enforced.
const fs = require('fs');
const path = require('path');

const FILE = () => path.resolve(process.cwd(), '.liber', 'budget.json');

let state = null;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function emptyState() {
  return { date: today(), prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, calls: 0 };
}

function load() {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    state = parsed && parsed.date === today() ? { ...emptyState(), ...parsed } : emptyState();
  } catch {
    state = emptyState();
  }
  return state;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(load(), null, 2), 'utf8');
  } catch {
    // budget persistence must never break a turn
  }
}

function reset() {
  state = emptyState();
  save();
}

function priceOf(engineConfig = {}) {
  const inPrice = Number(engineConfig.price_in_per_1k);
  const outPrice = Number(engineConfig.price_out_per_1k);
  return Number.isFinite(inPrice) && Number.isFinite(outPrice)
    ? { inPrice, outPrice }
    : null;
}

function costOf(usage, engineConfig) {
  const price = priceOf(engineConfig);
  if (!price || !usage) return 0;
  return (
    (Number(usage.prompt_tokens || 0) / 1000) * price.inPrice +
    (Number(usage.completion_tokens || 0) / 1000) * price.outPrice
  );
}

/**
 * @returns {{allowed:boolean, reason?:string, spent_usd:number, spent_tokens:number, limit_usd:number|null, limit_tokens:number|null}}
 */
function check(limits = {}, engineConfig = {}) {
  const s = load();
  const limitUsd = Number.isFinite(Number(limits.max_cost_per_day)) ? Number(limits.max_cost_per_day) : null;
  const limitTokens = Number.isFinite(Number(limits.max_tokens_per_day)) ? Number(limits.max_tokens_per_day) : null;
  const priced = !!priceOf(engineConfig);

  let allowed = true;
  let reason;

  if (limitTokens !== null && s.total_tokens >= limitTokens) {
    allowed = false;
    reason = `Daily token budget exhausted (${s.total_tokens}/${limitTokens} tokens).`;
  }
  if (priced && limitUsd !== null && s.cost_usd >= limitUsd) {
    allowed = false;
    reason = `Daily cost budget exhausted ($${s.cost_usd.toFixed(4)}/$${limitUsd.toFixed(2)}).`;
  }

  return {
    allowed,
    reason,
    spent_usd: s.cost_usd,
    spent_tokens: s.total_tokens,
    limit_usd: priced ? limitUsd : null,
    limit_tokens: limitTokens
  };
}

function record(usage, engineConfig = {}) {
  if (!usage) return load();
  const s = load();
  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);
  s.prompt_tokens += prompt;
  s.completion_tokens += completion;
  s.total_tokens += Number(usage.total_tokens || prompt + completion);
  s.cost_usd += costOf(usage, engineConfig);
  s.calls += 1;
  save();
  return s;
}

function snapshot() {
  return { ...load() };
}

module.exports = { check, record, reset, snapshot, costOf, priceOf, today };
