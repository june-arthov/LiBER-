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

test('a truncated store recovers the previous session from the backup', () => {
  const file = path.join(tmp, '.liber', 'crashy.json');
  const m1 = new MemoryManager(5);
  m1.attach(file);
  m1.add('agent-z', 'user', 'first');
  m1.add('agent-z', 'assistant', 'second');   // this write keeps the previous file as .bak
  fs.writeFileSync(file, '{"version":1,"sess'); // simulate a crash mid-write

  const m2 = new MemoryManager(5);
  m2.attach(file);
  const restored = m2.get('agent-z');
  assert.equal(restored.length, 1, 'the backup survives, so nothing is silently lost');
  assert.equal(restored[0].content, 'first');
});

test('a completed save is atomic: no .tmp left behind, .bak is not in the way', () => {
  const file = path.join(tmp, '.liber', 'atomic.json');
  const m = new MemoryManager(5);
  m.attach(file);
  m.add('agent-w', 'user', 'hello');
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(`${file}.tmp`));
  const m2 = new MemoryManager(5);
  m2.attach(file);
  assert.equal(m2.get('agent-w')[0].content, 'hello');
});
