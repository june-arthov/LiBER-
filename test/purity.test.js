// test/purity.test.js — Liber is an original codebase: no Merlin/Hermes/Nous
// references may ever enter code, config, or skills. (README carries one
// intentional provenance sentence declaring the absence — excluded here.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src', 'bin', 'scripts', 'skills'];
const FILES = ['liber.yaml', '.env.example'];
const EXT = /\.(js|py|sh|yaml|yml|json)$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (EXT.test(entry.name)) out.push(p);
  }
  return out;
}

test('no Merlin/Hermes/Nous references anywhere in code or config', () => {
  const offenders = [];
  for (const d of DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/(merlin|hermes|nous)/i.test(text)) offenders.push(path.relative(ROOT, file));
    }
  }
  for (const f of FILES) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs) && /(merlin|hermes|nous)/i.test(fs.readFileSync(abs, 'utf8'))) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [], `these files still carry third-party framework references: ${offenders.join(', ')}`);
});

test('the soul module is liber-soul.js, not merlin-soul.js', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'daemon', 'core', 'merlin-soul.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'daemon', 'core', 'liber-soul.js')), true);
});
