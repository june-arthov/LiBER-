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

test('read_only terminal policy blocks mutations but allows the allowlist', () => {
  const { evaluatePolicy } = require('../src/daemon/core/tools/terminal-tool');
  policy.configure({ terminal: { mode: 'read_only', allowlist: ['npm test'], denylist: [] } });

  assert.equal(evaluatePolicy('npm install express').denied, true);
  assert.equal(evaluatePolicy('npm test').denied, false);
  assert.equal(evaluatePolicy('git status').denied, false);
  assert.equal(evaluatePolicy('git commit -m x').denied, true);
  assert.equal(evaluatePolicy('echo hi > out.txt').denied, true);
  assert.equal(evaluatePolicy('node -v').denied, false);
  assert.equal(evaluatePolicy('rm -rf node_modules').denied, true);
});

test('allowlist terminal policy only runs listed prefixes', () => {
  const { evaluatePolicy } = require('../src/daemon/core/tools/terminal-tool');
  policy.configure({ terminal: { mode: 'allowlist', allowlist: ['node', 'git status'], denylist: [] } });

  assert.equal(evaluatePolicy('node -v').denied, false);
  assert.equal(evaluatePolicy('git status').denied, false);
  assert.equal(evaluatePolicy('git log').denied, true);
});

test('terminal denylist wins in every mode', () => {
  const { evaluatePolicy } = require('../src/daemon/core/tools/terminal-tool');
  policy.configure({ terminal: { mode: 'prompt', allowlist: [], denylist: ['shutdown'] } });
  assert.equal(evaluatePolicy('shutdown /s').denied, true);
  assert.equal(evaluatePolicy('dir').denied, false);
});

test('read-only terminal policy allows read-only PowerShell cmdlets', () => {
  const { evaluatePolicy } = require('../src/daemon/core/tools/terminal-tool');
  policy.configure({ terminal: { mode: 'read_only', allowlist: ['npm test'], denylist: [] } });

  // Format-Table is a read-only formatter — the 'format' pattern must not block it.
  const listing = 'Get-ChildItem -Path G:\\repo -Force | Select-Object Mode,Length,Name | Format-Table -AutoSize';
  assert.equal(evaluatePolicy(listing).denied, false, 'read-only listing must pass');

  // 'format C:' still requires an argument and remains blocked.
  assert.equal(evaluatePolicy('format C:').denied, true);
});
