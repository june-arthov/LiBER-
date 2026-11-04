// The sandbox is only worth having if it actually blocks something. These tests
// try the escape a model would try first and require it to fail, and check that
// secrets in the parent process do not reach the child.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const terminal = require('../src/daemon/core/tools/terminal-tool');
const policy = require('../src/daemon/core/policy');

const ROOT = path.resolve(__dirname, '..');
const CANARY = path.join(ROOT, '.liber', `sandbox-canary-${process.pid}.txt`);

test('the sandbox is on by default on Windows', () => {
  const profile = terminal.sandboxPolicy();
  assert.equal(profile.requested, true);
  if (process.platform === 'win32') assert.equal(profile.on, true);
});

test('policy can turn the sandbox off, and says so', () => {
  const before = policy.terminalConfig();
  const original = policy.terminalConfig; // keep the real one reachable
  policy.terminalConfig = () => ({ ...before, sandbox: false });
  try {
    assert.equal(terminal.sandboxPolicy().on, false);
  } finally {
    policy.terminalConfig = original;
  }
});

test('a .NET file write is refused inside the sandbox', { skip: process.platform !== 'win32' }, async () => {
  try { fs.unlinkSync(CANARY); } catch { }
  const out = await terminal.runTerminal({
    command: `[System.IO.File]::WriteAllText('${CANARY.replace(/\\/g, '/')}', 'pwned'); Write-Output 'done'`,
    cwd: ROOT
  }, { approved: true });

  assert.equal(out.sandboxed, true, 'the command must have run sandboxed');
  assert.match(out.output, /Cannot invoke method|not supported in this language mode/,
    'the block must be visible in the output, not silent');
  assert.equal(fs.existsSync(CANARY), false, 'the file must not exist');
});

test('provider keys in the parent environment are not inherited', { skip: process.platform !== 'win32' }, async () => {
  process.env.LIBER_TEST_SECRET = 'leak-me-please';
  const out = await terminal.runTerminal({
    command: "Write-Output ('K=' + $env:LIBER_TEST_SECRET + '')",
    cwd: ROOT
  }, { approved: true });
  assert.equal(out.sandboxed, true);
  assert.equal(String(out.output).includes('leak-me-please'), false, `the child saw the secret: ${out.output}`);
});

test('every allowed command leaves an audit line', { skip: process.platform !== 'win32' }, async () => {
  const logPath = path.join(ROOT, '.liber', 'terminal-audit.log');
  const before = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').length : 0;
  await terminal.runTerminal({ command: 'Write-Output audit', cwd: ROOT }, { approved: true });
  const after = fs.readFileSync(logPath, 'utf8');
  assert.ok(after.length > before, 'the log must grow');
  const newLines = after.slice(before).trim().split('\n');
  assert.ok(newLines.some(l => l.includes('"decision":"allow"')), 'an allow decision is recorded');
  assert.ok(newLines.some(l => l.includes('"decision":"run"')), 'the run and its exit code are recorded');
});
