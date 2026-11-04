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
  policy.configure({ terminal: { mode: 'open', allowlist: [], denylist: ['shutdown'] } });
  assert.equal(evaluatePolicy('shutdown /s').denied, true);
  assert.equal(evaluatePolicy('dir').denied, false);
});

test('prompt mode fails closed instead of running everything', () => {
  const { evaluatePolicy } = require('../src/daemon/core/tools/terminal-tool');
  policy.configure({ terminal: { mode: 'prompt', allowlist: ['git status'], denylist: [] } });

  const blocked = evaluatePolicy('dir');
  assert.equal(blocked.denied, true, "'prompt' must not silently allow: there is no approval channel here");
  assert.equal(blocked.needs_approval, true);
  assert.match(blocked.reason, /prompt/);

  assert.equal(evaluatePolicy('git status -s').denied, false, 'an allowlisted prefix still runs');
});

test('a chained operator is not covered by a prefix allowlist entry', () => {
  const { evaluatePolicy } = require('../src/daemon/core/tools/terminal-tool');
  policy.configure({ terminal: { mode: 'allowlist', allowlist: ['git status', 'node'], denylist: [] } });

  assert.equal(evaluatePolicy('git status -s').denied, false);
  assert.equal(evaluatePolicy('git status; rm -rf /').denied, true, 'semicolon escapes the prefix');
  assert.equal(evaluatePolicy('git status && curl http://x').denied, true, 'double ampersand escapes the prefix');
  assert.equal(evaluatePolicy('node -v | powershell -c whoami').denied, true, 'pipe escapes the prefix');
});

test('a denylisted word hiding after a chain operator is still caught', () => {
  const { evaluatePolicy } = require('../src/daemon/core/tools/terminal-tool');
  policy.configure({ terminal: { mode: 'open', allowlist: [], denylist: ['shutdown'] } });
  assert.equal(evaluatePolicy('echo hi; shutdown /s').denied, true);
});

test('human approval bypasses the mode gate but never the denylist', () => {
  const { evaluatePolicy } = require('../src/daemon/core/tools/terminal-tool');
  policy.configure({ terminal: { mode: 'prompt', allowlist: [], denylist: ['shutdown'] } });

  assert.equal(evaluatePolicy('dir').denied, true);
  assert.equal(evaluatePolicy('dir', { approved: true }).denied, false, 'an approved command runs');
  assert.equal(evaluatePolicy('shutdown /s', { approved: true }).denied, true, 'the denylist cannot be approved away');
});

test('runTerminal keeps the approval signal instead of dropping it', async () => {
  const { runTerminal } = require('../src/daemon/core/tools/terminal-tool');
  policy.configure({ terminal: { mode: 'prompt', allowlist: [], denylist: [] } });

  const res = await runTerminal({ command: 'dir' });
  assert.equal(res.policy_denied, true);
  assert.equal(res.needs_approval, true, 'the consumer must be able to see a human could approve');
  assert.ok(!('exit_code' in res), 'nothing was executed');
});

test('search_files refuses a file path instead of reporting zero matches', async () => {
  const fileTools = require('../src/daemon/core/tools/file-tools');
  fs.writeFileSync('search-me.js', 'const a = 1;\n');
  const res = await fileTools.searchFiles({ pattern: 'const', path: 'search-me.js' });
  assert.ok(res.error, 'an error, not an empty match list');
  assert.match(res.error, /is a file, not a directory/);
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
