// src/daemon/core/grounding.js — The grounding gate.
// Every factual claim in a final answer must bind to a real tool receipt from this turn.
// Unsupported claims are blocked, repaired, and — failing repair — explicitly labelled UNVERIFIED.
// This module never fabricates support and never silently drops a claim.

const CITE_RE = /\[E(\d+)\]/gi;

const HEDGE_RE = /\b(unverified|not verified|haven'?t verified|have not verified|assumed?|assumption|asumsi|probably|presumably|i think|i believe|might|may be|possibly|likely|kemungkinan|belum (?:saya )?(?:cek|verifikasi)|belum diverifikasi|prior turn|previous turn|earlier turn|last turn|may (?:now )?be stale|might be stale|as of (?:the )?last|outdated)\b/i;
const USER_ATTRIB_RE = /\b(you (said|mentioned|told|wrote|reported|indicated|asked)|according to (you|your (message|request))|katamu|menurutmu|sesuai permintaanmu)\b/i;
const IMPERATIVE_RE = /^(?:[-*•]\s*)?(open|read|run|use|try|add|create|edit|change|set|install|put|replace|check|call|import|update|delete|remove|move|copy|write|verify|test|build|deploy|restart|start|stop|send|paste|choose|pick|make|ensure|avoid|prefer|consider|see|refer|look|follow|apply|configure|enable|disable|lihat|buka|jalankan|coba|tambahkan|buat|ubah|hapus|pastikan|gunakan)\b/i;

const FILE_EXT = 'js|mjs|cjs|ts|tsx|jsx|json|jsonc|ya?ml|md|markdown|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|bat|cmd|txt|log|env|ini|toml|xml|html?|css|scss|sass|sql|db|sqlite|lock|cfg|conf|vue|svelte|astro';
const PATH_GLOBAL = new RegExp(`(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/])?[\\w@.\\-]+(?:[\\\\/][\\w@.\\-]+)*\\.(?:${FILE_EXT})\\b`, 'gi');
const MANIFESTS = new Set(['package.json', 'package-lock.json', 'liber.yaml', 'readme.md', 'tsconfig.json', 'dockerfile', '.env', 'requirements.txt', 'pyproject.toml', 'cargo.toml', 'go.mod']);
const KNOWN_PRODUCTS = /\b(node\.js|nodejs|react\.js|vue\.js|angular\.js|next\.js|nuxt\.js|express\.js|three\.js|d3\.js|chart\.js|p5\.js|socket\.io|ember\.js|backbone\.js|jquery\.js|nest\.js|deno\.js)\b/i;

const PREDICATE_RE = /\b(is|are|was|were|has|have|contains?|uses?|exists?|missing|located|declares?|defines?|exports?|imports?|returns?|fails?|passes?|shows?|outputs?|reads?|writes?|created?|deleted?|updated?|edited?|empty|present|absent|installed|running)\b/i;

const PAST_ACTION_RE = /\b(?:I|we)\s+(?:(?:have|had|just|already|successfully|now|also|then)\s+)*(created|wrote|written|updated|edited|patched|fixed|installed|deleted|removed|renamed|moved|ran|executed|tested|checked|verified|confirmed|read|opened|searched|found|inspected|scanned|fetched|downloaded|built|compiled|started|stopped|killed|added|modified|changed|applied|saved)\b/i;

const VERB_KINDS = {
  created: ['write', 'patch'], wrote: ['write', 'patch'], written: ['write', 'patch'],
  updated: ['write', 'patch'], edited: ['write', 'patch'], patched: ['patch', 'write'],
  added: ['write', 'patch'], modified: ['write', 'patch'], changed: ['write', 'patch'],
  applied: ['write', 'patch', 'command'], saved: ['write', 'patch'],
  installed: ['command'], downloaded: ['command', 'fetch'], built: ['command'],
  compiled: ['command'], ran: ['command'], executed: ['command'], tested: ['command'],
  started: ['command'], stopped: ['command'], killed: ['command'],
  deleted: ['command', 'patch', 'write'], removed: ['command', 'patch', 'write'],
  renamed: ['command', 'patch', 'write'], moved: ['command', 'patch', 'write'],
  checked: ['read', 'search', 'command', 'fetch'], verified: ['read', 'search', 'command', 'fetch'],
  confirmed: ['read', 'search', 'command', 'fetch'],
  read: ['read', 'search', 'fetch'], opened: ['read', 'search', 'fetch'],
  searched: ['search', 'read'], found: ['search', 'read', 'command'],
  inspected: ['read', 'search'], scanned: ['search', 'read'],
  fetched: ['fetch', 'command']
};

const PASSIVE_SUCCESS_RE = /\b(the|this|that|your)\s+(bug|issue|error|problem|crash|build|test|tests|suite|project|file|script|app|code|implementation|change|fix)\s+(is|are|was|were)\s+(now\s+)?(fixed|resolved|working|passing|green|updated|created|complete|done|clean|installed)\b/i;
const SHORT_SUCCESS_RE = /\b(fixed|resolved|done|completed|finished|succeeded|success|all good|no errors|tests? pass(ed)?|build (passed|succeeded|succeeds)|it works|that works|this works)\b/i;
const TEST_WORD_RE = /\b(test|tests|suite|build|lint|check|checks|ci)\b/i;
const EXEC_TEST_RE = /\b(test|build|lint|check|tsc|jest|vitest|pytest|go test|cargo test|npm run)\b/i;

const VERSION_CLAIM_RE = /\b(current|latest|installed|running|newest)\s+(version|release|build)\b|\bversion\s+(is|of|number)\b|\b(current date|today'?s date|current time)\b/i;

function stripCode(text) {
  // Only fenced blocks are code samples. Inline code inside prose is still a claim
  // ("the version is `9.9.9`") and must be audited.
  return String(text).replace(/```[\s\S]*?```/g, ' ');
}

function splitSentences(line) {
  return String(line)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'`(\[])/)
    .map(s => s.trim())
    .filter(Boolean);
}

function normalizeSlashes(s) {
  return String(s).replace(/\\/g, '/');
}

function isLocalPath(token, ledger, sentence) {
  if (/^[A-Za-z]:[\\/]/.test(token) || /^\.{1,2}[\\/]/.test(token) || token.includes('/') || token.includes('\\')) return true;
  if (KNOWN_PRODUCTS.test(token)) return false;
  if (MANIFESTS.has(token.toLowerCase())) return true;
  if (/\b(your|our|the|this|that|my)\s+(project|repo|repository|codebase|folder|directory|file|config|script|module|package|app)\b|\bhere\b|\bworking directory\b|\bcwd\b|\bin this (dir|folder|repo|project)\b|\blocal\b/i.test(sentence)) return true;
  const base = token.toLowerCase();
  return (ledger?.entries || []).some(e => e.target && String(e.target).toLowerCase().includes(base));
}

function isHedged(sentence) {
  return HEDGE_RE.test(sentence) || USER_ATTRIB_RE.test(sentence);
}

function isImperative(sentence) {
  return IMPERATIVE_RE.test(sentence.trim());
}

function citationsIn(sentence) {
  const out = [];
  for (const m of sentence.matchAll(CITE_RE)) out.push(`E${m[1]}`);
  return out;
}

function envClaim(sentence, ledger) {
  const paths = [...sentence.matchAll(PATH_GLOBAL)]
    .map(m => m[0])
    .filter(p => isLocalPath(p, ledger, sentence));
  if (paths.length && PREDICATE_RE.test(sentence)) {
    return { type: 'path', target: paths[0] };
  }
  if (/\b(your|this|the|my)\s+(system|machine|computer|environment|shell|terminal|operating system|os|working directory|cwd)\b/i.test(sentence) &&
      /\b(is|are|runs?|has|have|uses?)\b/i.test(sentence)) {
    return { type: 'system', target: 'system' };
  }
  if (VERSION_CLAIM_RE.test(sentence) && /\d/.test(sentence)) {
    return { type: 'version', target: 'version' };
  }
  return null;
}

function actionClaim(sentence) {
  const m = sentence.match(PAST_ACTION_RE);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  return { verb, kinds: VERB_KINDS[verb] || ['read', 'search', 'command', 'write', 'patch', 'fetch'] };
}

function successClaim(sentence, ledger) {
  if (PASSIVE_SUCCESS_RE.test(sentence)) return { passive: true };
  if (SHORT_SUCCESS_RE.test(sentence)) {
    if (/\b(I|we|it|that|this|all|everything|now)\b/i.test(sentence) || ledger.entries.length === 0) return { passive: false };
  }
  return null;
}

function indexOfLastMutation(ledger) {
  for (let i = ledger.entries.length - 1; i >= 0; i--) {
    const e = ledger.entries[i];
    if (e.ok && (e.kind === 'write' || e.kind === 'patch')) return i;
  }
  return -1;
}

function successSupport(sentence, ledger) {
  if (ledger.unresolvedPending().length > 0) return 'pending';
  if (ledger.entries.length === 0) return 'none';

  if (TEST_WORD_RE.test(sentence)) {
    const ok = ledger.entries.some(e => e.ok && e.kind === 'command' && EXEC_TEST_RE.test(String(e.target || '')));
    return ok ? 'ok' : 'none';
  }

  const lastMutation = indexOfLastMutation(ledger);
  if (lastMutation >= 0) {
    const after = ledger.entries.slice(lastMutation + 1).some(e => e.ok && (e.kind === 'read' || e.kind === 'command'));
    return after ? 'ok' : 'none';
  }

  return ledger.okEntries().length > 0 ? 'ok' : 'none';
}

/**
 * Deterministic receipt checks — no model involved.
 * A cited receipt must actually mention the path and contain the numbers claimed.
 */
function pathMatchesEntry(entry, token) {
  const base = String(token).split(/[\\/]/).pop().toLowerCase();
  const needle = String(token).toLowerCase();
  const hay = `${entry.target || ''} ${entry.detail || ''}`.toLowerCase();
  return hay.includes(base) || hay.includes(needle);
}

/**
 * Compare numbers the way a reader would: separators inside a number are
 * formatting, not information. A receipt holding "(6, 182, 212)" must support a
 * claim written "6,182,212" — a real turn was flagged for exactly that.
 * Only separators *inside* a numeric token are removed, so "12 files, 34 dirs"
 * does not become the number 1234.
 */
function normaliseNumbers(text) {
  return String(text || '').replace(/\d[\d.,\s\u00a0]*\d|\d/g, m => m.replace(/[,\s\u00a0]/g, ''));
}

function numberSupported(needle, hay) {
  if (String(hay).includes(String(needle))) return true;
  const n = normaliseNumbers(needle);
  if (n.length < 2) return false;
  return normaliseNumbers(hay).includes(n);
}

function deterministicCheck(sentence, cites, ledger) {
  const violations = [];
  const stripped = String(sentence).replace(/\[E\d+\]/gi, ' ');
  const paths = [...stripped.matchAll(PATH_GLOBAL)].map(m => m[0]);
  const numbers = [...stripped.matchAll(/\b\d[\d.,]*\b/g)].map(m => m[0]);
  const entries = cites.map(id => ledger.get(id)).filter(Boolean);
  if (!entries.length) return violations;

  if (paths.length) {
    const pathKinds = new Set(['read', 'write', 'patch', 'search', 'command', 'fetch']);
    const checkable = entries.filter(e => pathKinds.has(e.kind));
    const supported = checkable.length > 0 && paths.some(p => checkable.some(e => pathMatchesEntry(e, p)));
    if (!supported && checkable.length > 0) {
      violations.push({
        code: 'PATH_UNSUPPORTED',
        text: sentence,
        hint: `The cited receipt does not mention '${paths[0]}'. Cite the receipt that actually read it, or mark the claim UNVERIFIED.`
      });
    }
  }

  if (numbers.length) {
    // Aggregated receipts (search/todo/task) cannot contain arbitrary numbers — skip them.
    const checkable = entries.filter(e => !['search', 'todo', 'task'].includes(e.kind));
    if (checkable.length) {
      const found = numbers.some(n =>
        checkable.some(e => numberSupported(n, `${e.detail || ''} ${e.excerpt || ''} ${e.target || ''}`))
      );
      if (!found) {
        violations.push({
          code: 'NUMBER_UNSUPPORTED',
          text: sentence,
          hint: `The cited receipt does not contain the number '${numbers[0]}'. Re-check the receipt, verify it with a tool, or mark the claim UNVERIFIED.`
        });
      }
    }
  }

  // Quoted strings must be visible in the cited receipt's evidence.
  const quoted = [...stripped.matchAll(/[`'"]{1}([^`'"]{4,80})[`'"]{1}/g)].map(m => m[1]);
  if (quoted.length) {
    const checkable = entries.filter(e => !['search', 'todo', 'task'].includes(e.kind));
    if (checkable.length) {
      const found = quoted.some(q =>
        checkable.some(e => `${e.detail || ''} ${e.excerpt || ''} ${e.target || ''}`.includes(q))
      );
      if (!found) {
        violations.push({
          code: 'STRING_UNSUPPORTED',
          text: sentence,
          hint: `The cited receipt does not contain '${quoted[0]}'. Verify it with a tool or mark the claim UNVERIFIED.`
        });
      }
    }
  }

  // Line-number claims must match the receipt's rendered line prefixes.
  const lineMatch = stripped.match(/\bline\s+(\d{1,6})\b/i);
  if (lineMatch) {
    const readEntries = entries.filter(e => e.kind === 'read');
    if (readEntries.length) {
      const lineNo = String(parseInt(lineMatch[1], 10));
      const prefixPadded = lineNo.padStart(4, '0') + ' |';
      const prefixLoose = new RegExp(`\\b${lineNo}\\s*\\|`);
      const found = readEntries.some(e => {
        const detail = String(e.detail || '');
        return detail.includes(prefixPadded) || prefixLoose.test(detail);
      });
      if (!found) {
        violations.push({
          code: 'LINE_UNSUPPORTED',
          text: sentence,
          hint: `The cited receipt does not show line ${lineNo}. Read the right region or mark the claim UNVERIFIED.`
        });
      }
    }
  }

  return violations;
}

const FIX_HINTS = {
  UNCITED_CLAIM: 'Cite the receipt that proves it (`[E#]`), or rewrite the sentence as `UNVERIFIED: ...`. If no receipt exists, call the tool that produces one.',
  CITATION_UNKNOWN: 'That receipt ID does not exist. Use only IDs listed in the Evidence Ledger.',
  PHANTOM_ACTION: 'No receipt matches this action. Perform it with a tool and cite the result, or remove the claim.',
  UNVERIFIED_SUCCESS: 'Run the verification (read_file read-back, or a test/build run) and cite it, or state plainly that the work is unverified.',
  SEMANTIC_UNSUPPORTED: 'The cited receipt does not entail this claim. Verify it with a tool, remove it, or mark it UNVERIFIED.',
  PATH_UNSUPPORTED: 'The cited receipt does not mention that file. Cite the receipt that actually read it, or mark the claim UNVERIFIED.',
  NUMBER_UNSUPPORTED: 'The cited receipt does not contain that number. Re-check the receipt, verify with a tool, or mark the claim UNVERIFIED.',
  STRING_UNSUPPORTED: 'The cited receipt does not contain that quoted string. Verify it with a tool or mark the claim UNVERIFIED.',
  LINE_UNSUPPORTED: 'The cited receipt does not show that line. Read the right region or mark the claim UNVERIFIED.',
  PENDING_MUTATION_UNVERIFIED: 'A file was changed but never read back. Call read_file on each changed path (or run the test suite), then cite the receipt.',
  UNGROUNDED_FACT: 'Verify with terminal (`date`, `<tool> --version`) or fetch_url of the primary source, then cite it.'
};

function audit(text, ledger, opts = {}) {
  const requireReadback = opts.requireReadback !== false;
  const requireCitations = opts.requireCitations !== false;
  const violations = [];
  const seen = new Set();
  let claimsChecked = 0;

  const add = (code, sentence, hint, line) => {
    const key = code + '|' + normalizeSlashes(sentence).slice(0, 140);
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({
      code,
      text: String(sentence).replace(/\s+/g, ' ').trim().slice(0, 400),
      line,
      hint: hint || FIX_HINTS[code] || 'Back the claim with a receipt.'
    });
  };

  const clean = stripCode(text);
  const lines = clean.split(/\r?\n/);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim()) continue;

    for (const sentence of splitSentences(line)) {
      const cites = citationsIn(sentence);
      for (const c of cites) {
        if (!ledger.hasReceipt(c)) add('CITATION_UNKNOWN', sentence, FIX_HINTS.CITATION_UNKNOWN, li + 1);
      }

      if (isHedged(sentence) || /\?\s*$/.test(sentence) || isImperative(sentence)) continue;

      // Deterministic receipt checks run for ANY cited sentence, even ones that
      // carry no env/action/success claim (e.g. "file.txt line 99 says ...").
      if (cites.length) {
        for (const v of deterministicCheck(sentence, cites, ledger)) {
          add(v.code, sentence, v.hint, li + 1);
        }
      }

      const env = envClaim(sentence, ledger);
      const action = actionClaim(sentence);
      const success = successClaim(sentence, ledger);

      if (!env && !action && !success) continue;
      claimsChecked++;

      if (action) {
        const supported = ledger.entries.some(e => e.ok && action.kinds.includes(e.kind));
        if (!supported) {
          add('PHANTOM_ACTION', sentence, FIX_HINTS.PHANTOM_ACTION, li + 1);
          continue;
        }
      }

      if (success) {
        const support = successSupport(sentence, ledger);
        if (support === 'pending') {
          add('PENDING_MUTATION_UNVERIFIED', sentence, FIX_HINTS.PENDING_MUTATION_UNVERIFIED, li + 1);
        } else if (support === 'none') {
          add('UNVERIFIED_SUCCESS', sentence, FIX_HINTS.UNVERIFIED_SUCCESS, li + 1);
        }
      }

      if (env && env.type === 'version') {
        const supported = ledger.entries.some(e => e.ok && (e.kind === 'command' || e.kind === 'fetch' || e.tool === 'web_search'));
        if (!supported) {
          add('UNGROUNDED_FACT', sentence, FIX_HINTS.UNGROUNDED_FACT, li + 1);
        }
      }

      if (requireCitations && cites.length === 0) {
        add('UNCITED_CLAIM', sentence, FIX_HINTS.UNCITED_CLAIM, li + 1);
      }
    }
  }

  if (requireReadback) {
    for (const pending of ledger.unresolvedPending()) {
      add(
        'PENDING_MUTATION_UNVERIFIED',
        `Changed '${pending.path}' (${pending.evId}) without read-back.`,
        FIX_HINTS.PENDING_MUTATION_UNVERIFIED,
        null
      );
    }
  }

  return {
    passed: violations.length === 0,
    status: violations.length === 0 ? 'PASS' : 'REPAIR',
    violations,
    claims_checked: claimsChecked,
    receipts: ledger.entries.length,
    citations: [...clean.matchAll(CITE_RE)].map(m => `E${m[1]}`)
  };
}

function describeViolations(result, limit = 6) {
  return result.violations.slice(0, limit).map((v, i) => {
    const where = v.line ? ` (line ${v.line})` : '';
    return `${i + 1}. [${v.code}]${where} "${v.text}"\n   Fix: ${v.hint}`;
  }).join('\n');
}

function buildRepairMessage(result, ledger, attempt = 1, maxRepairs = 2) {
  return [
    'GROUNDING AUDIT FAILED — the draft answer was blocked because it asserts things the Evidence Ledger cannot prove.',
    describeViolations(result),
    '',
    `Evidence Ledger so far: ${ledger.entries.length ? ledger.entries.map(e => e.id).join(', ') : 'none'}.`,
    `Repair round ${attempt} of ${maxRepairs}.`,
    'Respond with the tool call(s) that produce the missing receipts, then a corrected [FINAL:] answer.',
    'Any claim you cannot verify must be written exactly as `UNVERIFIED: <claim> — no tool receipt.` Never repeat an uncited claim.'
  ].join('\n');
}

function annotate(text, result, ledger) {
  const lines = ['', '⚠ GROUNDING AUDIT — the marked claims below are NOT verified by any tool receipt. Do not treat them as fact:'];
  for (const v of result.violations.slice(0, 8)) {
    lines.push(`  • [${v.code}] ${v.text} — ${v.hint}`);
  }
  lines.push(`  Receipts this turn: ${ledger.entries.length ? ledger.entries.map(e => e.id).join(', ') : 'none'}.`);
  return `${String(text).trimEnd()}\n${lines.join('\n')}`;
}

/**
 * Spans the answer itself already discloses as UNVERIFIED. The semantic
 * verifier must never re-flag these: the syntactic gate already accepts the
 * disclosure as honest, and re-punishing it creates an unresolvable repair loop.
 */
function disclosedSpans(text) {
  const spans = [];
  const re = /\bUNVERIFIED\s*:\s*(.*?)(?=\n|\.\s+[A-Z`*•\[]|\.?$)/gs;
  let m;
  while ((m = re.exec(text))) {
    const span = m[0].replace(/\s+$/g, '').replace(/[.\s]+$/g, '');
    if (span.length >= 10) spans.push(span);
  }
  return spans;
}

module.exports = {
  audit,
  annotate,
  disclosedSpans,
  describeViolations,
  buildRepairMessage,
  stripCode,
  splitSentences
};
