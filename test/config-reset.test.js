// test/config-reset.test.js — the defaults payload must itself be valid config.
const test = require('node:test');
const assert = require('node:assert/strict');
const configApply = require('../src/daemon/core/config-apply');

test('defaults() passes the same whitelist the daemon enforces', () => {
  const defs = configApply.defaults();
  const { changes, error } = configApply.validateConfigUpdate(defs);
  assert.equal(error, undefined);
  assert.equal(Object.keys(changes).length, Object.keys(defs).length, 'every default is accepted');
});

test('defaults keep the model untouched and cover nested keys', () => {
  const defs = configApply.defaults();
  assert.equal(defs['engine.model'], undefined, 'reset must not change the active model');
  assert.equal(defs['engine.provider'], undefined);
  assert.equal(defs['limits.circuit_breaker.max_loops'], 12);
  assert.equal(defs['grounding.enabled'], true);
  assert.ok(Array.isArray(defs['policy.terminal.allowlist']));
});

test('defaults() returns a copy, not the shared object', () => {
  const a = configApply.defaults();
  a['memory.window_size'] = 999;
  assert.notEqual(configApply.defaults()['memory.window_size'], 999);
});
