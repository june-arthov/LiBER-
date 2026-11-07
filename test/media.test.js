// Media tools: a provider call becomes a file on disk, a receipt and a spend entry.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-media-'));
process.chdir(dir);
process.env.LIBER_BUDGET_FILE = path.join(dir, '.liber', 'budget.json');
process.env.OPENAI_API_KEY = 'test-key-not-real';

const media = require('../src/daemon/core/tools/media-tool');
const budget = require('../src/daemon/core/budget');

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function fakeImages() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const ok = req.url === '/v1/images/generations' && /Bearer test-key-not-real/.test(String(req.headers.authorization));
      if (!ok) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: 'bad route or key' } }));
      }
      const parsed = JSON.parse(body || '{}');
      if (!parsed.prompt) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'prompt missing' } }));
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64'), revised_prompt: parsed.prompt }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('an image call writes a real file and returns a citable path', async () => {
  const server = await fakeImages();
  const { port } = server.address();
  try {
    const before = budget.snapshot().cost_usd;
    const out = await media.imageGenerate({
      prompt: 'a red cube on a white table',
      endpoint: `http://127.0.0.1:${port}/v1`
    });

    assert.ok(!out.error, out.error);
    assert.strictEqual(out.kind, 'image');
    assert.strictEqual(out.files.length, 1);

    const file = out.files[0].path;
    assert.ok(fs.existsSync(file), 'the file is on disk at ' + file);
    assert.ok(file.startsWith(path.join(dir, 'artifacts', 'media')), 'inside the workspace');
    assert.strictEqual(fs.statSync(file).size, PNG.length);
    assert.ok(out.files[0].bytes > 0);

    assert.ok(out.cost_usd > 0, 'the call is not free');
    assert.ok(budget.snapshot().cost_usd > before, 'and the spend is recorded');
  } finally {
    server.close();
  }
});

test('without a key the tool says what is missing instead of failing oddly', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const out = await media.imageGenerate({ prompt: 'anything' });
    assert.match(String(out.error), /No image provider is configured/);
    assert.strictEqual(out.needs_provider, 'openai');
  } finally {
    process.env.OPENAI_API_KEY = saved;
  }
});

test('a per-call ceiling blocks the spend before the provider is called', async () => {
  process.env.LIBER_MEDIA_MAX_USD = '0.001';
  try {
    const out = await media.imageGenerate({ prompt: 'expensive' });
    assert.strictEqual(out.budget_blocked, true);
    assert.match(String(out.error), /per-call ceiling/);
  } finally {
    delete process.env.LIBER_MEDIA_MAX_USD;
  }
});

test('video reports the missing token and model rather than pretending', async () => {
  const saved = process.env.REPLICATE_API_TOKEN;
  delete process.env.REPLICATE_API_TOKEN;
  try {
    const noKey = await media.videoGenerate({ prompt: 'a wave' });
    assert.match(String(noKey.error), /No video provider is configured/);

    process.env.REPLICATE_API_TOKEN = 'r8_test';
    const noModel = await media.videoGenerate({ prompt: 'a wave' });
    assert.strictEqual(noModel.needs_model, true);
  } finally {
    if (saved === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = saved;
  }
});

test('policy() only reports capabilities that a key backs', () => {
  const p = media.policy();
  assert.strictEqual(p.images.configured, true);
  assert.strictEqual(p.images.provider, 'openai');
  assert.ok(p.ffmpeg === null || typeof p.ffmpeg === 'string', 'ffmpeg is a path or null, never a guess');
  assert.ok(Number(p.max_usd_per_call) > 0);
});
