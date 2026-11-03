// test/daemon.test.js — the daemon must not leak credentials or raw config.
const test = require('node:test');
const assert = require('node:assert/strict');
const daemon = require('../src/daemon/liberd');

test('sanitizeAgent never exposes the api key or raw config', () => {
  const view = daemon.sanitizeAgent('dev-bot', {
    config: {
      name: 'dev-bot',
      version: '2.0.0',
      system_prompt: 'secret instructions',
      engine: { provider: 'openai', model: 'm', apiKey: 'sk-SECRET-DO-NOT-LEAK' }
    },
    status: 'RUNNING',
    startTime: 123,
    metrics: { requests: 1 }
  });
  const json = JSON.stringify(view);
  assert.ok(!json.includes('sk-SECRET-DO-NOT-LEAK'));
  assert.ok(!json.includes('secret instructions'));
  assert.equal(view.model, 'm');
  assert.equal(view.status, 'RUNNING');
});
