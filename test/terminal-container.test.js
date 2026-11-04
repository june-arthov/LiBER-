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
const hasDocker = terminal.containerAvailable(true);
const skip = hasDocker ? false : 'Docker daemon not reachable';

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
      'echo ok > /work/.liber/container-test.txt && echo workspace-write-ok',
      '(timeout 3 wget -q -O- http://example.com >/dev/null 2>&1 && echo LEAK-network) || echo network-blocked'
    ].join('; ');

    const out = await terminal.runTerminal({ command: cmd, cwd: ROOT }, { approved: true });
    assert.equal(out.backend, 'docker', 'the command must have run in the container');
    assert.equal(out.sandboxed, true);
    assert.match(out.output, /no-windows-fs/, 'the Windows filesystem must not be mounted');
    assert.match(out.output, /rootfs-readonly/, 'the root filesystem must be read-only');
    assert.match(out.output, /network-blocked/, 'the network must be off by default');
    assert.equal(/LEAK-/.test(out.output), false, `an escape succeeded: ${out.output}`);
  });

test('the workspace is mounted read-write, so work still happens', { skip }, async () => {
  policy.configure({ terminal: { mode: 'open', backend: 'docker' } });
  const probe = path.join(ROOT, '.liber', 'container-test.txt');
  try { fs.unlinkSync(probe); } catch { }
  const out = await terminal.runTerminal({ command: 'echo from-container > /work/.liber/container-test.txt', cwd: ROOT }, { approved: true });
  assert.equal(out.exit_code, 0);
  assert.equal(fs.existsSync(probe), true, 'the host must see the file the container wrote');
  assert.match(fs.readFileSync(probe, 'utf8'), /from-container/);
  fs.unlinkSync(probe);
});

test('the hostname inside is not the host name', { skip }, async () => {
  policy.configure({ terminal: { mode: 'open', backend: 'docker' } });
  const os = require('os');
  const out = await terminal.runTerminal({ command: 'hostname', cwd: ROOT }, { approved: true });
  const inside = String(out.output).trim();
  assert.ok(inside.length >= 12 && /^[0-9a-f]+$/.test(inside), `expected a container id, got "${inside}"`);
  assert.notEqual(inside.toLowerCase(), String(os.hostname()).toLowerCase());
});
