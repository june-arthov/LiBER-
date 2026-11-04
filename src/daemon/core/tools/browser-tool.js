// src/daemon/core/tools/browser-tool.js — drive a real Chromium over CDP.
// No new dependency: Node ships a WebSocket client, and Chrome ships a debugger.
// The daemon launches a headless browser on demand and closes it when idle, so a
// browser reach does not mean a browser running all day.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const injection = require('../injection');

const CHROME_CANDIDATES = [
  process.env.LIBER_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);

const IDLE_MS = 5 * 60 * 1000;

let state = null; // { proc, port, ws, seq, pending, idleTimer }

function chromePath() {
  for (const c of CHROME_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return null;
}

/** Refuse schemes that can read the machine instead of the web. */
function checkUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return { ok: false, error: `Not a URL: ${raw}` }; }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, error: `Refusing ${url.protocol} — the browser tool only opens http(s). Use read_file for local files.` };
  }
  return { ok: true, url: url.toString() };
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, { timeout: 5000 }, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function launch() {
  if (state) return state;
  const exe = chromePath();
  if (!exe) throw new Error('No Chrome or Edge found. Set LIBER_CHROME to a browser binary.');

  const port = 9400 + Math.floor(Math.random() * 200);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liber-browser-'));
  const proc = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    'about:blank'
  ], { detached: false, stdio: 'ignore', windowsHide: true });

  const deadline = Date.now() + 15000;
  let version = null;
  while (Date.now() < deadline) {
    try { version = await httpJson(`http://127.0.0.1:${port}/json/version`); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!version) { try { proc.kill(); } catch { } throw new Error('The browser did not expose a debugging port.'); }

  const target = (await httpJson(`http://127.0.0.1:${port}/json/list`)).find(t => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  state = { proc, port, ws, userDir, seq: 0, pending: new Map(), idleTimer: null };
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
    if (msg.id && state?.pending.has(msg.id)) {
      const { resolve, reject } = state.pending.get(msg.id);
      state.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  return state;
}

function cdp(method, params = {}) {
  if (!state?.ws) return Promise.reject(new Error('Browser not launched.'));
  const id = ++state.seq;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    state.ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (state?.pending.has(id)) { state.pending.delete(id); reject(new Error(`${method} timed out`)); }
    }, 20000);
  });
}

function touch() {
  if (!state) return;
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => { close().catch(() => { }); }, IDLE_MS);
  if (state.idleTimer.unref) state.idleTimer.unref();
}

async function close() {
  if (!state) return { ok: true, closed: false };
  const { ws, proc, userDir } = state;
  state = null;
  try { ws.close(); } catch { }
  try { proc.kill(); } catch { }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { }
  return { ok: true, closed: true };
}

async function evalJs(expression, { awaitPromise = true } = {}) {
  const res = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'evaluation failed');
  return res.result?.value;
}

async function navigate(url) {
  const checked = checkUrl(url);
  if (!checked.ok) return { error: checked.error };
  await launch();
  touch();
  await cdp('Page.navigate', { url: checked.url });
  // wait for the document to settle or for the load event
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ready = await evalJs('document.readyState').catch(() => null);
    if (ready === 'complete') break;
    await new Promise(r => setTimeout(r, 250));
  }
  const title = await evalJs('document.title').catch(() => '');
  const finalUrl = await evalJs('location.href').catch(() => checked.url);
  return { url: finalUrl, title: String(title || ''), text: await bodyText(6000) };
}

async function bodyText(limit = 8000) {
  const text = await evalJs(`(() => {
    const el = document.body;
    if (!el) return '';
    const t = el.innerText || '';
    return t.replace(/\\n{3,}/g, '\\n\\n').trim();
  })()`).catch(() => '');
  return String(text || '').slice(0, limit);
}

