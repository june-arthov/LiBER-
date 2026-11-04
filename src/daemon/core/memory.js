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
    if (!this.persistPath) return;
    const candidates = [this.persistPath, `${this.persistPath}.bak`];
    for (let i = 0; i < candidates.length; i++) {
      const file = candidates[i];
      if (!fs.existsSync(file)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [agentId, messages] of Object.entries(data.sessions || {})) {
          if (Array.isArray(messages)) this.history.set(agentId, messages.slice(-this.windowSize));
        }
        if (i > 0) console.warn(`[liberd] session store was damaged — recovered ${this.history.size} session(s) from ${path.basename(file)}`);
        return;
      } catch {
        // fall through to the backup, then to a clean start
      }
    }
    if (fs.existsSync(this.persistPath)) console.warn('[liberd] session store unreadable and no backup — starting clean');
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
      const payload = JSON.stringify({ version: 1, updated_at: new Date().toISOString(), sessions }, null, 2);
      // Write-then-rename: a crash mid-write leaves the previous file intact,
      // and the previous file is kept as .bak for one more level of recovery.
      const tmp = `${this.persistPath}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      if (fs.existsSync(this.persistPath)) {
        try { fs.copyFileSync(this.persistPath, `${this.persistPath}.bak`); } catch { /* best effort */ }
      }
      fs.renameSync(tmp, this.persistPath);
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
