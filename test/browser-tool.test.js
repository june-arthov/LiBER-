// The browser tool opens whatever the model asks for, so the scheme guard is the
// only thing between "read a page" and "read this machine's files".
const test = require('node:test');
const assert = require('node:assert');
const browser = require('../src/daemon/core/tools/browser-tool');

test('only http(s) URLs are accepted', () => {
  for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'chrome://settings', 'ftp://example.com/x', 'data:text/html,<h1>x</h1>']) {
    const r = browser.checkUrl(bad);
    assert.equal(r.ok, false, `${bad} must be refused`);
    assert.match(r.error, /Refusing|Not a URL/);
  }
  for (const good of ['https://example.com', 'http://127.0.0.1:4567/healthz', 'https://example.com/a?b=1']) {
    assert.equal(browser.checkUrl(good).ok, true, `${good} must be allowed`);
  }
});

test('a URL is normalised so the same page is not opened twice', () => {
  assert.equal(browser.checkUrl('https://example.com').url, 'https://example.com/');
});

test('selectors and visible text are told apart', () => {
  assert.equal(browser.selectorFor('#login').kind, 'css');
  assert.equal(browser.selectorFor('.btn-primary').kind, 'css');
  assert.equal(browser.selectorFor('input[name=q]').kind, 'css');
  assert.equal(browser.selectorFor('button').kind, 'css');
  assert.equal(browser.selectorFor('Sign in').kind, 'text');
  assert.equal(browser.selectorFor(''), null);
});

test('an unknown action answers with the list of real ones instead of throwing', async () => {
  const r = await browser.runBrowser({ action: 'teleport' });
  assert.match(r.error, /Unknown browser action/);
  assert.match(r.error, /open, click, type/);
});
