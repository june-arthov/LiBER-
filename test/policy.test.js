// test/policy.test.js — file mutations are confined to the workspace by default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-policy-'));
process.chdir(tmp);

const policy = require('../src/daemon/core/policy');
const registry = require('../src/daemon/core/registry');

test('writes inside the workspace are allowed', () => {
  policy.configure({});
  assert.equal(policy.checkWrite('out.txt').allowed, true);
  assert.equal(policy.checkWrite('src/deep/out.txt').allowed, true);
});

test('writes outside the workspace are denied by default', () => {
  policy.configure({});
  const check = policy.checkWrite('../escape.txt');
  assert.equal(check.allowed, false);
  assert.match(check.reason, /outside the workspace/);
});

test('absolute paths outside the workspace are denied', () => {
  policy.configure({});
  const outside = path.join(os.tmpdir(), 'liber-outside.txt');
  assert.equal(policy.checkWrite(outside).allowed, false);
});

test('the policy can be widened deliberately', () => {
  policy.configure({ allow_outside_workspace: true });
  assert.equal(policy.checkWrite('../escape.txt').allowed, true);
  policy.configure({});
});

test('custom write roots are respected', () => {
  policy.configure({ write_roots: ['src'] });
  assert.equal(policy.checkWrite('src/a.js').allowed, true);
  assert.equal(policy.checkWrite('other/a.js').allowed, false);
  policy.configure({});
});

test('the write_file tool refuses an outside path and creates nothing', async () => {
  policy.configure({});
  const target = path.join(os.tmpdir(), `liber-should-not-exist-${Date.now()}.txt`);
  const res = await registry.execute('write_file', { path: target, content: 'x' });
  assert.equal(res.policy_denied, true);
  assert.equal(fs.existsSync(target), false);
});

test('the patch tool refuses an outside path', async () => {
  policy.configure({});
  const res = await registry.execute('patch', {
    path: '../outside.js',
    old_string: 'a',
    new_string: 'b'
  });
  assert.equal(res.policy_denied, true);
});
