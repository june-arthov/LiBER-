// test/model-switch.test.js — live model/provider switching validation and persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSwitch, patchEngineYaml, sanitizeEngine } = require('../src/daemon/core/model-switch');

test('valid switch payload passes', () => {
  const r = validateSwitch({ model: 'gpt-4.1-mini', provider: 'openai', endpoint: 'https://api.openai.com/v1' });
  assert.equal(r.error, undefined);
  assert.equal(r.model, 'gpt-4.1-mini');
  assert.equal(r.provider, 'openai');
});

test('missing model is rejected', () => {
  assert.match(validateSwitch({ provider: 'openai' }).error, /Missing 'model'/);
});

test('unknown provider is rejected', () => {
  assert.match(validateSwitch({ model: 'x', provider: 'mystery-ai' }).error, /Unknown provider/);
});

test('bad endpoint is rejected', () => {
  assert.match(validateSwitch({ model: 'x', endpoint: 'not-a-url' }).error, /Invalid endpoint/);
});

test('malformed model names are rejected', () => {
  assert.match(validateSwitch({ model: 'bad model name!' }).error, /Invalid model name/);
});

test('patchEngineYaml rewrites only the engine keys and keeps comments', () => {
  const yaml = [
    'agent:',
    '  engine:',
    '    # Provider switching docs — keep this comment',
    '    provider: "openai" # Uses openai-adapter',
    '    model: "glm-5.3-flash" # Active cloud model',
    '    endpoint: "https://ollama.com/v1" # Ollama Cloud endpoint',
    '  system_prompt: "unchanged"',
    'memory:',
    '  window_size: 20'
  ].join('\n');

  const out = patchEngineYaml(yaml, {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    endpoint: 'https://api.anthropic.com'
  });

  assert.match(out, /provider: "anthropic"/);
  assert.match(out, /model: "claude-sonnet-4-5"/);
  assert.match(out, /endpoint: "https:\/\/api\.anthropic\.com"/);
  assert.match(out, /Provider switching docs — keep this comment/, 'comments survive');
  assert.match(out, /window_size: 20/, 'unrelated keys survive');
  assert.match(out, /system_prompt: "unchanged"/);
  assert.ok(!out.includes('glm-5.3-flash'));
  assert.ok(!out.includes('ollama.com/v1'));
});

test('sanitizeEngine never exposes credentials', () => {
  const view = sanitizeEngine({ provider: 'openai', model: 'm', endpoint: 'https://x', apiKey: 'sk-SECRET' });
  assert.deepEqual(view, { provider: 'openai', model: 'm', endpoint: 'https://x' });
  assert.ok(!JSON.stringify(view).includes('sk-SECRET'));
});
