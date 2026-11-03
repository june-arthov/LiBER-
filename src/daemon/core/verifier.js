// src/daemon/core/verifier.js — second-pass semantic audit.
// The syntactic gate checks that a claim cites a real receipt. This pass asks whether
// the receipt actually entails the claim. Fail-open on transport/parse errors: an
// auditor outage must not block delivery, but it is recorded as 'error'.
const SYSTEM_PROMPT = `You are an evidence auditor. You receive an ANSWER and a list of RECEIPTS produced by tools during the same turn.

Your only task: list the claims in ANSWER that are NOT entailed by the receipts.

Rules:
- A claim is supported only if the receipt's target and detail actually show it.
- Numbers, versions, dates, file contents, paths, command results, test results, and "I did X" statements MUST be entailed by a receipt.
- General, time-stable knowledge (language semantics, algorithms, standard APIs) is acceptable without a receipt.
- A citation to an existing receipt does not by itself make a claim supported.
- Plans, questions, and offers are not claims.

Return ONLY valid JSON, no markdown:
{"unsupported":[{"claim":"<short quote>","reason":"<why the receipts do not support it>","receipt":"<E# or null>"}]}
If everything is supported return {"unsupported":[]}.`;

function buildReceipts(ledger, maxChars = 14000) {
  const rows = ledger.entries.map(e => {
    const body = e.detail || e.excerpt || '';
    return `${e.id} [${e.tool}] ${e.ok ? 'OK' : 'FAILED'} target=${e.target || '—'}\n${body}`;
  });
  return rows.join('\n---\n').slice(0, maxChars);
}

function parseVerdict(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { unsupported: [], parse_error: true };

  try {
    const data = JSON.parse(text.slice(start, end + 1));
    const list = Array.isArray(data.unsupported) ? data.unsupported : [];
    return {
      unsupported: list
        .filter(item => item && item.claim)
        .map(item => ({
          claim: String(item.claim).slice(0, 400),
          reason: String(item.reason || '').slice(0, 400),
          receipt: item.receipt ? String(item.receipt).slice(0, 16) : null
        })),
      parse_error: false
    };
  } catch {
    return { unsupported: [], parse_error: true };
  }
}

async function verify({ candidate, ledger, llmManager }) {
  if (!candidate || !ledger || ledger.entries.length === 0) {
    return { unsupported: [], parse_error: false, skipped: true };
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `ANSWER:\n${String(candidate).slice(0, 6000)}\n\nRECEIPTS:\n${buildReceipts(ledger)}` }
  ];

  let lastRaw = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    lastRaw = await llmManager.generate(messages, { temperature: 0, max_tokens: 900 });
    const parsed = parseVerdict(lastRaw);
    if (!parsed.parse_error) return parsed;

    if (attempt === 1) {
      messages.push({ role: 'assistant', content: String(lastRaw).slice(0, 800) });
      messages.push({ role: 'user', content: 'That was not valid JSON. Return ONLY the JSON object, no prose: {"unsupported":[...]}' });
    }
  }

  return { unsupported: [], parse_error: true, raw_preview: String(lastRaw).slice(0, 300) };
}

module.exports = { verify, parseVerdict, buildReceipts, SYSTEM_PROMPT };
