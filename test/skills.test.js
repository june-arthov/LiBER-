// test/skills.test.js — progressive-disclosure skill library.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-skills-'));
process.chdir(tmp);

const skills = require('../src/daemon/core/skills');
const { buildSystemPrompt } = require('../src/daemon/core/liber-soul');
const { EvidenceLedger } = require('../src/daemon/core/evidence');

test('ships the full core skill library', () => {
  const all = skills.scan();
  assert.ok(all.length >= 9, `expected >= 9 skills, got ${all.length}`);
  for (const name of ['iron-law', 'grounding-protocol', 'systematic-debugging', 'verification-first', 'performance-triage', 'codebase-orientation']) {
    assert.ok(all.find(s => s.name === name), `missing skill ${name}`);
  }
  assert.equal(all.find(s => s.name === 'iron-law').always, true);
});

test('the index is cheap and lists every skill', () => {
  const index = skills.indexLines();
  for (const s of skills.scan()) {
    assert.ok(index.includes(s.name), `index missing ${s.name}`);
  }
  assert.ok(index.length < 4000, 'index should stay small');
});

test('a debugging request auto-loads the debugging skill body', () => {
  const ctx = skills.buildContext('the build fails with a TypeError stack trace');
  assert.ok(ctx.used.includes('systematic-debugging'), ctx.used.join(','));
  assert.match(ctx.text, /Reproduce/);
});

test('a performance complaint loads performance-triage', () => {
  const ctx = skills.buildContext('kenapa build ini lambat sekali?');
  assert.ok(ctx.used.includes('performance-triage'), ctx.used.join(','));
});

test('budget cap is enforced', () => {
  const ctx = skills.buildContext('fix bug write patch test deploy slow repo', 2500);
  assert.ok(ctx.chars <= 2500, `chars=${ctx.chars}`);
});

test('view returns the body, triggers and attachments', () => {
  const v = skills.view('systematic-debugging');
  assert.equal(v.name, 'systematic-debugging');
  assert.ok(v.body.length > 300);
  assert.ok(Array.isArray(v.triggers));
  assert.match(v.body, /Phase 1/);
});

test('view on an unknown skill fails with the available list', () => {
  const v = skills.view('does-not-exist');
  assert.match(v.error, /not found/);
  assert.match(v.error, /iron-law/);
});

test('search finds a skill by content', () => {
  const r = skills.search('benchmark');
  assert.ok(r.matches.length >= 1);
  assert.equal(r.matches[0].name, 'performance-triage');
});

test('project skills can be created, validated and loaded', () => {
  const bad = skills.writeSkill({ name: 'Bad Name!', description: 'x', body: 'short' });
  assert.equal(bad.validation_failed, true);

  const created = skills.writeSkill({
    name: 'fixture-skill',
    description: 'Use when testing the project-level skill loader.',
    body: 'Step one: read the fixture file and record the receipt. Step two: cite that receipt in the answer.',
    triggers: ['fixture']
  });
  assert.equal(created.success, true, created.error);
  assert.ok(fs.existsSync(path.join(tmp, '.liber', 'skills', 'fixture-skill', 'SKILL.md')));

  const loaded = skills.get('fixture-skill');
  assert.ok(loaded);
  assert.equal(loaded.source, 'project');

  const dup = skills.writeSkill({
    name: 'fixture-skill',
    description: 'Use when testing duplicate protection behaviour.',
    body: 'This body is long enough to pass validation for a duplicate write.'
  });
  assert.match(dup.error, /already exists/);

  const updated = skills.writeSkill({
    name: 'fixture-skill',
    description: 'Use when testing duplicate protection behaviour.',
    body: 'This body is long enough to pass validation for an update write.'
  }, true);
  assert.equal(updated.success, true);
  assert.match(skills.view('fixture-skill').body, /update write/);
});

test('project skill overrides a global skill of the same name', () => {
  skills.writeSkill({
    name: 'honest-refusal',
    description: 'Use when overriding the global refusal skill in a project.',
    body: 'Project-specific refusal procedure with a distinct sentence.'
  }, true);
  const s = skills.get('honest-refusal');
  assert.equal(s.source, 'project');
  assert.match(s.body, /Project-specific/);
});

test('system prompt carries the skill index and the skill tool instruction', () => {
  const ledger = new EvidenceLedger('prompt');
  const prompt = buildSystemPrompt(
    { name: 'dev-bot', system_prompt: 'be precise' },
    '- skill(action): load a skill',
    { ledger, intentText: 'fix the failing test', skillContext: skills.buildContext('fix the failing test').text }
  );
  assert.match(prompt, /SKILLS INDEX/);
  assert.match(prompt, /skill\(\{"action":"view"/);
  assert.match(prompt, /verification-first/);
});
