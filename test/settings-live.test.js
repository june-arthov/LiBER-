// test/settings-live.test.js — runtime behaviour behind the settings drawer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-settings-'));
process.chdir(tmp);

const memory = require('../src/daemon/core/memory');
const { validateConfigUpdate } = require('../src/daemon/core/config-apply');
const policy = require('../src/daemon/core/policy');
const { evaluatePolicy } = require('../src/daemon/core/tools/terminal-tool');

test('memory.resize trims every agent to the new window immediately', () => {
  memory.resize(3);
  for (let i = 0; i < 6; i++) memory.add('a1', 'user', `m${i}`);
  memory.add('a1', 'assistant', 'answer');
  memory.add('b2', 'user', 'hello');
  assert.equal(memory.get('a1').length, 3, 'agent a1 trimmed to 3');
  assert.equal(memory.get('a1').map(m => m.role).join(','), 'user,user,assistant');
  assert.equal(memory.get('b2').length, 1, 'agent b2 untouched');
});

test('validateConfigUpdate guards types and ranges', () => {
  assert.equal(validateConfigUpdate({ 'grounding.max_repairs': 2 }).error, undefined);
  assert.match(validateConfigUpdate({ 'engine.context_window_override': 'lots' }).error, /integer/);
  assert.match(validateConfigUpdate({ 'engine.context_window_override': 2000000 }).error, /within/);
  assert.equal(validateConfigUpdate({ 'engine.context_window_override': 70000 }).error, undefined);
  assert.match(validateConfigUpdate({ 'policy.terminal.mode': 'wideopen' }).error, /one of/);
  assert.equal(validateConfigUpdate({ 'policy.write_roots': ['.', 'sandbox'] }).error, undefined);
  assert.match(validateConfigUpdate({ 'grounding.enabled': 1 }).error, /boolean/);
});

test('terminal policy reconfigures live via config-apply shape', () => {
  policy.configure({ terminal: { mode: 'read_only', allowlist: ['npm test'], denylist: [] } });
  assert.equal(evaluatePolicy('npm install x').denied, true);
  assert.equal(evaluatePolicy('npm test').denied, false);

  policy.configure({ terminal: { mode: 'allowlist', allowlist: ['node --test'], denylist: [] } });
  assert.equal(evaluatePolicy('node --test').denied, false);
  assert.equal(evaluatePolicy('npm test').denied, true);

  policy.configure({ terminal: { mode: 'prompt', allowlist: [], denylist: [] } });
  const prompted = evaluatePolicy('rm -rf node_modules');
  assert.equal(prompted.denied, true, 'prompt mode fails closed: this layer has no approval channel');
  assert.equal(prompted.needs_approval, true, 'the escalation signal is part of the contract');

  policy.configure({ terminal: { mode: 'prompt', allowlist: ['rm -rf node_modules'], denylist: [] } });
  assert.equal(evaluatePolicy('rm -rf node_modules').denied, false, 'an allowlisted prefix still runs');
});
