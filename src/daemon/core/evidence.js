// src/daemon/core/evidence.js — Receipt ledger: every tool result becomes auditable evidence.
const crypto = require('crypto');
const path = require('path');

const KIND_BY_TOOL = {
  read_file: 'read',
  write_file: 'write',
  patch: 'patch',
  search_files: 'search',
  terminal: 'command',
  memory: 'memory',
  todo_list: 'todo',
  fetch_url: 'fetch',
  web_search: 'search',
  task: 'task',
  tasks: 'task'
};

// Verification-by-execution: a green test/build/lint run proves the tree is sound.
const EXEC_VERIFICATION = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)\b|\b(node\s+--test|jest|vitest|mocha|pytest|go\s+test|cargo\s+test|dotnet\s+test|tsc|eslint|ruff|mypy)\b/i;

function hashOf(value) {
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    return crypto.createHash('sha256').update(raw || '').digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

function normPath(p) {
  if (!p) return null;
  const raw = String(p).replace(/[\\/]+/g, path.sep);
  try {
    return path.resolve(process.cwd(), raw).replace(/\\/g, '/').toLowerCase();
  } catch {
    return raw.replace(/\\/g, '/').toLowerCase();
  }
}

function basenameOf(p) {
  const n = normPath(p);
  return n ? n.split('/').pop() : null;
}

class EvidenceLedger {
  constructor(agentId = 'agent') {
    this.agentId = agentId;
    this.entries = [];
    this.seq = 0;
    // path -> { path, evId, tool } : mutations awaiting read-back / execution proof
    this.pendingVerification = new Map();
  }

  nextId() {
    return `E${++this.seq}`;
  }

  classify(tool) {
    return KIND_BY_TOOL[tool] || 'other';
  }

  isOk(kind, result, meta) {
    if (!result || meta.denied) return false;
    if (typeof result === 'object' && result.error) return false;
    if (result.validation_failed) return false;
    if (kind === 'command') return result.exit_code === 0;
    if (kind === 'read') return !result.error && typeof result.content === 'string';
    if (kind === 'search') return !result.error;
    if (kind === 'write') return result.success === true;
    if (kind === 'patch') return result.success === true;
    if (kind === 'fetch') return typeof result.status === 'number' && result.status >= 200 && result.status < 400;
    return true;
  }

  targetOf(kind, args, result) {
    switch (kind) {
      case 'read':
      case 'write':
      case 'patch':
        return args.path || null;
      case 'command':
        return args.command || null;
      case 'search':
        return args.pattern || args.query || null;
      case 'fetch':
        return result.final_url || args.url || null;
      case 'memory':
        return args.key || args.action || null;
      default:
        return null;
    }
  }

  excerptOf(kind, result) {
    if (!result || typeof result !== 'object') return String(result || '').slice(0, 200);
    switch (kind) {
      case 'read':
        return `${result.lines_read ?? '?'} lines · total ${result.total_lines ?? '?'}`;
      case 'write':
        return `${result.bytes_written ?? 0} bytes written`;
      case 'patch':
        return `strategy=${result.strategy || '?'} · ${result.occurrences_replaced ?? 0} replaced`;
      case 'search':
        return `${result.total_found ?? result.total ?? 0} matches`;
      case 'command':
        return `exit ${result.exit_code} · ${String(result.output || result.error || '').replace(/\s+/g, ' ').slice(0, 160)}`;
      case 'fetch':
        return `HTTP ${result.status} · ${result.chars ?? 0} chars`;
      case 'memory':
        return `${result.message || (result.found === false ? 'not found' : 'ok')}`;
      default:
        return String(result.message || result.error || JSON.stringify(result)).slice(0, 160);
    }
  }

  /**
   * Verbatim evidence for the semantic auditor (bounded, head AND tail kept).
   * Head-only truncation was a root cause of false semantic failures: test
   * summaries ("pass 145") sit at the END of long command output.
   */
  detailOf(kind, result) {
    if (!result || typeof result !== 'object') return String(result || '').slice(0, 700);
    const headTail = (text, head, tail) => {
      const s = String(text || '');
      if (s.length <= head + tail + 24) return s;
      return `${s.slice(0, head)}\n… [${s.length - head - tail} chars omitted] …\n${s.slice(-tail)}`;
    };
    /**
     * A JSON API answer has to keep the fields the model will cite, and a raw
     * JSON.stringify puts them behind whatever the API ordered first. Flatten
     * every scalar leaf to `path=value` so "default_branch=main" is present no
     * matter where the object put it.
     */
    const flatten = (value, prefix = '', out = []) => {
      if (out.length > 400) return out;
      if (value === null || value === undefined) { out.push(`${prefix}=${value}`); return out; }
      if (Array.isArray(value)) {
        value.slice(0, 25).forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
        return out;
      }
      if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
        return out;
      }
      out.push(`${prefix}=${value}`);
      return out;
    };
    const asJson = (text) => {
      try { const parsed = JSON.parse(String(text)); return flatten(parsed).join('\n'); } catch { return null; }
    };
    switch (kind) {
      case 'read':
        return headTail(result.content || '', 1400, 1000);
      case 'command':
        return headTail(result.output || result.error || '', 1200, 1200);
      case 'write':
        return String(result.message || '').slice(0, 400);
      case 'patch':
        return headTail(result.diff_preview || result.message || '', 1000, 500);
      case 'search':
        return JSON.stringify((result.matches || result.results || []).slice(0, 5)).slice(0, 700);
      case 'fetch': {
        const flat = asJson(result.content);
        if (flat) return headTail(flat, 3000, 1500);
        return headTail(result.content || '', 1000, 600);
      }
      case 'memory':
        return JSON.stringify(result).slice(0, 400);
      default: {
        if (result.message || result.error) return headTail(result.message || result.error, 400, 200);
        const flat = flatten(result).join('\n');
        return headTail(flat, 3000, 1500);
      }
    }
  }

  record(tool, args = {}, result = {}, meta = {}) {
    const kind = this.classify(tool);
    const ok = this.isOk(kind, result, meta);
    const entry = {
      id: this.nextId(),
      tool,
      kind,
      ok,
      target: this.targetOf(kind, args, result),
      ts: Date.now(),
      exit_code: typeof (result && result.exit_code) === 'number' ? result.exit_code : null,
      hash: hashOf(result),
      excerpt: this.excerptOf(kind, result),
      detail: this.detailOf(kind, result),
      meta: { ...meta }
    };
    this.entries.push(entry);
    if (ok) this.trackVerification(entry, args);
    return entry;
  }

  trackVerification(entry, args) {
    const p = args.path ? normPath(args.path) : null;

    if (entry.kind === 'write' || entry.kind === 'patch') {
      if (p) this.pendingVerification.set(p, { path: args.path, evId: entry.id, tool: entry.tool });
      return;
    }

    if (entry.kind === 'read' && p) {
      this.pendingVerification.delete(p);
      return;
    }

    if (entry.kind === 'command') {
      const cmd = String(args.command || '');
      if (EXEC_VERIFICATION.test(cmd)) {
        this.pendingVerification.clear();
        return;
      }
      for (const [key, pending] of this.pendingVerification.entries()) {
        const base = basenameOf(pending.path);
        const normalizedCmd = cmd.replace(/\\/g, '/').toLowerCase();
        if ((base && normalizedCmd.includes(base.toLowerCase())) || normalizedCmd.includes(key)) {
          this.pendingVerification.delete(key);
        }
      }
    }
  }

  get(id) {
    const n = String(id).replace(/^E/i, '');
    return this.entries.find(e => e.id === `E${n}`) || null;
  }

  hasReceipt(id) {
    return !!this.get(id);
  }

  lastMutation() {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.ok && (e.kind === 'write' || e.kind === 'patch')) return e;
    }
    return null;
  }

  mutationCount() {
    return this.entries.filter(e => e.ok && (e.kind === 'write' || e.kind === 'patch')).length;
  }

  okEntries() {
    return this.entries.filter(e => e.ok);
  }

  unresolvedPending() {
    return Array.from(this.pendingVerification.values());
  }

  /**
   * Compact digest injected into the system prompt every iteration.
   */
  digest(maxEntries = 24) {
    const list = this.entries.slice(-maxEntries);
    if (list.length === 0) return '(empty — no tool receipts yet this turn)';
    return list
      .map(e => `${e.id} ${e.tool} ${e.ok ? 'ok' : 'FAILED'}${e.exit_code !== null ? `(exit ${e.exit_code})` : ''} — ${String(e.target || '').slice(0, 90)} — ${e.excerpt}`)
      .join('\n');
  }

  toJSON() {
    return {
      agentId: this.agentId,
      receipts: this.entries.map(e => ({
        id: e.id,
        tool: e.tool,
        kind: e.kind,
        ok: e.ok,
        target: e.target,
        exit_code: e.exit_code,
        hash: e.hash,
        excerpt: e.excerpt,
        detail: e.detail
      })),
      pending_verification: this.unresolvedPending()
    };
  }

  static fromJSON(data = {}) {
    const ledger = new EvidenceLedger(data.agentId || 'agent');
    ledger.entries = Array.isArray(data.receipts) ? data.receipts.map(e => ({ ...e, meta: e.meta || {} })) : [];
    ledger.seq = ledger.entries.reduce(
      (max, e) => Math.max(max, parseInt(String(e.id).replace(/^E/i, ''), 10) || 0),
      0
    );
    ledger.pendingVerification = new Map(
      (Array.isArray(data.pending_verification) ? data.pending_verification : [])
        .filter(p => p && p.path)
        .map(p => [normPath(p.path), p])
    );
    return ledger;
  }
}

module.exports = {
  EvidenceLedger,
  hashOf,
  normPath
};
