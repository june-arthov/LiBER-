// The shell is the product surface, and it is not covered by a browser test yet.
// What can be checked without one: the UI still speaks the daemon's contract.
// This catches the class of bug that shipped a v0.5 window inside a 0.7.0 installer —
// the daemon grew events and endpoints, and the shell it was packed with did not.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'desktop', 'app', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// Every event the engine emits must be handled, or a turn will look frozen while it
// is actually waiting for the shell to render something.
const ENGINE_EVENTS = [
  'start', 'draft_start', 'draft', 'draft_end', 'reasoning_start', 'reasoning',
  'reasoning_end', 'thought', 'tool_dispatch', 'observation', 'todo',
  'hitl_intercept', 'hitl_approved', 'grounding_audit', 'grounding_pass',
  'grounding_warning', 'injection_warning', 'loop_guard', 'memory',
  'subagent_start', 'subagent_end', 'fallback', 'telemetry', 'budget_blocked',
  'stopped', 'finalizing', 'converging', 'native_tools_unavailable', 'done', 'final'
];

test('the shell handles every event the engine emits', () => {
  const missing = ENGINE_EVENTS.filter(name => !html.includes(`'${name}'`) && !html.includes(`"${name}"`));
  assert.deepStrictEqual(missing, [], 'unhandled events: ' + missing.join(', '));
});

test('the shell calls the endpoints the features rely on', () => {
  const required = [
    '/chat/stream', '/hitl/verdict', '/stop', '/sessions/share',
    '/sessions', '/sandbox', '/media', '/config', '/providers', '/vault'
  ];
  const missing = required.filter(route => !html.includes(route));
  assert.deepStrictEqual(missing, [], 'endpoints never called by the UI: ' + missing.join(', '));
});

test('the version badge is read from the daemon, not hardcoded', () => {
  assert.ok(html.includes('id="brand-ver"'), 'the badge needs an id to be filled');
  assert.ok(!/brand-ver">v\d/.test(html), 'a literal version was baked into the shell again');
  assert.ok(html.includes("badge.textContent='v'+j.version"), 'and it must come from /whoami');
});

test('the shell says so when the daemon is unreachable', () => {
  // Honest degradation is a contract: an empty sidebar must explain itself instead of
  // looking like the user lost their history.
  assert.ok(html.includes('daemon offline'), 'the sidebar must name the offline state');
});

test('the shipped bundle contains the same shell as the source', (t) => {
  const bundle = path.join(root, 'desktop', 'dist', 'liber-desktop', 'resources.neu');
  if (!fs.existsSync(bundle)) {
    t.skip('resources.neu not built in this checkout — run: cd desktop && npx neu build');
    return;
  }

  const stat = fs.statSync(bundle);
  const newestSource = fs.readdirSync(path.join(root, 'desktop', 'app'), { recursive: true })
    .map(f => path.join(root, 'desktop', 'app', String(f)))
    .filter(p => fs.existsSync(p) && fs.statSync(p).isFile())
    .reduce((latest, p) => Math.max(latest, fs.statSync(p).mtimeMs), 0);

  assert.ok(stat.mtimeMs >= newestSource,
    'resources.neu is older than desktop/app — the installer would carry an old UI');

  // Content, not just mtime: the markers below only exist in the current shell.
  const bytes = fs.readFileSync(bundle, 'latin1');
  for (const marker of ['Images &amp; Video', 'Share link', 'id="brand-ver"']) {
    assert.ok(bytes.includes(marker), `bundle is missing "${marker}" — it was built from an older app/`);
  }
});
