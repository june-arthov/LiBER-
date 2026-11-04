// A vault is only a vault if the file on disk gives nothing away.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-vault-'));
process.env.LIBER_VAULT_DIR = dir;
const vault = require('../src/daemon/core/vault');

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } });

test('a secret round-trips and the file on disk never shows it', () => {
  const secret = 'sk-live-abcdef0123456789';
  assert.equal(vault.set('openai.api_key', secret).ok, true);
  assert.equal(vault.get('openai.api_key'), secret);

  const raw = fs.readFileSync(vault.VAULT(), 'utf8');
  assert.equal(raw.includes(secret), false, 'plaintext leaked into vault.json');
  assert.equal(raw.includes('sk-live'), false, 'even a prefix leaked');
});

test('listing returns metadata, never the secret', () => {
  const rows = vault.list();
  const row = rows.find(r => r.name === 'openai.api_key');
  assert.ok(row);
  assert.equal(row.hint, '…6789');
  assert.equal(JSON.stringify(row).includes('abcdef0123456789'), false);
});

test('overwriting keeps one entry and the newest value', () => {
  vault.set('dup', 'first-value-1111');
  vault.set('dup', 'second-value-2222');
  assert.equal(vault.get('dup'), 'second-value-2222');
  assert.equal(vault.list().filter(r => r.name === 'dup').length, 1);
});

test('a tampered file fails closed instead of returning garbage', () => {
  vault.set('tamper', 'original-secret');
  const state = JSON.parse(fs.readFileSync(vault.VAULT(), 'utf8'));
  const rec = state.entries.tamper;
  // flip one byte of ciphertext
  const ct = Buffer.from(rec.ct, 'base64');
  ct[0] = ct[0] ^ 0xff;
  rec.ct = ct.toString('base64');
  fs.writeFileSync(vault.VAULT(), JSON.stringify(state));

  assert.equal(vault.get('tamper'), null, 'a bad tag must not decrypt');
  assert.ok(vault.list().some(r => r.name === 'tamper'), 'the entry still exists, it is just unreadable');
});

test('remove deletes the entry and unknown names answer cleanly', () => {
  vault.set('gone', 'value-9999');
  assert.equal(vault.remove('gone').ok, true);
  assert.equal(vault.get('gone'), null);
  assert.equal(vault.remove('gone').ok, false);
  assert.equal(vault.get('never-existed'), null);
  assert.equal(vault.set('', 'x').ok, false);
  assert.equal(vault.set('empty', '').ok, false);
});

test('migration moves plaintext credentials into the vault and leaves references', () => {
  const credFile = path.join(dir, 'credentials.json');
  fs.writeFileSync(credFile, JSON.stringify({
    providers: { groq: { api_key: 'gsk-plaintext-1234', base: 'https://api.groq.com' } }
  }));

  const out = vault.migrateCredentials(credFile);
  assert.equal(out.ok, true);
  assert.deepEqual(out.moved, ['groq.api_key']);

  const after = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  assert.equal(after.providers.groq.api_key, 'vault:groq.api_key');
  assert.equal(vault.get('groq.api_key'), 'gsk-plaintext-1234');
  assert.equal(JSON.stringify(after).includes('gsk-plaintext'), false, 'the file must be clean');
  assert.equal(vault.resolveRef('vault:groq.api_key'), 'gsk-plaintext-1234');
  assert.equal(vault.resolveRef('plain-value'), 'plain-value');
});
