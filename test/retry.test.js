// test/retry.test.js — transient provider failures are retried, client errors are not.
const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/daemon/llm/manager');

function installFake(factory) {
  llm.adapters.fake = class {
    constructor(config) {
      this.config = config;
      this.calls = 0;
      this.lastUsage = null;
    }
    async generate() {
      this.calls++;
      return factory(this.calls);
    }
  };
}

test('retries a 500 and returns the successful attempt', async () => {
  installFake(call => {
    if (call < 3) throw new Error('HTTP 500: upstream boom');
    return 'recovered';
  });
  llm.initialize({ provider: 'fake', model: 'f', retry_attempts: 3, retry_base_ms: 100 });
  const out = await llm.generate([]);
  assert.equal(out, 'recovered');
  assert.equal(llm.activeAdapter.calls, 3);
});

test('does not retry an auth error', async () => {
  installFake(() => {
    throw new Error('HTTP 401: bad key');
  });
  llm.initialize({ provider: 'fake', model: 'f', retry_attempts: 3, retry_base_ms: 100 });
  await assert.rejects(() => llm.generate([]), /401/);
  assert.equal(llm.activeAdapter.calls, 1);
});

test('gives up after the configured attempts', async () => {
  installFake(() => {
    throw new Error('HTTP 429: rate limited');
  });
  llm.initialize({ provider: 'fake', model: 'f', retry_attempts: 2, retry_base_ms: 100 });
  await assert.rejects(() => llm.generate([]), /429/);
  assert.equal(llm.activeAdapter.calls, 2);
});

test('surfaces provider usage when the adapter reports it', async () => {
  llm.adapters.usagefake = class {
    constructor() {
      this.lastUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    }
    async generate() {
      return 'ok';
    }
  };
  llm.initialize({ provider: 'usagefake', model: 'f' });
  await llm.generate([]);
  assert.deepEqual(llm.getLastUsage(), { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});
