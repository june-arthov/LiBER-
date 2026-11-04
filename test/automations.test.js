// The scheduler's only real risk is firing twice (or never). These tests pin the
// due-time logic and the store, without touching the daemon.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FILE = path.join(os.tmpdir(), `liber-automations-${process.pid}.json`);
process.env.LIBER_AUTOMATIONS_FILE = FILE;

const auto = require('../src/daemon/core/automations');

function reset() {
  try { fs.unlinkSync(FILE); } catch { /* first run */ }
}

test('a new interval job is due immediately, then not again until the interval passes', () => {
  reset();
  const { ok, job } = auto.create({ name: 'ping', prompt: 'say ok', schedule: { type: 'interval', minutes: 5 } });
  assert.equal(ok, true);

  const t0 = Date.parse('2026-01-01T10:00:00Z');
  assert.equal(auto.isDue(job, t0), true, 'never run yet: due now');

  const ran = { ...job, lastRunAt: new Date(t0).toISOString() };
  assert.equal(auto.isDue(ran, t0 + 60_000), false, 'one minute later: not due');
  assert.equal(auto.isDue(ran, t0 + 5 * 60_000), true, 'five minutes later: due');
  assert.equal(auto.dueIn(ran, t0), 5 * 60_000);
});

test('a daily job fires at its local time and not twice in the same day', () => {
  reset();
  const { job } = auto.create({ name: 'morning', prompt: 'report', schedule: { type: 'daily', at: '09:00' } });
  const before = new Date(2026, 0, 2, 8, 30).getTime();
  const after = new Date(2026, 0, 2, 9, 5).getTime();
  const sameDayLater = new Date(2026, 0, 2, 18, 0).getTime();

  assert.equal(auto.isDue(job, before), false, 'not before 09:00');
  assert.equal(auto.isDue(job, after), true, 'due after 09:00 when never run');
  const ran = { ...job, lastRunAt: new Date(after).toISOString() };
  assert.equal(auto.isDue(ran, after + 60_000), false, 'does not fire twice');
  assert.equal(auto.isDue(ran, new Date(2026, 0, 3, 9, 1).getTime()), true, 'fires again the next day');
});

test('a disabled job is never due', () => {
  reset();
  const { job } = auto.create({ name: 'off', prompt: 'x', enabled: false, schedule: { type: 'interval', minutes: 1 } });
  assert.equal(auto.dueIn(job), null);
  assert.equal(auto.isDue(job), false);
});

test('the store round-trips, updates, and caps junk input', () => {
  reset();
  const a = auto.create({ name: 'one', prompt: 'p1', schedule: { type: 'interval', minutes: 99999 } });
  assert.equal(a.job.schedule.minutes, 1440, 'interval is clamped');

  const bad = auto.create({ name: 'no prompt', prompt: '   ', schedule: { type: 'interval', minutes: 5 } });
  assert.equal(bad.ok, false);

  auto.update(a.job.id, { enabled: false, name: 'renamed' });
  const listed = auto.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'renamed');
  assert.equal(listed[0].enabled, false);

  auto.markRun(a.job.id, { ok: true, chars: 42, excerpt: 'done' });
  const after = auto.list()[0];
  assert.equal(after.runCount, 1);
  assert.equal(after.lastResult.chars, 42);
  assert.ok(after.lastRunAt);

  auto.remove(a.job.id);
  assert.equal(auto.list().length, 0);
});

test('markRun on an unknown id is a no-op, not a crash', () => {
  reset();
  assert.equal(auto.markRun('nope', { ok: true }), null);
});
