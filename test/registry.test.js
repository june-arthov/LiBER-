// test/registry.test.js — schema-lite argument validation before any execution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-registry-'));
fs.writeFileSync(path.join(tmp, 'sample.txt'), 'alpha\nbeta\n');
process.chdir(tmp);

const registry = require('../src/daemon/core/registry');

test('missing required argument is rejected before execution', async () => {
  const res = await registry.execute('read_file', {});
  assert.equal(res.validation_failed, true);
  assert.match(res.error, /Missing required argument 'path'/);
});

test('wrong argument type is rejected', async () => {
  const res = await registry.execute('read_file', { path: 42 });
  assert.equal(res.validation_failed, true);
  assert.match(res.error, /must be string/);
});

test('near-miss key names are corrected with a suggestion', async () => {
  const res = await registry.execute('read_file', { pathx: 'sample.txt' });
  assert.equal(res.validation_failed, true);
  assert.match(res.error, /Did you mean 'path'/);
});

test('enum violations are rejected', async () => {
  const res = await registry.execute('todo_list', { action: 'explode' });
  assert.equal(res.validation_failed, true);
  assert.match(res.error, /must be one of/);
});

test('unknown tools list the available set', async () => {
  const res = await registry.execute('shell_execute_v2', { command: 'echo hi' });
  assert.equal(res.validation_failed, true);
  assert.match(res.error, /not registered/);
  assert.match(res.error, /read_file/);
  assert.match(res.error, /fetch_url/);
});

test('valid arguments execute normally', async () => {
  const res = await registry.execute('read_file', { path: 'sample.txt' });
  assert.equal(res.error, undefined);
  assert.equal(res.total_lines, 3);
  assert.match(res.content, /alpha/);
});

test('alias shell_execute still resolves to terminal', () => {
  assert.equal(registry.get('shell_execute').name, 'terminal');
});

test('fetch_url is registered and validates its url', async () => {
  const tool = registry.get('fetch_url');
  assert.ok(tool);
  const res = await registry.execute('fetch_url', { url: 'ftp://example.com/x' });
  assert.match(res.error, /Unsupported protocol/);
});

test('skill definitions are registered and only writes require approval', () => {
  const tool = registry.get('skill');
  assert.ok(tool);
  assert.equal(registry.isSensitive('skill', { action: 'view' }), false);
  assert.equal(registry.isSensitive('skill', { action: 'list' }), false);
  assert.equal(registry.isSensitive('skill', { action: 'create' }), true);
  assert.equal(registry.isSensitive('skill', { action: 'update' }), true);
});
