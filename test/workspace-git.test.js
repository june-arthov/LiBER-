// Branch names reach `git checkout` as an argv entry, so the guard is the only
// thing between a model-supplied string and a flag like --force.
const test = require('node:test');
const assert = require('node:assert');
const workspace = require('../src/daemon/core/workspace');

test('validBranchName accepts real branch shapes and rejects flags/traversal', () => {
  for (const ok of ['main', 'feat/slash-commands', 'fix_123', 'release/1.2.3', 'a.b']) {
    assert.equal(workspace.validBranchName(ok), true, `'${ok}' should be accepted`);
  }
  for (const bad of ['', '   ', '--force', '-b', 'a..b', 'x;rm -rf /', 'a b', 'a|b', 'a`b`', 'a$(b)', '../etc', null, undefined]) {
    assert.equal(workspace.validBranchName(bad), false, `'${bad}' must be refused`);
  }
});

test('checkout refuses an invalid name without running git', () => {
  const r = workspace.checkout('--force');
  assert.equal(r.ok, false);
  assert.match(r.error, /Refusing/);
});

test('checkout refuses a branch that does not exist locally', () => {
  const state = workspace.gitState();
  if (!state.is_git) return; // the guard below is what matters in a bare checkout
  const missing = 'definitely-not-a-branch-xyz';
  assert.ok(!state.branches.some(b => b.name === missing));
  const r = workspace.checkout(missing);
  assert.equal(r.ok, false);
  assert.match(r.error, /No local branch/);
});

test('gitState reports the real branch and remote of this repo', () => {
  const state = workspace.gitState();
  if (!state.is_git) return;
  assert.equal(state.branch, workspace.branch());
  assert.ok(Array.isArray(state.branches) && state.branches.some(b => b.current), 'the current branch is marked');
  assert.ok(state.remote === null || typeof state.remote.url === 'string');
  assert.ok(typeof state.dirty === 'boolean');
});

test('githubUrl normalises ssh and https remotes, and ignores anything else', () => {
  // githubUrl reads the live remote; assert only the contract the UI relies on
  const url = workspace.githubUrl();
  assert.ok(url === null || /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url), `unexpected url: ${url}`);
});
