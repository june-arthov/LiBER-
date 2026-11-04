// The terminal policy from a real run: a read-only listing was refused three
// times in a row because (a) the allowlist only named build/git commands and
// (b) any pipeline was treated as a single opaque string. Both are policy bugs,
// not model mistakes: `Get-ChildItem -Force | Select-Object Name` reads.
const test = require('node:test');
const assert = require('node:assert');
const policy = require('../src/daemon/core/policy');
const terminal = require('../src/daemon/core/tools/terminal-tool');

function withTerminal(cfg) {
  policy.configure({ terminal: { allowlist: [], denylist: [], ...cfg } });
}

test('allowlist mode permits read-only inventory commands', () => {
  withTerminal({ mode: 'allowlist', allowlist: ['npm test'] });
  for (const cmd of ['ls', 'ls -la', 'dir', 'Get-ChildItem -Force', 'Get-ChildItem -Force -Name',
    'cat package.json', 'git log --oneline -5', 'node --version', 'pwd']) {
    const d = terminal.evaluatePolicy(cmd);
    assert.equal(d.denied, false, `'${cmd}' should be allowed (got: ${d.reason})`);
  }
});

test('a pipeline is judged stage by stage, not refused as one string', () => {
  withTerminal({ mode: 'allowlist', allowlist: [] });
  const cmd = 'Get-ChildItem -Force | Select-Object Mode,Name | Format-Table -AutoSize';
  const d = terminal.evaluatePolicy(cmd);
  assert.equal(d.denied, false, `pipeline should pass: ${d.reason}`);
});

test('a chain that hides a mutating command is still refused', () => {
  withTerminal({ mode: 'allowlist', allowlist: ['git status'] });
  for (const cmd of ['git status; rm -rf /', 'git status && npm install evil', 'ls | xargs rm -rf .']) {
    const d = terminal.evaluatePolicy(cmd);
    assert.equal(d.denied, true, `'${cmd}' must be refused`);
  }
});

test('redirection and command substitution stay blocked in allowlist mode', () => {
  withTerminal({ mode: 'allowlist', allowlist: ['npm test'] });
  for (const cmd of ['ls > out.txt', 'ls >> log', 'cat < secret', 'echo $(whoami)', 'echo `id`']) {
    const d = terminal.evaluatePolicy(cmd);
    assert.equal(d.denied, true, `'${cmd}' must be refused`);
  }
});

test('read_only mode allows reads and blocks mutations', () => {
  withTerminal({ mode: 'read_only', allowlist: [] });
  assert.equal(terminal.evaluatePolicy('Get-ChildItem -Force').denied, false);
  assert.equal(terminal.evaluatePolicy('git status').denied, false);
  assert.equal(terminal.evaluatePolicy('npm install lodash').denied, true);
  assert.equal(terminal.evaluatePolicy('rm -rf dist').denied, true);
});

test('prompt mode lets read-only commands through and asks for the rest', () => {
  withTerminal({ mode: 'prompt', allowlist: [] });
  assert.equal(terminal.evaluatePolicy('ls').denied, false);
  const asked = terminal.evaluatePolicy('npm install lodash');
  assert.equal(asked.denied, true);
  assert.equal(asked.needs_approval, true);
  assert.equal(terminal.evaluatePolicy('npm install lodash', { approved: true }).denied, false);
});

test('the denial names what is allowed, so the caller can adapt instead of retrying', () => {
  withTerminal({ mode: 'allowlist', allowlist: ['npm test'] });
  const d = terminal.evaluatePolicy('npm install left-pad');
  assert.equal(d.denied, true);
  assert.ok(Array.isArray(d.allowed_prefixes) && d.allowed_prefixes.length > 0, 'allowed prefixes are reported');
  assert.match(d.reason, /read-only/i);
});

test('the denylist cannot be smuggled through a pipeline stage', () => {
  withTerminal({ mode: 'allowlist', allowlist: [], denylist: ['shutdown'] });
  const d = terminal.evaluatePolicy('ls | shutdown /s');
  assert.equal(d.denied, true);
  assert.match(d.reason, /denylist/i);
});
