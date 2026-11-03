// src/daemon/core/memory.js — sliding window + optional session persistence.
const fs = require('fs');
const path = require('path');
const secrets = require('./secrets');

class MemoryManager {
  constructor(windowSize = 10) {
    this.windowSize = windowSize;
    this.history = new Map(); // agentId -> messages[]
    this.persistPath = null;
  }

  /**
   * Persist the window across daemon restarts. Call once at boot.
   */
  attach(filePath, windowSize = null) {
    if (Number.isFinite(windowSize)) this.windowSize = windowSize;
    this.persistPath = path.resolve(process.cwd(), filePath);
    this._load();
    return this.persistPath;
  }

  _load() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      for (const [agentId, messages] of Object.entries(data.sessions || {})) {
        if (Array.isArray(messages)) this.history.set(agentId, messages.slice(-this.windowSize));
      }
    } catch {
      // corrupt session file: start clean rather than crash the daemon
    }
  }

  _save() {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const sessions = {};
      for (const [agentId, messages] of this.history.entries()) {
        // Credentials must never reach disk, even if the model echoed them.
        sessions[agentId] = messages.map(m => ({
          role: m.role,
          content: secrets.redact(m.content)
        }));
      }
      fs.writeFileSync(
        this.persistPath,
        JSON.stringify({ version: 1, updated_at: new Date().toISOString(), sessions }, null, 2),
        'utf8'
      );
    } catch {
      // never let persistence break a turn
    }
  }

  add(agentId, role, content) {
    if (!this.history.has(agentId)) {
      this.history.set(agentId, []);
    }
    const mem = this.history.get(agentId);
    mem.push({ role, content });
    while (mem.length > this.windowSize) mem.shift();
    this._save();
  }

  get(agentId) {
    return this.history.get(agentId) || [];
  }

  clear(agentId) {
    this.history.delete(agentId);
    this._save();
  }

  clearAll() {
    this.history.clear();
    this._save();
  }

  /** Live window resize: trim existing history to the new size immediately. */
  resize(newSize) {
    if (!Number.isFinite(newSize) || newSize < 1) return this.windowSize;
    this.windowSize = newSize;
    for (const [agentId, messages] of this.history.entries()) {
      while (messages.length > newSize) messages.shift();
      this.history.set(agentId, messages);
    }
    this._save();
    return this.windowSize;
  }
}

module.exports = new MemoryManager();
