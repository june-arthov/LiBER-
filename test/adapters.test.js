// test/adapters.test.js — streaming parsers must survive network chunk boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const OpenAIAdapter = require('../src/daemon/llm/adapters/openai-adapter');
const OllamaAdapter = require('../src/daemon/llm/adapters/ollama-adapter');

function fetchWithChunks(chunks, headers = {}) {
  const encoder = new TextEncoder();
  return async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        }
      }),
      { status: 200, headers }
    );
}

test('openai stream reassembles an SSE line split across network chunks', async () => {
  const original = global.fetch;
  global.fetch = fetchWithChunks(
    [
      'data: {"choices":[{"delta":{"content":"hel',
      'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n'
    ],
    { 'content-type': 'text/event-stream' }
  );

  let out = '';
  const adapter = new OpenAIAdapter({ endpoint: 'http://x', apiKey: 'k', model: 'm' });
  try {
    await adapter.stream([], d => (out += d));
  } finally {
    global.fetch = original;
  }
  assert.equal(out, 'hello world');
});

test('openai stream captures provider usage when present', async () => {
  const original = global.fetch;
  global.fetch = fetchWithChunks([
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n'
  ]);

  const adapter = new OpenAIAdapter({ endpoint: 'http://x', apiKey: 'k', model: 'm' });
  try {
    await adapter.stream([], () => {});
  } finally {
    global.fetch = original;
  }
  assert.deepEqual(adapter.lastUsage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
});

test('ollama stream reassembles an NDJSON line split across chunks', async () => {
  const original = global.fetch;
  global.fetch = fetchWithChunks(
    ['{"message":{"content":"par', 'tial"},"done":false}\n{"message":{"content":" complete"},"done":true}\n'],
    { 'content-type': 'application/x-ndjson' }
  );

  let out = '';
  const adapter = new OllamaAdapter({ endpoint: 'http://x', model: 'm' });
  try {
    await adapter.stream([], d => (out += d));
  } finally {
    global.fetch = original;
  }
  assert.equal(out, 'partial complete');
});

test('openai stream surfaces HTTP errors instead of returning empty text', async () => {
  const original = global.fetch;
  global.fetch = async () => new Response('bad key', { status: 401, statusText: 'Unauthorized' });
  const adapter = new OpenAIAdapter({ endpoint: 'http://x', apiKey: 'k', model: 'm' });
  try {
    await assert.rejects(() => adapter.stream([], () => {}), /HTTP 401/);
  } finally {
    global.fetch = original;
  }
});

test('openai stream requests a usage chunk by default', async () => {
  const original = global.fetch;
  let sentBody = null;
  global.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      }),
      { status: 200 }
    );
  };

  try {
    await new OpenAIAdapter({ endpoint: 'http://x', apiKey: 'k', model: 'm' }).stream([], () => {});
  } finally {
    global.fetch = original;
  }

  assert.deepEqual(sentBody.stream_options, { include_usage: true });
  assert.equal(sentBody.stream, true);
});

test('openai stream can opt out of the usage chunk', async () => {
  const original = global.fetch;
  let sentBody = null;
  global.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      }),
      { status: 200 }
    );
  };

  try {
    await new OpenAIAdapter({ endpoint: 'http://x', apiKey: 'k', model: 'm', stream_usage: false }).stream([], () => {});
  } finally {
    global.fetch = original;
  }

  assert.equal(sentBody.stream_options, undefined);
});