function selectorFor(target) {
  const t = String(target || '').trim();
  if (!t) return null;
  // A CSS selector or a quoted/plain text match; text is the common case.
  if (/^[#.\[a-zA-Z]/.test(t) && (/[>#\[\]:]/.test(t) || /^[a-z]+[a-z0-9-]*$/i.test(t) || /^[#.].*/.test(t))) {
    const safe = t.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return { kind: 'css', value: safe };
  }
  return { kind: 'text', value: t.replace(/\\/g, '\\\\').replace(/'/g, "\\'") };
}

async function click(target) {
  await launch(); touch();
  const sel = selectorFor(target);
  if (!sel) return { error: 'Missing selector or text to click.' };
  const clicked = await evalJs(`(() => {
    const sel = '${sel.value}';
    let el = null;
    if ('${sel.kind}' === 'css') { try { el = document.querySelector(sel); } catch { el = null; } }
    if (!el) {
      const all = [...document.querySelectorAll('a,button,input,label,li,div,span')];
      el = all.find(n => (n.innerText || n.value || '').trim().toLowerCase() === sel.trim().toLowerCase());
      if (!el) el = all.find(n => (n.innerText || n.value || '').trim().toLowerCase().includes(sel.trim().toLowerCase()) && sel.trim().length > 2);
    }
    if (!el) return { ok: false };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 80) };
  })()`);
  if (!clicked || !clicked.ok) return { error: `Nothing matched '${target}'.` };
  await new Promise(r => setTimeout(r, 400));
  return { clicked: clicked.text || clicked.tag, url: await evalJs('location.href').catch(() => ''), text: await bodyText(3000) };
}

async function typeInto({ selector, text }) {
  await launch(); touch();
  if (!selector) return { error: 'Missing selector for type.' };
  const sel = selectorFor(selector);
  const focused = await evalJs(`(() => {
    const el = document.querySelector('${sel.value}');
    if (!el) return false;
    el.focus();
    if ('value' in el) { el.value = ''; }
    return true;
  })()`);
  if (!focused) return { error: `No element matched '${selector}'.` };
  await cdp('Input.insertText', { text: String(text ?? '') });
  return { typed: String(text ?? '').length, value: await evalJs(`document.querySelector('${sel.value}')?.value ?? null`) };
}

async function pressKey(key) {
  await launch(); touch();
  const map = { enter: ['Enter', 13], tab: ['Tab', 9], escape: ['Escape', 27], arrowdown: ['ArrowDown', 40], arrowup: ['ArrowUp', 38] };
  const k = map[String(key || '').toLowerCase()];
  if (!k) return { error: `Unsupported key '${key}'. Use enter, tab, escape, arrowup, arrowdown.` };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k[0], windowsVirtualKeyCode: k[1] });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k[0], windowsVirtualKeyCode: k[1] });
  await new Promise(r => setTimeout(r, 200));
  return { pressed: k[0], url: await evalJs('location.href').catch(() => '') };
}

async function extract({ selector = null, limit = 4000 } = {}) {
  await launch(); touch();
  if (!selector) return { text: await bodyText(limit) };
  const sel = selectorFor(selector);
  const out = await evalJs(`(() => {
    let el = null;
    if ('${sel.kind}' === 'css') { try { el = document.querySelector('${sel.value}'); } catch { el = null; } }
    if (!el) el = [...document.querySelectorAll('*')].find(n => (n.innerText || '').trim().toLowerCase().includes('${sel.value}'.toLowerCase()) && '${sel.value}'.length > 2);
    return el ? (el.innerText || '').slice(0, ${Number(limit) || 4000}) : null;
  })()`);
  return out === null ? { error: `Nothing matched '${selector}'.` } : { text: out };
}

async function screenshot({ path: outPath = null } = {}) {
  await launch(); touch();
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  const target = outPath || path.join(process.cwd(), `.liber/browser-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(data, 'base64'));
  return { path: target, bytes: fs.statSync(target).size };
}

/** One tool surface for the agent; every action returns plain data. */
async function runBrowser(args = {}) {
  const action = String(args.action || '').toLowerCase();
  try {
    if (action === 'open' || action === 'goto' || action === 'navigate') return await navigate(args.url);
    if (action === 'click') return await click(args.selector || args.text);
    if (action === 'type') return await typeInto(args);
    if (action === 'press') return await pressKey(args.key);
    if (action === 'extract' || action === 'read') return await extract(args);
    if (action === 'screenshot') return await screenshot(args);
    if (action === 'eval') {
      await launch(); touch();
      const value = await evalJs(String(args.expression || ''));
      return { value };
    }
    if (action === 'close') return await close();
    if (action === 'status') {
      return state
        ? { running: true, url: await evalJs('location.href').catch(() => '') }
        : { running: false, hint: 'The browser starts on the first open and closes after 5 minutes idle.' };
    }
    return { error: `Unknown browser action '${action}'. Use open, click, type, press, extract, screenshot, eval, status, close.` };
  } catch (err) {
    return { error: `browser ${action || '(none)'} failed: ${err.message}` };
  }
}

/** Results are web data: mark them so the agent treats them as untrusted. */
function decorate(result) {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return injection.scan(text) ? `${result.text || ''}\n\n${injection.WARNING}` : result;
}

module.exports = { runBrowser, checkUrl, selectorFor, close, decorate, _state: () => state };
