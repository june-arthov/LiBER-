// Speech that is proved by a file, not by a promise of sound.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-voice-'));
process.env.LIBER_AUDIO_DIR = dir;

const voice = require('../src/daemon/core/voice');

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } });

test('the synth reports what this platform can actually do', () => {
  assert.equal(voice.available(), process.platform === 'win32');
});

test('empty input is refused instead of producing silence', async () => {
  const r = await voice.speak('   ');
  assert.equal(r.ok, false);
  assert.match(r.error, /Nothing to say/);
});

test('speaking writes a real wav file', { skip: process.platform !== 'win32' }, async () => {
  const r = await voice.speak('Liber voice check.', { play: false });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.bytes > 1000, `expected real audio, got ${r.bytes} bytes`);
  const head = fs.readFileSync(r.path).subarray(0, 4).toString('ascii');
  assert.equal(head, 'RIFF', 'a wav file starts with RIFF');
  assert.ok(fs.statSync(r.path).size === r.bytes);
});

test('installed voices are listed with a locale', { skip: process.platform !== 'win32' }, async () => {
  const list = await voice.voices();
  assert.ok(Array.isArray(list));
  if (list.length) {
    assert.ok(list[0].name.length > 0);
    assert.match(list[0].locale, /^[a-z]{2}-[A-Z]{2}$/);
  }
});
