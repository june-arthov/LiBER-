// test/memory.test.js — session persistence across daemon restarts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-memory-'));
process.chdir(tmp);

const memory = require('../src/daemon/core/memory');
const MemoryManager = memory.constructor;

test('window trims to the configured size', () => {
  const m = new MemoryManager(3);
  for (let i = 0; i < 6; i++) m.add('a', 'user', `m${i}`);
  const history = m.get('a');
  assert.equal(history.length, 3);
  assert.equal(history[0].content, 'm3');
});

test('session survives a restart via the persisted file', () => {
  const m1 = new MemoryManager(5);
  const file = m1.attach('.liber/session.json');
  m1.add('agent-x', 'user', 'remember this');
  m1.add('agent-x', 'assistant', 'noted');

  assert.ok(fs.existsSync(file));
  const m2 = new MemoryManager(5);
  m2.attach('.liber/session.json');
  const restored = m2.get('agent-x');
  assert.equal(restored.length, 2);
  assert.equal(restored[0].content, 'remember this');
});

test('clear wipes the persisted session', () => {
  const m = new MemoryManager(5);
  m.attach('.liber/session-clear.json');
  m.add('agent-y', 'user', 'temporary');
  m.clearAll();
  const m2 = new MemoryManager(5);
  m2.attach('.liber/session-clear.json');
  assert.equal(m2.get('agent-y').length, 0);
});

test('a corrupt session file does not crash startup', () => {
  const file = path.join(tmp, '.liber', 'corrupt.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const m = new MemoryManager(5);
  m.attach(file);
  assert.deepEqual(m.get('anything'), []);
});
