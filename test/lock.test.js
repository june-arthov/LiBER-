// test/lock.test.js — per-agent serialization.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentQueue } = require('../src/daemon/core/lock');

test('turns on the same agent run strictly in order', async () => {
  const queue = new AgentQueue();
  const order = [];

  const t1 = queue.run('dev-bot', async () => {
    await new Promise(r => setTimeout(r, 40));
    order.push('t1');
    return 'a';
  });
  const t2 = queue.run('dev-bot', async () => {
    order.push('t2');
    return 'b';
  });

  const results = await Promise.all([t1, t2]);
  assert.deepEqual(order, ['t1', 't2']);
  assert.deepEqual(results, ['a', 'b']);
});

test('different agents do not block each other', async () => {
  const queue = new AgentQueue();
  const order = [];

  const a = queue.run('agent-a', async () => {
    await new Promise(r => setTimeout(r, 40));
    order.push('a');
  });
  const b = queue.run('agent-b', async () => {
    order.push('b');
  });

  await Promise.all([a, b]);
  assert.deepEqual(order, ['b', 'a']);
});

test('a rejected turn does not poison the chain', async () => {
  const queue = new AgentQueue();
  await assert.rejects(queue.run('x', async () => {
    throw new Error('boom');
  }));
  const ok = await queue.run('x', async () => 'recovered');
  assert.equal(ok, 'recovered');
  assert.equal(queue.pending('x'), 0);
});
