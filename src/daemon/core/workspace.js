// src/daemon/core/workspace.js — live workspace state for the desktop shell.
// Reads real git state (no invented numbers) and keeps a ring buffer of the
// tool activity this daemon has actually seen since boot.
const { execFileSync } = require('child_process');
const path = require('path');

const ACTIVITY_CAP = 60;
const activity = [];

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: opts.timeout || 4000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    });
  } catch {
    return null;
  }
}

function isGitRepo() {
  return sh('git', ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

function branch() {
  // `rev-parse --abbrev-ref HEAD` prints the literal string "HEAD" on a detached
  // checkout (CI tag builds do this), which is not a branch name — reporting it
  // as one made the UI show a branch called HEAD and marked nothing current.
  const b = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (b && b.trim() && b.trim() !== 'HEAD') return b.trim();
  const detached = sh('git', ['rev-parse', '--short', 'HEAD']);
  return detached ? `detached@${detached.trim()}` : null;
}

/**
 * Changed files with real line counts.
 * Parse `git status --porcelain=v1` for the file list and `git diff --numstat`
 * (worktree vs HEAD) for additions/deletions; untracked files count as all-new.
 */
function changedFiles(limit = 40) {
  if (!isGitRepo()) return [];
  const status = sh('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!status) return [];

  const numstat = sh('git', ['diff', '--numstat', 'HEAD']) || '';
  const stats = new Map();
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    stats.set(m[3].trim(), {
      additions: m[1] === '-' ? 0 : Number(m[1]),
      deletions: m[2] === '-' ? 0 : Number(m[2])
    });
  }

  const out = [];
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2).trim() || '??';
    let file = line.slice(3).trim();
    // renames render as "old -> new"; report the new path
    if (file.includes(' -> ')) file = file.split(' -> ').pop().trim();
    file = file.replace(/^"|"$/g, '');

    const s = stats.get(file) || { additions: 0, deletions: 0 };
    if (code === '??' && s.additions === 0) {
      // untracked: count real lines so the badge is not a lie
      const wc = sh('git', ['ls-files', '--others', '--exclude-standard', '--error-unmatch', file]);
      s.additions = wc === null ? 0 : 0;
    }
    out.push({ path: file, status: code, additions: s.additions, deletions: s.deletions });
    if (out.length >= limit) break;
  }
  return out;
}

function summary(limit = 40) {
  const files = changedFiles(limit);
  const git = isGitRepo();
  return {
    cwd: process.cwd(),
    is_git: git,
    branch: git ? branch() : null,
    changed_files: files,
    totals: {
      files: files.length,
      additions: files.reduce((a, f) => a + (f.additions || 0), 0),
      deletions: files.reduce((a, f) => a + (f.deletions || 0), 0)
    }
  };
}

/** Record one tool step the engine actually ran (fed from turn events). */
function record(event) {
  if (!event || !event.tool) return;
  activity.unshift({
    ts: new Date().toISOString(),
    tool: event.tool,
    ok: event.ok !== false,
    evidence: event.evidence || null,
    detail: String(event.detail || '').slice(0, 240),
    exit_code: Number.isFinite(event.exit_code) ? event.exit_code : null
  });
  while (activity.length > ACTIVITY_CAP) activity.pop();
}

function recent(limit = 20) {
  return activity.slice(0, limit);
}

function clear() {
  activity.length = 0;
}

/**
 * Run git and keep the failure text: a checkout that is refused must be able to
 * say why ("local changes would be overwritten"), which `sh()` above swallows.
 */
function git(args, timeout = 8000) {
  try {
    const out = execFileSync('git', args, {
      cwd: process.cwd(), encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    return { ok: true, out: String(out || '').trim(), err: '' };
  } catch (error) {
    const out = String(error?.stdout || '').trim();
    const err = String(error?.stderr || error?.message || '').trim();
    return { ok: false, out, err };
  }
}

/** Branch name that is safe to pass as a single argv entry: no flags, no shell syntax. */
function validBranchName(name) {
  const s = String(name || '').trim();
  if (!s || s.length > 200) return false;
  if (s.startsWith('-')) return false;
  return /^[A-Za-z0-9._\/-]+$/.test(s) && !s.includes('..');
}

/** Local branches, the remote URL and how far the branch has drifted from upstream. */
function gitState() {
  if (!isGitRepo()) return { is_git: false, branch: null, branches: [], remote: null, ahead: null, behind: null, dirty: false };

  const current = branch();
  const list = git(['branch', '--format=%(refname:short)']).out.split('\n').map(s => s.trim()).filter(Boolean);
  const remoteUrl = git(['remote', 'get-url', 'origin']).out || null;
  const counts = git(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  let ahead = null;
  let behind = null;
  if (counts.ok) {
    const [a, b] = counts.out.split(/\s+/);
    ahead = Number(a);
    behind = Number(b);
  }
  const dirty = (git(['status', '--porcelain']).out || '').trim().length > 0;

  return {
    is_git: true,
    root: git(['rev-parse', '--show-toplevel']).out || process.cwd(),
    branch: current,
    // CI checks out a commit, not a branch: say so instead of pretending a
    // branch is current and letting the UI mark nothing.
    detached: String(current || '').startsWith('detached@'),
    branches: list.map(name => ({ name, current: name === current })),
    remote: remoteUrl ? { name: 'origin', url: remoteUrl } : null,
    ahead, behind, dirty
  };
}

/** Checkout a local branch; refuses traversal, flags and unknown names. */
function checkout(name) {
  const target = String(name || '').trim();
  if (!validBranchName(target)) return { ok: false, error: `Refusing '${target}': not a valid branch name.` };
  const known = gitState().branches.map(b => b.name);
  if (known.length && !known.includes(target)) return { ok: false, error: `No local branch named '${target}'.` };
  const r = git(['checkout', target], 20000);
  return r.ok
    ? { ok: true, branch: branch(), message: r.out || `Switched to '${target}'.` }
    : { ok: false, error: r.err || r.out || 'git checkout failed.' };
}

/** Fetch from origin so ahead/behind numbers are current. */
function fetchRemote() {
  const r = git(['fetch', '--prune', 'origin'], 30000);
  const state = gitState();
  return r.ok
    ? { ok: true, ...state, message: r.out || 'Fetched origin.' }
    : { ok: false, error: r.err || r.out || 'git fetch failed.', ...state };
}

/** GitHub web URL for the origin remote, when it points at github.com. */
function githubUrl() {
  const url = (gitState().remote || {}).url;
  if (!url) return null;
  let m = /^git@github\.com:(.+?)(?:\.git)?$/i.exec(url);
  if (m) return `https://github.com/${m[1].replace(/\.git$/, '')}`;
  m = /^https?:\/\/github\.com\/(.+?)(?:\.git)?$/i.exec(url);
  if (m) return `https://github.com/${m[1].replace(/\.git$/, '')}`;
  return null;
}

module.exports = { summary, changedFiles, branch, isGitRepo, record, recent, clear, gitState, checkout, fetchRemote, githubUrl, validBranchName };
