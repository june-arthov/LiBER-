// test/config-apply.test.js — whitelisted live config updates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfigUpdate, patchYamlKey, patchYamlKeys, sanitizeConfig } = require('../src/daemon/core/config-apply');

test('valid updates pass and unknown keys are rejected', () => {
  const r = validateConfigUpdate({
    'grounding.enabled': true,
    'grounding.max_repairs': 2,
    'memory.window_size': 30,
    'policy.terminal.mode': 'allowlist',
    'policy.terminal.allowlist': ['npm test', 'git status'],
    'limits.max_tokens_per_day': 500000,
    'telemetry.trace': false,
    'engine.model': 'glm-5.3-flash'
  });
  assert.equal(r.error, undefined);
  assert.equal(r.changes['memory.window_size'], 30);
  assert.deepEqual(r.changes['policy.terminal.allowlist'], ['npm test', 'git status']);

  assert.match(validateConfigUpdate({ 'hacky.key': 1 }).error, /Unknown config key/);
  assert.match(validateConfigUpdate({ 'engine.model': 'bad name!' }).error, /invalid model/);
  assert.match(validateConfigUpdate({ 'grounding.max_repairs': 99 }).error, /within/);
  assert.match(validateConfigUpdate({ 'memory.window_size': 'abc' }).error, /integer/);
  assert.match(validateConfigUpdate({ 'policy.terminal.mode': 'yolo' }).error, /one of/);
});

test('patchYamlKey rewrites nested keys and keeps comments', () => {
  const yaml = [
    'agent:',
    '  engine:',
    '    model: "old" # Active cloud model',
    'grounding:',
    '  enabled: true',
    '  max_repairs: 2 # repairs',
    'limits:',
    '  max_tokens_per_day: 2000000',
    'memory:',
    '  window_size: 20'
  ].join('\n');

  let out = patchYamlKey(yaml, 'agent.engine.model', 'new-model');
  out = patchYamlKey(out, 'grounding.max_repairs', 3);
  out = patchYamlKey(out, 'memory.window_size', 40);
  out = patchYamlKey(out, 'limits.max_tokens_per_day', 1000000);

  assert.match(out, /model: "new-model" # Active cloud model/, 'comment preserved');
  assert.match(out, /max_repairs: 3 # repairs/);
  assert.match(out, /window_size: 40/);
  assert.match(out, /max_tokens_per_day: 1000000/);
  assert.ok(!out.includes('"old"'));
});

test('patchYamlKey leaves the text unchanged for unknown paths', () => {
  const yaml = 'memory:\n  window_size: 20\n';
  assert.equal(patchYamlKey(yaml, 'nope.nothing', 1), yaml);
});

test('patchYamlKeys handles list and boolean values', () => {
  const yaml = 'policy:\n  terminal:\n    mode: "read_only"\n    allowlist: ["npm test"]\n    denylist: []\n';
  const out = patchYamlKeys(yaml, {
    'policy.terminal.mode': 'allowlist',
    'policy.terminal.allowlist': ['npm test', 'git status'],
    'policy.terminal.denylist': ['shutdown']
  });
  assert.match(out, /mode: "allowlist"/);
  assert.match(out, /allowlist: \["npm test", "git status"\]/);
  assert.match(out, /denylist: \["shutdown"\]/);
});

test('sanitizeConfig never exposes credentials', () => {
  const view = sanitizeConfig(
    { name: 'bot', engine: { provider: 'openai', model: 'm', endpoint: 'https://x', apiKey: 'sk-SECRET' }, grounding: { enabled: true } },
    true,
    'C:\\x'
  );
  assert.ok(!JSON.stringify(view).includes('sk-SECRET'));
  assert.equal(view.engine.provider, 'openai');
  assert.equal(view.grounding.enabled, true);
  assert.equal(view.telemetry.trace, true);
});
