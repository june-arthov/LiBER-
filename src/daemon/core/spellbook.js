// src/daemon/core/spellbook.js — Doctrine loader (the Merlin method, selectable per intent)
const fs = require('fs');
const path = require('path');

const SPELLBOOK_DIR = path.join(__dirname, '..', 'spellbook');

// `always` modules are injected every turn; the rest are selected by intent.
const MODULES = [
  { id: 'iron-law', file: '00-iron-law.md', always: true, title: 'Iron Law' },
  { id: 'grounding', file: '01-grounding-protocol.md', always: true, title: 'Grounding Protocol' },
  {
    id: 'debugging',
    file: '02-systematic-debugging.md',
    title: 'Systematic Debugging',
    triggers: /\b(bug|error|errors|error|fail(ed|s|ing)?|crash(es|ed)?|broken|regress(ion)?|debug|traceback|exception|stack trace|tidak jalan|rusak|gagal|masalah)\b/i
  },
  {
    id: 'verification',
    file: '03-verification-first.md',
    title: 'Verification First',
    triggers: /\b(write|wrote|edit|change|fix|patch|implement|build|compile|deploy|release|install|test|verify|run|refactor|migrate|upgrade)\b/i
  },
  {
    id: 'surgical',
    file: '04-surgical-precision.md',
    title: 'Surgical Precision',
    triggers: /\b(file|code|function|class|module|refactor|rename|move|patch|edit|config|yaml|json)\b/i
  },
  {
    id: 'refusal',
    file: '05-honest-refusal.md',
    title: 'Honest Refusal',
    triggers: /\b(permission|denied|forbidden|cannot|can't|unable|blocked|credential|token|auth|login|access|429|403|401|timeout|offline)\b/i
  },
  {
    id: 'fidelity',
    file: '06-instruction-fidelity.md',
    title: 'Instruction Fidelity',
    triggers: /\b(exact(ly)?|must|require[sd]?|constraint|format|only|don't|do not|jangan|harus|hanya|semua|all|every|each)\b/i
  }
];

let cache = null;

function readModule(def) {
  try {
    const body = fs.readFileSync(path.join(SPELLBOOK_DIR, def.file), 'utf8').trim();
    return { id: def.id, title: def.title, body, chars: body.length };
  } catch {
    return null;
  }
}

function loadAll() {
  if (cache) return cache;
  cache = MODULES.map(readModule).filter(Boolean);
  return cache;
}

/**
 * Select doctrine text for a turn.
 * @param {string} intentText - user message + recent context
 * @param {number} budgetChars - hard cap on injected doctrine
 * @returns {{text:string, used:string[], chars:number}}
 */
function loadDoctrine(intentText = '', budgetChars = 7000) {
  const modules = loadAll();
  const chosen = new Map();

  for (const m of modules) {
    if (MODULES.find(x => x.id === m.id)?.always) chosen.set(m.id, m);
  }
  for (const m of modules) {
    if (chosen.has(m.id)) continue;
    const def = MODULES.find(x => x.id === m.id);
    if (def && def.triggers && def.triggers.test(intentText)) chosen.set(m.id, m);
  }
  // Fallback: if nothing matched beyond the always-on modules, add verification.
  if (chosen.size <= 2) {
    const v = modules.find(m => m.id === 'verification');
    if (v) chosen.set(v.id, v);
  }

  const used = [];
  let out = '';
  for (const m of chosen.values()) {
    const block = `\n### ${m.title}\n${m.body}\n`;
    if (out.length + block.length > budgetChars) continue;
    out += block;
    used.push(m.id);
  }

  return { text: out.trim(), used, chars: out.length };
}

module.exports = {
  SPELLBOOK_DIR,
  MODULES,
  loadAll,
  loadDoctrine
};
