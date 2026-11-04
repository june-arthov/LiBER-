// Guards the approval channel: a request that cannot ask a human must not
// authorize sensitive tools. This regressed once — /chat passed an always-true
// approval function, so `terminal` executed a non-allowlisted command with no
// prompt at all. A unit test cannot reach the daemon's request handler, so this
// asserts the wiring at the source level.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DAEMON = path.join(__dirname, '..', 'src', 'daemon', 'liberd.js');
const ENGINE = path.join(__dirname, '..', 'src', 'daemon', 'core', 'engine.js');

test('every waitForHitl passed by the daemon either asks a human or denies', () => {
  const src = fs.readFileSync(DAEMON, 'utf8');
  const marker = 'waitForHitl:';
  const calls = [];
  let at = src.indexOf(marker);
  while (at > -1) {
    // take the wiring expression, not just to the next comma: an arrow function
    // with parameters contains commas before its body
    calls.push(src.slice(at + marker.length, at + marker.length + 220).split('\n').slice(0, 3).join(' '));
    at = src.indexOf(marker, at + marker.length);
  }

  assert.ok(calls.length >= 2, `expected several approval wirings, found ${calls.length}`);

  for (const call of calls) {
    const denies = /Promise\.resolve\(false\)/.test(call);
    const asksHuman = /this\.waitForHitl/.test(call);
    assert.ok(
      denies || asksHuman,
      `waitForHitl was wired to '${call.trim()}' — a request path that approves everything makes the policy gate decorative`
    );
    assert.ok(
      !/Promise\.resolve\(true\)/.test(call),
      `waitForHitl was wired to '${call.trim()}' — auto-approval must never be a default`
    );
  }
});

test('the engine denies by default when no approval channel is supplied', () => {
  const src = fs.readFileSync(ENGINE, 'utf8');
  assert.match(
    src,
    /waitForHitl\s*=\s*async\s*\(\)\s*=>\s*false/,
    'runTurn must fail closed when the caller forgets to pass waitForHitl'
  );
  assert.ok(
    !/waitForHitl\s*=\s*async\s*\(\)\s*=>\s*true/.test(src),
    'runTurn must not ship an approve-by-default'
  );
});

test('a denied tool result tells the caller it was a policy denial', () => {
  const src = fs.readFileSync(ENGINE, 'utf8');
  assert.match(src, /policy_denied:\s*true/, 'denials must be distinguishable from tool errors');
  assert.ok(
    !src.includes('DENIED by the human operator'),
    'the message must not claim a human decided when the channel may be a timeout'
  );
});
