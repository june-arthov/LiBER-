// src/daemon/core/automations.js — scheduled prompt runs.
// A job is a prompt plus a schedule; the daemon ticks and runs whatever is due
// through the same engine a manual turn uses, so grounding and policy apply.
const fs = require('fs');
const path = require('path');

const FILE = () => process.env.LIBER_AUTOMATIONS_FILE || path.resolve(process.cwd(), '.liber', 'automations.json');
const MAX_JOBS = 20;

function nowMs() { return Date.now(); }

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
    return { jobs: jobs.map(normalise).filter(Boolean) };
  } catch {
    return { jobs: [] };
  }
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify({ jobs: state.jobs }, null, 2), 'utf8');
  } catch { /* a scheduler must never break the daemon */ }
}

/** Coerce whatever came from the API into a job we can schedule. */
function normalise(job) {
  if (!job || typeof job !== 'object') return null;
  const prompt = String(job.prompt || '').trim();
  if (!prompt) return null;
  const sch = job.schedule || {};
  const type = sch.type === 'daily' ? 'daily' : 'interval';
  const schedule = type === 'daily'
    ? { type, at: /^\d{1,2}:\d{2}$/.test(String(sch.at || '')) ? String(sch.at) : '09:00' }
    : { type, minutes: Math.min(1440, Math.max(1, Number(sch.minutes) || 30)) };
  return {
    id: String(job.id || `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`),
    name: String(job.name || 'Automation').slice(0, 60),
    prompt,
    schedule,
    enabled: job.enabled !== false,
    createdAt: job.createdAt || new Date().toISOString(),
    lastRunAt: job.lastRunAt || null,
    lastResult: job.lastResult || null,
    runCount: Number(job.runCount) || 0
  };
}

/** Milliseconds until this job should fire again (null = never run yet). */
function dueIn(job, from = nowMs()) {
  if (!job.enabled) return null;
  const last = job.lastRunAt ? Date.parse(job.lastRunAt) : null;

  if (job.schedule.type === 'interval') {
    if (last === null) return 0;
    const next = last + job.schedule.minutes * 60_000;
    return Math.max(0, next - from);
  }

  // daily at HH:MM local time: fire once per day, at the slot, and never twice
  const [hh, mm] = job.schedule.at.split(':').map(Number);
  const slot = new Date(from);
  slot.setHours(hh, mm, 0, 0);
  const DAY = 24 * 60 * 60 * 1000;
  const ranSinceSlot = last !== null && last >= slot.getTime() - 1000 && last < slot.getTime() + DAY;
  if (ranSinceSlot) return slot.getTime() + DAY - from;
  return slot.getTime() <= from ? 0 : slot.getTime() - from;
}

const isDue = (job, from = nowMs()) => dueIn(job, from) === 0;

function list() {
  const state = load();
  return state.jobs.map(j => ({ ...j, due_in_ms: dueIn(j), due: isDue(j) }));
}

function create(input) {
  const state = load();
  if (state.jobs.length >= MAX_JOBS) {
    return { ok: false, error: `Too many automations (max ${MAX_JOBS}).` };
  }
  const job = normalise({ ...input, id: null, lastRunAt: null, lastResult: null, runCount: 0 });
  if (!job) return { ok: false, error: 'A prompt is required.' };
  state.jobs.push(job);
  save(state);
  return { ok: true, job };
}

function update(id, patch = {}) {
  const state = load();
  const i = state.jobs.findIndex(j => j.id === id);
  if (i < 0) return { ok: false, error: `No automation '${id}'.` };
  const merged = normalise({ ...state.jobs[i], ...patch, id: state.jobs[i].id });
  if (!merged) return { ok: false, error: 'A prompt is required.' };
  state.jobs[i] = merged;
  save(state);
  return { ok: true, job: merged };
}

function remove(id) {
  const state = load();
  const before = state.jobs.length;
  state.jobs = state.jobs.filter(j => j.id !== id);
  if (state.jobs.length === before) return { ok: false, error: `No automation '${id}'.` };
  save(state);
  return { ok: true, removed: id };
}

/** Record a finished run: this is what makes the tick idempotent. */
function markRun(id, result = {}) {
  const state = load();
  const job = state.jobs.find(j => j.id === id);
  if (!job) return null;
  job.lastRunAt = new Date().toISOString();
  job.runCount = Number(job.runCount || 0) + 1;
  job.lastResult = {
    ok: result.ok !== false,
    chars: Number(result.chars) || 0,
    excerpt: String(result.excerpt || '').replace(/\s+/g, ' ').slice(0, 200),
    error: result.error ? String(result.error).slice(0, 200) : null,
    at: job.lastRunAt
  };
  save(state);
  return job;
}

module.exports = { list, create, update, remove, markRun, dueIn, isDue, normalise, FILE, MAX_JOBS };
