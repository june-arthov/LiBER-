// test/providers.test.js — Anthropic and Gemini adapter translation layers.
const test = require('node:test');
const assert = require('node:assert/strict');
const AnthropicAdapter = require('../src/daemon/llm/adapters/anthropic-adapter');
const GeminiAdapter = require('../src/daemon/llm/adapters/gemini-adapter');

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

test('anthropic generate merges consecutive user turns and extracts system', async () => {
  const original = global.fetch;
  let sentBody = null;
  global.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return jsonResponse({
      content: [{ type: 'text', text: 'the answer' }],
      usage: { input_tokens: 10, output_tokens: 5 }
    });
  };

  const adapter = new AnthropicAdapter({ endpoint: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-test' });
  let out;
  try {
    out = await adapter.generate([
      { role: 'system', content: 'be precise' },
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'OBSERVATION [E1] read_file OK: {}' }
    ]);
  } finally {
    global.fetch = original;
  }

  assert.equal(out, 'the answer');
  assert.equal(sentBody.system, 'be precise');
  assert.equal(sentBody.messages.length, 1, 'consecutive user turns must merge (Anthropic forbids repeats)');
  assert.equal(sentBody.messages[0].role, 'user');
  assert.match(sentBody.messages[0].content, /hello/);
  assert.match(sentBody.messages[0].content, /OBSERVATION/);
  assert.deepEqual(adapter.lastUsage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test('anthropic chat translates tool_use blocks back to the engine shape', async () => {
  const original = global.fetch;
  let sentTools = null;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sentTools = body.tools;
    return jsonResponse({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'package.json' } }]
    });
  };

  const adapter = new AnthropicAdapter({ endpoint: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-test' });
  let res;
  try {
    res = await adapter.chat([{ role: 'user', content: 'read it' }], {
      tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]
    });
  } finally {
    global.fetch = original;
  }

  assert.equal(sentTools[0].name, 'read_file');
  assert.equal(sentTools[0].input_schema.type, 'object');
  assert.equal(res.tool_calls[0].id, 'toolu_1');
  assert.equal(res.tool_calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(res.tool_calls[0].function.arguments), { path: 'package.json' });
});

test('anthropic stream reassembles split SSE events and captures usage', async () => {
  const original = global.fetch;
  const encoder = new TextEncoder();
  global.fetch = async () =>
    new Response(new ReadableStream({
      start(controller) {
        for (const chunk of [
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hel',
          'lo"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"input_tokens":7,"output_tokens":2}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ]) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    }), { status: 200 });

  const adapter = new AnthropicAdapter({ endpoint: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-test' });
  let out = '';
  try {
    await adapter.stream([{ role: 'user', content: 'hi' }], d => (out += d));
  } finally {
    global.fetch = original;
  }

  assert.equal(out, 'hello');
  assert.deepEqual(adapter.lastUsage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
});

test('gemini generate maps roles, system and parses parts', async () => {
  const original = global.fetch;
  let sentBody = null;
  global.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: 'hi' }, { text: ' there' }] } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 }
    });
  };

  const adapter = new GeminiAdapter({ endpoint: 'https://generativelanguage.googleapis.com', apiKey: 'k', model: 'gemini-test' });
  let out;
  try {
    out = await adapter.generate([
      { role: 'system', content: 'be precise' },
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'more context' }
    ]);
  } finally {
    global.fetch = original;
  }

  assert.equal(out, 'hi there');
  assert.equal(sentBody.systemInstruction.parts[0].text, 'be precise');
  assert.equal(sentBody.contents.length, 1, 'consecutive user turns must merge');
  assert.equal(sentBody.contents[0].role, 'user');
  assert.equal(sentBody.contents[0].parts.length, 2);
  assert.deepEqual(adapter.lastUsage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
});

test('gemini stream parses SSE candidates', async () => {
  const original = global.fetch;
  const encoder = new TextEncoder();
  global.fetch = async () =>
    new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"part"}]}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":" two"}]}}]}\n\n'));
        controller.close();
      }
    }), { status: 200 });

  const adapter = new GeminiAdapter({ endpoint: 'https://generativelanguage.googleapis.com', apiKey: 'k', model: 'gemini-test' });
  let out = '';
  try {
    await adapter.stream([{ role: 'user', content: 'hi' }], d => (out += d));
  } finally {
    global.fetch = original;
  }

  assert.equal(out, 'part two');
});
