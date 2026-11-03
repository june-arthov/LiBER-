// src/daemon/core/secrets.js — detect and redact credential-like text before
// anything durable (session, journal, traces) hits disk.
const PATTERNS = [
  { type: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'github_token', re: /\bgh[psuo]_[A-Za-z0-9]{30,}\b/g },
  { type: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { type: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'private_key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,400}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { type: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/g },
  { type: 'assigned_secret', re: /\b(?:password|passwd|secret|token|api_key|apikey)\s*[:=]\s*[^\s"',;{}]{8,}\b/gi }
];

function find(text) {
  const source = String(text || '');
  const hits = [];
  for (const { type, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      hits.push({ type, snippet: m[0].slice(0, 24) + '…' });
    }
  }
  return hits;
}

function redact(text) {
  let out = String(text || '');
  for (const { type, re } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, `[REDACTED:${type}]`);
  }
  return out;
}

module.exports = { find, redact, PATTERNS };
