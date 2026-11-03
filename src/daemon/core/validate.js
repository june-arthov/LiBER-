// src/daemon/core/validate.js — Deterministic tool-argument validation (schema-lite).
// A tool must never execute on hallucinated or malformed arguments.

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  return typeof value;
}

function checkType(expected, value) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

/**
 * @param {object} schema - { type:'object', properties:{...}, required:[...] }
 * @param {object} args
 * @returns {{ok:boolean, errors:string[], problems:Array}}
 */
function validateArgs(schema, args) {
  const errors = [];
  const problems = [];
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : null;

  if (!input) {
    return { ok: false, errors: ['Arguments must be a JSON object.'], problems: [{ field: '*', issue: 'not_an_object' }] };
  }
  if (!schema || typeof schema !== 'object') return { ok: true, errors, problems };

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const field of required) {
    const v = input[field];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      errors.push(`Missing required argument '${field}'.`);
      problems.push({ field, issue: 'missing' });
    }
  }

  const props = schema.properties || {};
  for (const [field, def] of Object.entries(props)) {
    if (!(field in input) || input[field] === undefined || input[field] === null) continue;
    if (def.type && !checkType(def.type, input[field])) {
      errors.push(`Argument '${field}' must be ${def.type}, received ${typeOf(input[field])}.`);
      problems.push({ field, issue: 'type', expected: def.type, received: typeOf(input[field]) });
      continue;
    }
    if (Array.isArray(def.enum) && !def.enum.includes(input[field])) {
      errors.push(`Argument '${field}' must be one of: ${def.enum.join(', ')} (received '${input[field]}').`);
      problems.push({ field, issue: 'enum', allowed: def.enum });
    }
    if (typeof input[field] === 'string' && typeof def.maxLength === 'number' && input[field].length > def.maxLength) {
      errors.push(`Argument '${field}' exceeds maxLength ${def.maxLength}.`);
      problems.push({ field, issue: 'max_length' });
    }
  }

  // Catch the common hallucination: right idea, wrong key name.
  const unknown = Object.keys(input).filter(k => !(k in props));
  for (const key of unknown) {
    const near = Object.keys(props).find(p => {
      const a = p.toLowerCase();
      const b = key.toLowerCase();
      if (a === b) return true;
      const dist = levenshtein(a, b);
      return dist > 0 && dist <= 2;
    });
    if (near) {
      errors.push(`Unknown argument '${key}'. Did you mean '${near}'?`);
      problems.push({ field: key, issue: 'did_you_mean', suggestion: near });
    }
  }

  return { ok: errors.length === 0, errors, problems };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

module.exports = { validateArgs, typeOf };
