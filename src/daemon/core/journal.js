// src/daemon/core/journal.js — crash-safe turn journal for resume.
const fs = require('fs');
const path = require('path');
const secrets = require('./secrets');

function dir() {
  return path.resolve(process.cwd(), '.liber', 'turns');
}

function safeId(agentId) {
  return String(agentId).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function fileFor(agentId) {
  return path.join(dir(), `${safeId(agentId)}.json`);
}

function save(state) {
  if (!state || !state.agentId) return null;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const file = fileFor(state.agentId);
    const tmp = `${file}.tmp`;
    const payload = {
      ...state,
      userMessage: secrets.redact(state.userMessage),
      messages: Array.isArray(state.messages)
        ? state.messages.map(m => ({ ...m, content: secrets.redact(m.content) }))
        : state.messages,
      saved_at: new Date().toISOString()
    };
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}

function load(agentId) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(agentId), 'utf8'));
  } catch {
    return null;
  }
}

function clear(agentId) {
  try {
    fs.unlinkSync(fileFor(agentId));
    return true;
  } catch {
    return false;
  }
}

function list() {
  try {
    return fs.readdirSync(dir())
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'));
          return {
            agentId: data.agentId,
            user: String(data.userMessage || '').slice(0, 160),
            iteration: data.iteration || 0,
            receipts: (data.ledger?.receipts || []).length,
            saved_at: data.saved_at || null
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { save, load, clear, list, dir, fileFor };
