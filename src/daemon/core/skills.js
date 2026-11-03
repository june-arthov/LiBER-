// src/daemon/core/skills.js — progressive-disclosure skill library.
// The index is cheap and always injected; bodies are loaded on demand by the model
// (skill tool) or auto-selected by trigger match. Project skills override global ones.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const GLOBAL_DIR = path.resolve(__dirname, '..', '..', '..', 'skills');
const PROJECT_DIR = () => path.resolve(process.cwd(), '.liber', 'skills');
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const BODY_CAP = 9000;

let cache = null;

function parseSkillFile(file, source) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;

  let meta;
  try {
    meta = yaml.load(m[1]) || {};
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object') return null;

  const dir = path.dirname(file);
  const name = String(meta.name || path.basename(dir));
  if (!NAME_RE.test(name)) return null;

  const triggers = Array.isArray(meta.triggers)
    ? meta.triggers.map(t => String(t)).filter(Boolean).slice(0, 16)
    : [];

  return {
    name,
    description: String(meta.description || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    always: meta.always === true,
    triggers,
    body: m[2].trim(),
    dir,
    file,
    source,
    files: listAttachments(dir)
  };
}

function listAttachments(dir) {
  const out = [];
  for (const sub of ['references', 'scripts', 'templates', 'assets']) {
    const p = path.join(dir, sub);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p)) {
      out.push(`${sub}/${f}`);
    }
  }
  return out.sort();
}

function walk(dir, source, depth = 0, found = new Map()) {
  if (depth > 2 || !fs.existsSync(dir)) return found;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, source, depth + 1, found);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      const skill = parseSkillFile(full, source);
      if (skill) found.set(skill.name, skill);
    }
  }
  return found;
}

function scan(force = false) {
  if (cache && !force) return cache;
  const found = new Map();
  walk(GLOBAL_DIR, 'global', 0, found);
  // Project skills load second so they override same-named global skills.
  walk(PROJECT_DIR(), 'project', 0, found);
  cache = Array.from(found.values()).sort((a, b) => {
    if (a.always !== b.always) return a.always ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return cache;
}

function reload() {
  cache = null;
  return scan(true);
}

function get(name) {
  const target = String(name || '').toLowerCase();
  return scan().find(s => s.name === target) || null;
}

function indexLines() {
  return scan()
    .map(s => `- ${s.name}${s.always ? ' (always)' : ''} — ${s.description}`)
    .join('\n');
}

function intentMatches(skill, intentText) {
  if (!intentText) return false;
  const text = String(intentText);
  return skill.triggers.some(t => {
    try {
      return new RegExp(t, 'i').test(text);
    } catch {
      return text.toLowerCase().includes(t.toLowerCase());
    }
  });
}

/**
 * Build the per-turn skill context: cheap index + always-on bodies + trigger-matched bodies.
 */
function buildContext(intentText = '', budgetChars = 7000) {
  const skills = scan();
  const index = `=== SKILLS INDEX (load a body with [TOOL: skill({"action":"view","name":"..."})]) ===\n${indexLines()}\n`;

  let text = index;
  const used = [];

  const addBody = (skill, label) => {
    const block = `\n### ${skill.name} ${label}\n${skill.body}\n`;
    if (text.length + block.length > budgetChars) return false;
    text += block;
    used.push(skill.name);
    return true;
  };

  for (const s of skills.filter(x => x.always)) addBody(s, '(core procedure)');
  for (const s of skills.filter(x => !x.always)) {
    if (intentMatches(s, intentText)) addBody(s, '(auto-selected for this request)');
  }

  return { text, used, chars: text.length, total: skills.length };
}

function view(name, cap = BODY_CAP) {
  const skill = get(name);
  if (!skill) {
    return {
      error: `Skill '${name}' not found. Available: ${scan().map(s => s.name).join(', ')}.`
    };
  }
  return {
    name: skill.name,
    description: skill.description,
    always: skill.always,
    triggers: skill.triggers,
    source: skill.source,
    files: skill.files,
    body: skill.body.length > cap ? skill.body.slice(0, cap) + `\n... [TRUNCATED at ${cap} chars]` : skill.body
  };
}

function search(query, limit = 5) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return { error: 'Missing search query.' };
  const hits = [];
  for (const s of scan()) {
    const haystack = `${s.name} ${s.description} ${s.body}`.toLowerCase();
    let score = 0;
    if (s.name.includes(q)) score += 5;
    if (s.description.toLowerCase().includes(q)) score += 3;
    const occurrences = haystack.split(q).length - 1;
    score += Math.min(occurrences, 5);
    if (score > 0) {
      const idx = s.body.toLowerCase().indexOf(q);
      hits.push({
        name: s.name,
        description: s.description,
        score,
        snippet: idx >= 0 ? s.body.slice(Math.max(0, idx - 60), idx + 120).replace(/\s+/g, ' ') : ''
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return { query, total: hits.length, matches: hits.slice(0, Math.min(limit, 10)) };
}

function validate({ name, description, body }) {
  const errors = [];
  if (!NAME_RE.test(String(name || ''))) {
    errors.push('name must be lowercase letters, digits or hyphens (2–64 chars).');
  }
  const desc = String(description || '').trim();
  if (desc.length < 20) errors.push('description must be at least 20 chars and start with "Use when ...".');
  if (desc.length > 400) errors.push('description must be ≤ 400 chars.');
  const text = String(body || '').trim();
  if (text.length < 60) errors.push('body must be at least 60 chars.');
  if (text.length > 20000) errors.push('body must be ≤ 20000 chars.');
  return errors;
}

/**
 * Create or update a skill in the project-level library (.liber/skills).
 * Package-level skills are never modified at runtime.
 */
function writeSkill({ name, description, body, triggers = [], always = false }, overwrite = false) {
  const errors = validate({ name, description, body });
  if (errors.length) return { error: errors.join(' '), validation_failed: true };

  const dir = path.join(PROJECT_DIR(), String(name).toLowerCase());
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file) && !overwrite) {
    return { error: `Skill '${name}' already exists at ${file}. Use action 'update' to replace it.` };
  }

  const trig = Array.isArray(triggers)
    ? triggers.map(t => String(t).trim()).filter(Boolean).slice(0, 16)
    : [];

  const frontmatter = yaml.dump(
    {
      name: String(name).toLowerCase(),
      description: String(description).trim(),
      always: always === true,
      triggers: trig
    },
    { lineWidth: 120 }
  );

  const content = `---\n${frontmatter}---\n\n# ${String(name).toLowerCase()}\n\n${String(body).trim()}\n`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  reload();

  return {
    success: true,
    name: String(name).toLowerCase(),
    path: path.relative(process.cwd(), file) || file,
    action: overwrite ? 'updated' : 'created',
    bytes_written: Buffer.byteLength(content, 'utf8')
  };
}

module.exports = {
  GLOBAL_DIR,
  PROJECT_DIR,
  scan,
  reload,
  get,
  view,
  search,
  buildContext,
  writeSkill,
  indexLines,
  listAttachments
};
