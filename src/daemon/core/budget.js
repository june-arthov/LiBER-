// src/daemon/core/budget.js — daily spend/token guard.
// Money is enforced only when per-1k prices are configured; tokens are always enforced.
const fs = require('fs');
const path = require('path');

// LIBER_BUDGET_FILE lets tests run against a scratch file instead of the live counter.
const FILE = () => process.env.LIBER_BUDGET_FILE || path.resolve(process.cwd(), '.liber', 'budget.json');

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

/** Drop the in-memory copy so the next read comes from disk. */
function reload() {
  state = null;
  return load();
}

/** A limit of 0 means "no limit", which is what the settings panel promises. */
function limitOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
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
  const limitUsd = limitOf(limits.max_cost_per_day);
  const limitTokens = limitOf(limits.max_tokens_per_day);
  const priced = !!priceOf(engineConfig);

  let allowed = true;
  let reason;

  if (limitTokens !== null && s.total_tokens >= limitTokens) {
    allowed = false;
    reason = `Daily token budget exhausted (${s.total_tokens}/${limitTokens} tokens). Raise limits.max_tokens_per_day, set it to 0 for no limit, or reset today's counter in Settings → Advanced → Budget.`;
  }
  if (priced && limitUsd !== null && s.cost_usd >= limitUsd) {
    allowed = false;
    reason = `Daily cost budget exhausted ($${s.cost_usd.toFixed(4)}/$${limitUsd.toFixed(2)}). Raise limits.max_cost_per_day, set it to 0 for no limit, or reset today's counter.`;
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

/** Everything the UI needs to show headroom before a turn is refused. */
function summary(limits = {}, engineConfig = {}) {
  const s = load();
  const r = check(limits, engineConfig);
  const remaining = r.limit_tokens === null ? null : Math.max(0, r.limit_tokens - s.total_tokens);
  const percent = r.limit_tokens === null || r.limit_tokens === 0
    ? null
    : Math.min(100, Math.round((s.total_tokens / r.limit_tokens) * 100));
  return {
    date: s.date,
    calls: s.calls,
    spent_tokens: s.total_tokens,
    spent_usd: Number(s.cost_usd.toFixed(6)),
    limit_tokens: r.limit_tokens,
    limit_usd: r.limit_usd,
    remaining_tokens: remaining,
    percent_used: percent,
    allowed: r.allowed,
    reason: r.reason || null
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

/**
 * Media calls are priced per call, not per token. They land in the same daily cost
 * counter so limits.max_cost_per_day covers them too.
 */
function recordSpend(costUsd, label = 'media') {
  const amount = Number(costUsd);
  if (!Number.isFinite(amount) || amount <= 0) return load();
  const s = load();
  s.cost_usd += amount;
  s.calls += 1;
  s.by_kind = { ...(s.by_kind || {}) };
  s.by_kind[label] = Number(s.by_kind[label] || 0) + amount;
  save();
  return s;
}

function snapshot() {
  return { ...load() };
}

module.exports = { check, summary, record, recordSpend, reset, reload, snapshot, costOf, priceOf, today };
