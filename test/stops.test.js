// The kill switch: a request must stop the turn and end the command it is running.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const stops = require('../src/daemon/core/stops');

function fakeChild(pid = 1234) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', null, 'SIGKILL'); };
  return child;
}

test('a stop request is visible to the engine until the next turn clears it', () => {
  assert.strictEqual(stops.isRequested('a1'), false);
  const out = stops.request('a1');
  assert.strictEqual(out.agentId, 'a1');
  assert.strictEqual(stops.isRequested('a1'), true);
  stops.clear('a1');
  assert.strictEqual(stops.isRequested('a1'), false, 'a new turn starts clean');
});

test('stopping an agent kills the command already running for it', () => {
  const child = fakeChild();
  stops.track('a2', child);
  assert.strictEqual(stops.snapshot().find(s => s.agentId === 'a2').children, 1);

  const out = stops.request('a2');
  assert.strictEqual(out.killed >= 1, true, 'the child was signalled');
  assert.strictEqual(child.killed, true);
  assert.strictEqual(stops.snapshot().find(s => s.agentId === 'a2').children, 0, 'and untracked');
});

test('an exited child is not counted as running', () => {
  const child = fakeChild();
  stops.track('a3', child);
  child.emit('exit', 0, null);
  assert.strictEqual(stops.snapshot().find(s => s.agentId === 'a3').children, 0);
});

test('agents do not share a stop flag', () => {
  stops.request('a4');
  assert.strictEqual(stops.isRequested('a5'), false);
  stops.clear('a4');
});
