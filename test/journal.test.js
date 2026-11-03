// test/journal.test.js — crash-safe turn journal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-journal-'));
process.chdir(tmp);

const journal = require('../src/daemon/core/journal');

test('saves, loads and clears a turn state', () => {
  const state = {
    agentId: 'dev-bot',
    userMessage: 'read package.json',
    messages: [{ role: 'user', content: 'read package.json' }],
    ledger: { agentId: 'dev-bot', receipts: [{ id: 'E1' }] },
    repairs: 0,
    iteration: 2
  };

  const file = journal.save(state);
  assert.ok(file && fs.existsSync(file));

  const loaded = journal.load('dev-bot');
  assert.equal(loaded.iteration, 2);
  assert.equal(loaded.userMessage, 'read package.json');

  const list = journal.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].agentId, 'dev-bot');
  assert.equal(list[0].iteration, 2);

  journal.clear('dev-bot');
  assert.equal(journal.load('dev-bot'), null);
  assert.equal(journal.list().length, 0);
});

test('agent ids are made filesystem-safe', () => {
  journal.save({ agentId: 'dev-bot::sub1', userMessage: 'x', messages: [], iteration: 1 });
  const list = journal.list();
  assert.ok(list.some(t => t.agentId === 'dev-bot::sub1'));
  journal.clear('dev-bot::sub1');
});

test('load returns null for an unknown agent', () => {
  assert.equal(journal.load('nobody'), null);
});
