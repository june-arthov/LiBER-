// The shipped liber.yaml leaves provider and endpoint null: only the key is the
// user's job. Something has to turn that key back into a base URL, or the turn
// dies on `null/chat/completions` (or as a 401 when the placeholder from
// .env.example is what got loaded).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// isolate the provider store: status() reads it relative to the cwd
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-engine-'));
process.chdir(dir);
process.env.OLLAMA_CLOUD_API_KEY = 'test_key_0123456789';

const providers = require('../src/daemon/core/providers');

test('null provider/endpoint is resolved from the configured key', () => {
  const engine = { provider: null, endpoint: null, model: 'deepseek-v4.1-flash' };
  const cfg = providers.engineDefaults(engine);

  assert.strictEqual(cfg.provider, 'openai', 'ollama-cloud speaks the OpenAI wire format');
  assert.strictEqual(cfg.endpoint, 'https://ollama.com/v1');
  assert.strictEqual(cfg.apiKey, 'test_key_0123456789', 'the key comes from the environment');
  assert.strictEqual(engine.provider, null, 'the caller config is not mutated');
});

test('an explicit provider and endpoint are left alone', () => {
  const engine = { provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1' };
  const cfg = providers.engineDefaults(engine);
  assert.strictEqual(cfg.provider, 'anthropic');
  assert.strictEqual(cfg.endpoint, 'https://api.anthropic.com/v1');
});

test('no configured provider leaves the config untouched instead of inventing one', () => {
  const saved = process.env.OLLAMA_CLOUD_API_KEY;
  const savedHost = process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_CLOUD_API_KEY;
  delete process.env.OLLAMA_HOST;
  try {
    const cfg = providers.engineDefaults({ provider: null, endpoint: null });
    assert.ok(!cfg.provider, 'nothing is configured, so nothing is guessed');
    assert.ok(!cfg.endpoint);
  } finally {
    process.env.OLLAMA_CLOUD_API_KEY = saved;
    if (savedHost !== undefined) process.env.OLLAMA_HOST = savedHost;
  }
});

test('a local OLLAMA_HOST does not outrank a configured cloud key', () => {
  process.env.OLLAMA_HOST = 'http://localhost:11434';
  try {
    const cfg = providers.engineDefaults({ provider: null, endpoint: null });
    assert.strictEqual(cfg.endpoint, 'https://ollama.com/v1', 'the API key decides, not the local server');
    assert.strictEqual(cfg.provider, 'openai');
  } finally {
    delete process.env.OLLAMA_HOST;
  }
});

test('the URL the adapter builds is never a null path', () => {
  const cfg = providers.engineDefaults({ provider: null, endpoint: null });
  const url = `${cfg.endpoint}/chat/completions`;
  assert.match(url, /^https?:\/\/[^/]+\/.*chat\/completions$/);
  assert.ok(!url.includes('null'), url);
});
