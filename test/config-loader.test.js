// test/config-loader.test.js — provider-aware key resolution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-config-'));
process.chdir(tmp);

const ConfigLoader = require('../src/utils/config-loader');

function writeConfig(provider) {
  fs.writeFileSync(path.join(tmp, 'liber.yaml'), `agent:\n  name: test\n  engine:\n    provider: ${provider}\n    model: ${provider}-model\n    endpoint: https://example.invalid\n    apiKey: "\${MISSING}"\n`);
}

test('anthropic keys come from ANTHROPIC_API_KEY in .env', () => {
  delete process.env.ANTHROPIC_API_KEY;
  writeConfig('anthropic');
  fs.writeFileSync(path.join(tmp, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-123\n');
  const config = ConfigLoader.load('liber.yaml');
  assert.equal(config.agent.engine.apiKey, 'sk-ant-test-123');
});

test('gemini keys prefer the process environment, then GOOGLE_API_KEY', () => {
  writeConfig('gemini');
  fs.writeFileSync(path.join(tmp, '.env'), 'GOOGLE_API_KEY=from-file\n');

  delete process.env.GEMINI_API_KEY;
  const fromFile = ConfigLoader.load('liber.yaml');
  assert.equal(fromFile.agent.engine.apiKey, 'from-file');

  process.env.GEMINI_API_KEY = 'from-env';
  const fromEnv = ConfigLoader.load('liber.yaml');
  assert.equal(fromEnv.agent.engine.apiKey, 'from-env');
  delete process.env.GEMINI_API_KEY;
});

test('openai provider still falls back to OLLAMA_CLOUD_API_KEY', () => {
  writeConfig('openai');
  fs.writeFileSync(path.join(tmp, '.env'), 'OLLAMA_CLOUD_API_KEY=ollama-key-123\n');
  const config = ConfigLoader.load('liber.yaml');
  assert.equal(config.agent.engine.apiKey, 'ollama-key-123');
});

test('endpoint host decides the key name for OpenAI-compatible vendors', () => {
  writeConfig('openai');
  fs.writeFileSync(path.join(tmp, '.env'), 'GROQ_API_KEY=gsk-test-1\nOLLAMA_CLOUD_API_KEY=ollama-key-123\n');

  assert.equal(ConfigLoader.resolveApiKey('openai', 'https://api.groq.com/openai/v1'), 'gsk-test-1');
  assert.equal(ConfigLoader.resolveApiKey('openai', 'https://api.deepseek.com/v1'), null);
  assert.equal(ConfigLoader.resolveApiKey('openai', 'https://ollama.com/v1'), 'ollama-key-123');
  assert.equal(ConfigLoader.resolveApiKey('ollama', 'http://localhost:11434'), null, 'local Ollama needs no key');
});
