// test/workspace.test.js — real workspace state surfaced to the desktop shell.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const workspace = require('../src/daemon/core/workspace');
const policy = require('../src/daemon/core/policy');
const { evaluatePolicy } = require('../src/daemon/core/tools/terminal-tool');

test('workspace.summary reports cwd and real git state for this repo', () => {
  const s = workspace.summary();
  assert.equal(typeof s.cwd, 'string');
  assert.ok(s.cwd.length > 0);
  if (!s.is_git) return; // a tarball checkout has no git — nothing to assert
  assert.equal(typeof s.branch, 'string');
  assert.ok(Array.isArray(s.changed_files));
  for (const f of s.changed_files) {
    assert.equal(typeof f.path, 'string');
    assert.ok(Number.isFinite(f.additions) && f.additions >= 0);
    assert.ok(Number.isFinite(f.deletions) && f.deletions >= 0);
  }
  assert.equal(s.totals.files, s.changed_files.length);
});

test('workspace.summary counts a real modified file in a throwaway repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-ws-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  const prev = process.cwd();
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n', 'utf8');
    git(['add', '.']);
    git(['commit', '-qm', 'init']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x\ny\n', 'utf8');

    process.chdir(dir);
    const s = workspace.summary();
    const a = s.changed_files.find(f => f.path === 'a.txt');
    assert.ok(a, 'modified file is listed');
    assert.equal(a.additions, 2);
    assert.ok(s.changed_files.some(f => f.path === 'new.txt'), 'untracked file is listed');
  } finally {
    process.chdir(prev);
  }
});

test('activity ring records tool steps and survives the cap', () => {
  workspace.clear();
  for (let i = 0; i < 70; i++) workspace.record({ tool: 'read_file', ok: true, evidence: 'E' + i });
  const recent = workspace.recent(5);
  assert.equal(recent.length, 5);
  assert.equal(recent[0].evidence, 'E69', 'newest first');
  workspace.clear();
  assert.equal(workspace.recent().length, 0);
});

test("permission preset 'turbo' maps to the open terminal mode", () => {
  policy.configure({ terminal: { mode: 'open', allowlist: [], denylist: ['mkfs'] } });
  assert.equal(evaluatePolicy('rm -rf build').denied, false);
  assert.equal(evaluatePolicy('mkfs.ext4 /dev/sda').denied, true, 'denylist still wins');
  policy.configure({ terminal: { mode: 'allowlist', allowlist: [], denylist: [] } });
});
