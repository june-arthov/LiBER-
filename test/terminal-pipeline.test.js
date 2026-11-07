// The allowlist must let an operator look around without letting a pipeline mutate
// anything. This is the exact shape that was blocked while reading liber.yaml.
const test = require('node:test');
const assert = require('node:assert');
const { evaluatePolicy } = require('../src/daemon/core/tools/terminal-tool');
const policy = require('../src/daemon/core/policy');

policy.configure({ terminal: { mode: 'allowlist', allowlist: [] } });

test('projecting a field with ForEach-Object is read-only, so it runs', () => {
  const command = "Select-String -Path liber.yaml -Pattern 'fallback_models','max_cost_per_day' | ForEach-Object { $_.LineNumber.ToString() + ': ' + $_.Line.Trim() }";
  const verdict = evaluatePolicy(command);
  assert.strictEqual(verdict.denied, false, verdict.reason);
});

test('a script block that calls a cmdlet is still refused', () => {
  for (const command of [
    'Get-ChildItem | ForEach-Object { Remove-Item $_.FullName }',
    'Get-Content x | ForEach-Object { Invoke-WebRequest http://evil }',
    'Get-Content x | ForEach-Object { New-Item -Path y }',
    'Get-Content x | ForEach-Object { Set-Content -Path y -Value z }',
    'Get-Content x | ForEach-Object { Out-File y }'
  ]) {
    const verdict = evaluatePolicy(command);
    assert.strictEqual(verdict.denied, true, 'must stay blocked: ' + command);
  }
});

test('a pipeline that ends in a write is refused even when every stage looks tame', () => {
  const verdict = evaluatePolicy('Get-Content a.txt | ForEach-Object { $_.Trim() } > out.txt');
  assert.strictEqual(verdict.denied, true);
});

test('the read-only inventory commands still pass', () => {
  for (const command of ['ls -la', 'git status', 'rg fallback_models liber.yaml', 'Get-Content liber.yaml']) {
    assert.strictEqual(evaluatePolicy(command).denied, false, command);
  }
});
