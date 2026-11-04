// src/daemon/core/voice.js — Windows speech, kept deliberately small.
//
// TTS uses the voices already installed in Windows (SAPI), so there is nothing
// to download and no key to configure. It synthesises to a WAV file first and
// then plays it, which means the same call can also hand the file back.
// STT is not implemented: that needs a microphone pipeline and a model, and
// pretending otherwise would be worse than saying so.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const AUDIO_DIR = () => path.resolve(process.env.LIBER_AUDIO_DIR || path.join(process.cwd(), '.liber', 'audio'));

function available() {
  return process.platform === 'win32';
}

/** The installed SAPI voices, so the UI can offer real names. */
function voices() {
  if (!available()) return [];
  const script = [
    "Add-Type -AssemblyName System.Speech",
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$s.GetInstalledVoices() | ForEach-Object { $v = $_.VoiceInfo; $v.Name + "|" + $v.Culture.Name + "|" + $v.Gender }'
  ].join('\n');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        const rows = String(stdout).split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
          const [name, locale, gender] = line.split('|');
          return { name, locale, gender };
        });
        resolve(rows);
      });
  });
}

/**
 * Synthesise text to a WAV file, then optionally play it.
 * Returns the file path and size — a real artefact, not a promise of sound.
 */
async function speak(text, { voice = null, rate = 0, play = true } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: 'Nothing to say.' };
  if (!available()) return { ok: false, error: 'Speech synthesis is only wired for Windows (SAPI).' };

  const dir = AUDIO_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `say-${Date.now()}.wav`);
  const capped = clean.length > 4000 ? clean.slice(0, 4000) : clean;

  const ps = [
    "Add-Type -AssemblyName System.Speech",
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    voice ? `$s.SelectVoice('${String(voice).replace(/'/g, "''")}')` : 'try { $s.SelectVoice((($s.GetInstalledVoices() | Where-Object { $_.Enabled })[0]).VoiceInfo.Name) } catch { }',
    `$s.Rate = ${Math.max(-10, Math.min(10, Number(rate) || 0))}`,
    `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}')`,
    `$s.Speak([Console]::In.ReadToEnd())`,
    '$s.Dispose()',
    play ? `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()` : ''
  ].filter(Boolean).join('\n');

  return new Promise((resolve) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) return resolve({ ok: false, error: String(stderr || err.message).slice(0, 300) });
        try {
          const bytes = fs.statSync(file).size;
          if (bytes < 44) return resolve({ ok: false, error: 'The synthesiser produced no audio.' });
          resolve({ ok: true, path: file, bytes, voice: voice || 'default', chars: capped.length });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    // the text goes in on stdin so quotes and newlines cannot break the script
    child.stdin.write(capped);
    child.stdin.end();
  });
}

module.exports = { speak, voices, available, AUDIO_DIR };
