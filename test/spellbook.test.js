// test/spellbook.test.js — the doctrine must load and be selected by intent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAll, loadDoctrine, MODULES } = require('../src/daemon/core/spellbook');
const { buildSystemPrompt, IRON_LAW } = require('../src/daemon/core/merlin-soul');
const { EvidenceLedger } = require('../src/daemon/core/evidence');

test('all doctrine modules are present on disk', () => {
  const modules = loadAll();
  assert.equal(modules.length, MODULES.length);
  for (const m of modules) {
    assert.ok(m.body.length > 200, `${m.id} looks empty`);
  }
});

test('iron law and grounding are injected on every turn', () => {
  const pick = loadDoctrine('hello there');
  assert.ok(pick.used.includes('iron-law'));
  assert.ok(pick.used.includes('grounding'));
  assert.match(IRON_LAW, /NO CLAIM WITHOUT A RECEIPT/);
});

test('debugging intent selects the systematic-debugging doctrine', () => {
  const pick = loadDoctrine('the build fails with a stack trace and a TypeError');
  assert.ok(pick.used.includes('debugging'));
});

test('build intent selects verification-first', () => {
  const pick = loadDoctrine('write a patch and run the tests');
  assert.ok(pick.used.includes('verification'));
});

test('system prompt carries doctrine, ledger ids and the citation rule', () => {
  const ledger = new EvidenceLedger('prompt');
  ledger.record('read_file', { path: 'package.json' }, { content: '{}', total_lines: 1, lines_read: 1 });
  const prompt = buildSystemPrompt(
    { name: 'dev-bot', system_prompt: 'be precise' },
    '- read_file(path): read a file',
    { ledger, intentText: 'fix the failing test', doctrine: loadDoctrine('fix the failing test').text }
  );
  assert.match(prompt, /E1 read_file ok/);
  assert.match(prompt, /NO CLAIM WITHOUT A RECEIPT/);
  assert.match(prompt, /\[E#\]/);
  assert.match(prompt, /Systematic Debugging/);
});

test('budget cap is respected', () => {
  const pick = loadDoctrine('fix bug write patch test deploy', 1200);
  assert.ok(pick.chars <= 1200);
});
