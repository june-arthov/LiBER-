// src/daemon/core/tools/media-tool.js — images and video from text, with receipts.
//
// Nothing is generated locally: there is no model on this machine, so every call
// goes to a provider the operator configured. What LiBER adds is the part that
// makes the result trustworthy: the file is written into the workspace, its path
// and size come back as a tool result (so the grounding gate can cite it), the
// spend is recorded, and a missing capability is reported instead of pretended.
const fs = require('fs');
const path = require('path');
const providers = require('../providers');
const budget = require('../budget');

const DEFAULT_IMAGE_MODEL = 'gpt-image-1';

function artifactsDir() {
  const dir = path.resolve(process.cwd(), 'artifacts', 'media');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function slug(text, max = 40) {
  return String(text || 'media')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'media';
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** Which key and base URL an image/video call would use right now. */
function policy() {
  const key = providers.resolve('openai', 'https://api.openai.com/v1');
  const replicate = providers.resolve('replicate', 'https://api.replicate.com/v1');
  let ffmpeg = null;
  try {
    const { sandboxEnv } = require('./terminal-tool');
    const candidates = [
      process.env.LIBER_FFMPEG,
      path.resolve(process.cwd(), 'runtime', 'ffmpeg.exe'),
      path.resolve(process.cwd(), 'runtime', 'ffmpeg')
    ].filter(Boolean);
    for (const c of candidates) {
      if (fs.existsSync(c)) { ffmpeg = c; break; }
    }
    if (!ffmpeg) {
      const which = require('child_process').execFileSync(process.platform === 'win32' ? 'where' : 'which',
        ['ffmpeg'], { stdio: ['ignore', 'pipe', 'ignore'], env: sandboxEnv() }).toString().trim().split(/\r?\n/)[0];
      if (which) ffmpeg = which;
    }
  } catch { /* not installed: reported honestly below */ }

  return {
    images: { configured: !!key, provider: key ? 'openai' : null, model: DEFAULT_IMAGE_MODEL },
    video: { configured: !!replicate, provider: replicate ? 'replicate' : null },
    ffmpeg,
    max_usd_per_call: Number(process.env.LIBER_MEDIA_MAX_USD) || 2
  };
}

function ensureSpend(cost) {
  const snap = budget.snapshot();
  const cap = Number(process.env.LIBER_MEDIA_MAX_USD) || 2;
  const perCall = Number(cost) || 0;
  if (perCall > cap) {
    return { ok: false, error: `This call is estimated at $${perCall.toFixed(2)}, above the $${cap.toFixed(2)} per-call ceiling (LIBER_MEDIA_MAX_USD).` };
  }
  const daily = Number(process.env.LIBER_MEDIA_DAILY_USD) || 0;
  if (daily > 0 && snap.cost_usd + perCall > daily) {
    return { ok: false, error: `Daily media ceiling reached ($${snap.cost_usd.toFixed(2)} spent, $${daily.toFixed(2)} allowed).` };
  }
  return { ok: true };
}

async function postJson(url, body, headers, timeout = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Text to image. OpenAI-compatible by default; any endpoint that speaks
 * POST {base}/images/generations works (including a self-hosted gateway).
 */
async function imageGenerate({ prompt, size = '1024x1024', model = DEFAULT_IMAGE_MODEL, endpoint = null, n = 1 } = {}, meta = {}) {
  const text = String(prompt || '').trim();
  if (!text) return { error: 'A prompt is required.' };

  const key = providers.resolve('openai', endpoint || 'https://api.openai.com/v1');
  if (!key) {
    return {
      error: 'No image provider is configured. Add an OpenAI key in Settings → Providers (or a custom endpoint that speaks /images/generations).',
      needs_provider: 'openai'
    };
  }
  const base = String(endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '');

  const spend = ensureSpend(0.08);
  if (!spend.ok) return { error: spend.error, budget_blocked: true };

  const res = await postJson(`${base}/images/generations`,
    { model, prompt: text, size, n: Math.max(1, Math.min(Number(n) || 1, 4)) },
    { Authorization: `Bearer ${key}` });

  if (!res.ok) {
    const detail = res.data?.error?.message || res.data?.error || res.data?.raw || `HTTP ${res.status}`;
    return { error: `Image provider refused the request: ${String(detail).slice(0, 300)}` };
  }

  const items = Array.isArray(res.data?.data) ? res.data.data : [];
  if (!items.length) return { error: 'The provider answered without an image.' };

  const dir = artifactsDir();
  const files = [];
  items.forEach((item, i) => {
    if (!item?.b64_json) return;
    const bytes = Buffer.from(item.b64_json, 'base64');
    const file = path.join(dir, `${stamp()}-${slug(text)}${items.length > 1 ? '-' + (i + 1) : ''}.png`);
    fs.writeFileSync(file, bytes);
    files.push({ path: file, bytes: bytes.length });
  });
  if (!files.length) return { error: 'The provider returned no base64 image data (response_format may be unsupported).' };

  budget.recordSpend(0.08, 'media');
  return {
    kind: 'image',
    provider: 'openai',
    model,
    prompt: text,
    files,
    cost_usd: 0.08,
    revised_prompt: items[0]?.revised_prompt || null,
    note: files.length > 1 ? `${files.length} images written.` : 'Image written to the workspace.'
  };
}

async function pollPrediction(url, key, timeoutMs = 600000) {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) return { ok: false, error: 'The provider did not finish in 10 minutes.' };
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const data = await res.json().catch(() => ({}));
    const status = String(data.status || '');
    if (status === 'succeeded') return { ok: true, data };
    if (status === 'failed' || status === 'canceled') {
      return { ok: false, error: `Generation ${status}: ${data.error || 'no detail'}` };
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

/**
 * Text to video through Replicate. Model versions change, so the caller passes one
 * (owner/model:version) or the operator sets LIBER_VIDEO_MODEL.
 */
async function videoGenerate({ prompt, model = null, seconds = 4 } = {}, meta = {}) {
  const text = String(prompt || '').trim();
  if (!text) return { error: 'A prompt is required.' };

  const key = providers.resolve('replicate', 'https://api.replicate.com/v1');
  if (!key) {
    return {
      error: 'No video provider is configured. Add a Replicate token in Settings → Providers.',
      needs_provider: 'replicate'
    };
  }
  const version = String(model || process.env.LIBER_VIDEO_MODEL || '').trim();
  if (!version) {
    return {
      error: 'A model version is required for video. Set LIBER_VIDEO_MODEL (owner/model:version) or pass model.',
      needs_model: true
    };
  }

  const spend = ensureSpend(Number(process.env.LIBER_VIDEO_COST_USD) || 0.5);
  if (!spend.ok) return { error: spend.error, budget_blocked: true };

  const create = await postJson('https://api.replicate.com/v1/predictions',
    { version, input: { prompt: text, seconds: Number(seconds) || 4 } },
    { Authorization: `Bearer ${key}` });
  if (!create.ok) {
    return { error: `Video provider refused the request: ${JSON.stringify(create.data).slice(0, 300)}` };
  }

  const pollUrl = create.data?.urls?.get;
  if (!pollUrl) return { error: 'The provider did not return a polling URL.' };

  const done = await pollPrediction(pollUrl, key);
  if (!done.ok) return { error: done.error };

  const output = done.data.output;
  const url = Array.isArray(output) ? output[output.length - 1] : (typeof output === 'string' ? output : null);
  if (!url) return { error: 'The provider finished without a video URL.' };

  const bin = await fetch(url);
  if (!bin.ok) return { error: `Could not download the result (HTTP ${bin.status}).` };
  const bytes = Buffer.from(await bin.arrayBuffer());

  const dir = artifactsDir();
  const file = path.join(dir, `${stamp()}-${slug(text)}.mp4`);
  fs.writeFileSync(file, bytes);

  const cost = Number(process.env.LIBER_VIDEO_COST_USD) || 0.5;
  budget.recordSpend(cost, 'media');

  const out = {
    kind: 'video',
    provider: 'replicate',
    model: version,
    prompt: text,
    files: [{ path: file, bytes: bytes.length }],
    cost_usd: cost
  };

  // A thumbnail is the cheapest way to prove the file is a real video, and it is
  // what a chat surface needs. Only claimed when ffmpeg is actually present.
  const p = policy();
  if (p.ffmpeg) {
    try {
      const thumb = file.replace(/\.mp4$/, '-thumb.png');
      require('child_process').execFileSync(p.ffmpeg, ['-y', '-i', file, '-frames:v', '1', thumb],
        { stdio: 'ignore', timeout: 60000 });
      if (fs.existsSync(thumb)) out.files.push({ path: thumb, bytes: fs.statSync(thumb).size, kind: 'thumbnail' });
    } catch { out.thumbnail_error = 'ffmpeg could not extract a frame.'; }
  } else {
    out.note = 'No ffmpeg on this machine: no thumbnail was produced.';
  }

  return out;
}

module.exports = { imageGenerate, videoGenerate, policy, artifactsDir };
