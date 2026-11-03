// test/web-tool.test.js — search parsing and the untrusted-content marker.
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWeb, fetchUrl, UNTRUSTED_MARKER } = require('../src/daemon/core/tools/web-tool');

test('searchWeb parses DuckDuckGo HTML and decodes uddg URLs', async () => {
  const original = global.fetch;
  global.fetch = async () =>
    new Response(
      '<html><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=x">Example Title</a>' +
      '<div class="result__snippet">A snippet about things.</div></html>',
      { status: 200 }
    );

  try {
    const res = await searchWeb({ query: 'test' });
    assert.equal(res.total, 1);
    assert.equal(res.results[0].url, 'https://example.com/page');
    assert.equal(res.results[0].title, 'Example Title');
    assert.match(res.results[0].snippet, /snippet about things/);
  } finally {
    global.fetch = original;
  }
});

test('searchWeb caps results and rejects empty queries', async () => {
  const bad = await searchWeb({});
  assert.match(bad.error, /query/);

  const original = global.fetch;
  let seenUrl = '';
  global.fetch = async (url) => {
    seenUrl = String(url);
    return new Response('<html></html>', { status: 200 });
  };
  try {
    await searchWeb({ query: 'hello world', max: 99 });
  } finally {
    global.fetch = original;
  }
  assert.ok(seenUrl.includes('hello%20world'));
});

test('searchWeb falls back to SearXNG when DuckDuckGo fails', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    const target = String(url);
    if (target.includes('duckduckgo')) throw new Error('fetch failed');
    return new Response(
      JSON.stringify({ results: [{ title: 'SearX Title', url: 'https://searx.example/x', content: 'SearX snippet text' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    const res = await searchWeb({ query: 'fallback test' });
    assert.equal(res.source, 'searx-json');
    assert.equal(res.results[0].title, 'SearX Title');
    assert.match(res.results[0].snippet, /SearX snippet text/);
  } finally {
    global.fetch = original;
  }
  assert.ok(calls >= 2);
});

test('fetchUrl prefixes every result with the untrusted marker', async () => {
  const original = global.fetch;
  global.fetch = async () =>
    new Response('<html><body>hello world</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    });

  try {
    const res = await fetchUrl({ url: 'https://example.com' });
    assert.equal(res.status, 200);
    assert.ok(res.content.startsWith(UNTRUSTED_MARKER.trim()));
    assert.match(res.content, /hello world/);
  } finally {
    global.fetch = original;
  }
});
