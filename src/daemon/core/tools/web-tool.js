// src/daemon/core/tools/web-tool.js — Ground external claims in fetched text.
const MAX_CHARS_DEFAULT = 12000;

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchUrl({ url, maxChars = MAX_CHARS_DEFAULT } = {}) {
  if (!url || typeof url !== 'string') {
    return { error: 'Missing or invalid url argument.' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `Invalid URL: ${url}` };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { error: `Unsupported protocol '${parsed.protocol}'. Only http and https are allowed.` };
  }

  const cap = Math.min(Math.max(parseInt(maxChars, 10) || MAX_CHARS_DEFAULT, 500), 40000);
  const started = Date.now();

  try {
    const res = await fetch(parsed.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Liber/2.0 (grounding fetch)',
        'Accept': 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5'
      },
      signal: AbortSignal.timeout(20000)
    });

    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();
    const isHtml = /html|xml/i.test(contentType) || /^\s*</.test(raw.slice(0, 200));
    const text = isHtml ? htmlToText(raw) : raw.trim();
    const truncated = text.length > cap;

    return {
      url,
      final_url: res.url || parsed.toString(),
      status: res.status,
      ok: res.ok,
      content_type: contentType.split(';')[0] || 'unknown',
      chars: text.length,
      truncated,
      content: truncated ? text.slice(0, cap) + `\n... [TRUNCATED at ${cap} chars]` : text,
      duration_ms: Date.now() - started
    };
  } catch (err) {
    return {
      url,
      error: `Fetch failed: ${err.name === 'TimeoutError' ? 'timed out after 20s' : err.message}`,
      duration_ms: Date.now() - started
    };
  }
}

module.exports = { fetchUrl, htmlToText };
