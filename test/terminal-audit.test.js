// Every terminal decision leaves a line, including the ones that say no.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-audit-'));
process.chdir(dir);

const policy = require('../src/daemon/core/policy');
const { runTerminal } = require('../src/daemon/core/tools/terminal-tool');

const auditPath = path.join(dir, '.liber', 'terminal-audit.log');
const readAudit = () => fs.existsSync(auditPath)
  ? fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(l => JSON.parse(l.slice(l.indexOf(' ') + 1)))
  : [];

test('a refused command is written to the audit with who asked', async () => {
  policy.configure({ terminal: { mode: 'prompt' } });
  const res = await runTerminal(
    { command: 'npm install definitely-not-a-real-package-xyz', cwd: dir, timeout: 5000 },
    { agentId: 'dev-bot', client: 'local', turnId: 't-1' }
  );

  assert.ok(res.needs_approval || res.policy_denied, 'the policy refused it');

  const lines = readAudit();
  const denial = lines.find(l => l.decision === 'deny');
  assert.ok(denial, 'a refusal leaves a trace: ' + JSON.stringify(lines));
  assert.strictEqual(denial.agentId, 'dev-bot');
  assert.strictEqual(denial.client, 'local');
  assert.strictEqual(denial.turnId, 't-1');
  assert.ok(String(denial.reason || '').length > 0, 'and says why');
  assert.ok(String(denial.command).includes('npm install'));
});

test('an allowed read-only command records allow then run', async () => {
  const before = readAudit().length;
  const res = await runTerminal(
    { command: 'echo audit-probe', cwd: dir, timeout: 20000 },
    { agentId: 'dev-bot', client: 'local', turnId: 't-2' }
  );

  assert.strictEqual(res.exit_code, 0);
  const lines = readAudit().slice(before);
  assert.ok(lines.some(l => l.decision === 'allow'), 'allow line');
  const run = lines.find(l => l.decision === 'run');
  assert.ok(run, 'run line');
  assert.strictEqual(run.exit_code, 0);
  assert.strictEqual(run.agentId, 'dev-bot');
  assert.ok(Number.isFinite(run.duration_ms));
});
