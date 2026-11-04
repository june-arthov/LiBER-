// The container backend is the difference between "policy says no" and "the
// machine is not reachable". These tests run real Docker; they skip when the
// daemon is down rather than pretending.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const policy = require('../src/daemon/core/policy');
const terminal = require('../src/daemon/core/tools/terminal-tool');
const ROOT = path.resolve(__dirname, '..');
const probe = terminal.containerUsable(true);
const skip = probe.ok ? false : `container cannot run here: ${probe.error}`;

test('a requested backend that cannot run containers explains itself', () => {
  policy.configure({ terminal: { mode: 'open', backend: 'docker', image: 'alpine:latest' } });
  const profile = terminal.containerPolicy();
  if (profile.on) {
    assert.equal(profile.fallback_reason, null);
  } else {
    assert.equal(profile.requested, true);
    assert.ok(profile.fallback_reason, 'an unusable backend must state the reason');
  }
});

test('policy keeps the backend settings instead of dropping them', () => {
  policy.configure({ terminal: { mode: 'open', backend: 'docker', image: 'alpine:latest', allow_network: true, memory: '256m', pids: 64 } });
  const cfg = policy.terminalConfig();
  assert.equal(cfg.backend, 'docker');
  assert.equal(cfg.image, 'alpine:latest');
  assert.equal(cfg.allow_network, true);
  assert.equal(cfg.memory, '256m');
  assert.equal(cfg.pids, 64);

  // an unknown backend falls back rather than running unsandboxed
  policy.configure({ terminal: { backend: 'nonsense' } });
  assert.equal(policy.terminalConfig().backend, 'powershell');
});

test('a docker command cannot see Windows, write outside the workspace, or reach the network',
  { skip }, async () => {
    policy.configure({ terminal: { mode: 'open', backend: 'docker', image: 'alpine:latest' } });
    const cmd = [
      'echo host=$(hostname)',
      '(ls /mnt/c >/dev/null 2>&1 && echo LEAK-mntc) || echo no-windows-fs',
      '(touch /etc/nope 2>/dev/null && echo LEAK-rootfs) || echo rootfs-readonly',
      // write into the repo root: .liber/ need not exist on a fresh checkout
      'echo ok > /work/container-test.txt && echo workspace-write-ok',
      '(timeout 3 wget -q -O- http://example.com >/dev/null 2>&1 && echo LEAK-network) || echo network-blocked'
    ].join('; ');

    const out = await terminal.runTerminal({ command: cmd, cwd: ROOT }, { approved: true });
    const detail = `${out.output || ''}${out.error ? ' | ' + out.error : ''}`;
    assert.equal(out.backend, 'docker', `expected the container backend, got '${out.backend}': ${detail}`);
    assert.equal(out.sandboxed, true);
    assert.match(detail, /no-windows-fs/, detail);
    assert.match(detail, /rootfs-readonly/, detail);
    assert.match(detail, /network-blocked/, detail);
    assert.equal(/LEAK-/.test(detail), false, `an escape succeeded: ${detail}`);
  });

test('the workspace is mounted read-write, so work still happens', { skip }, async () => {
  policy.configure({ terminal: { mode: 'open', backend: 'docker' } });
  const probeFile = path.join(ROOT, 'container-test.txt');
  try { fs.unlinkSync(probeFile); } catch { }
  const out = await terminal.runTerminal({ command: 'echo from-container > /work/container-test.txt', cwd: ROOT }, { approved: true });
  assert.equal(out.exit_code, 0, out.error || out.output);
  assert.equal(fs.existsSync(probeFile), true, `the host must see the file the container wrote: ${out.output || out.error}`);
  assert.match(fs.readFileSync(probeFile, 'utf8'), /from-container/);
  fs.unlinkSync(probeFile);
});

test('the hostname inside is not the host name', { skip }, async () => {
  policy.configure({ terminal: { mode: 'open', backend: 'docker' } });
  const os = require('os');
  const out = await terminal.runTerminal({ command: 'hostname', cwd: ROOT }, { approved: true });
  const inside = String(out.output).trim();
  assert.ok(inside.length >= 6, `expected a container hostname, got "${inside}" (${out.error || ''})`);
  assert.notEqual(inside.toLowerCase(), String(os.hostname()).toLowerCase());
});
