// src/daemon/core/trace.js — append-only audit trail of completed turns.
const fs = require('fs');
const path = require('path');
const secrets = require('./secrets');

function traceDir() {
  return path.resolve(process.cwd(), '.liber', 'traces');
}

function appendTurn({ agentId, userMessage, result, model }) {
  try {
    const dir = traceDir();
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `${day}.jsonl`);

    const grounding = result?.grounding || {};
    const receipts = (grounding.ledger?.receipts || []).map(r => `${r.id}:${r.tool}${r.ok ? '' : '!'}`);
    const record = {
      ts: new Date().toISOString(),
      agentId,
      model: model || null,
      user: secrets.redact(String(userMessage || '')).slice(0, 500),
      response: secrets.redact(String(result?.response || '')).slice(0, 4000),
      grounded: result?.grounded ?? null,
      grounding_status: grounding.status || null,
      repairs: result?.repairs ?? 0,
      iterations: result?.iterations ?? 0,
      duration_ms: result?.durationMs ?? null,
      usage: result?.usage || null,
      receipts
    };
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return file;
  } catch {
    return null;
  }
}

module.exports = { appendTurn, traceDir };
