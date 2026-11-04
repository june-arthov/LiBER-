// src/daemon/core/tools/memory-tool.js — Liber Persistent Memory Bank
const fs = require('fs');
const path = require('path');

// LIBER_MEMORY_FILE keeps tests (and side-by-side installs) off the live store.
const MEMORY_FILE = process.env.LIBER_MEMORY_FILE || path.resolve(process.cwd(), '.liber_memory.json');

class MemoryStore {
  constructor() {
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      }
    } catch {
      // ignore
    }
    return {};
  }

  _save() {
    try {
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error(`[MemoryStore] Failed to save: ${err.message}`);
    }
  }

  /** Every entry, newest first — for injection and the settings page. */
  allEntries() {
    return Object.entries(this.data)
      .map(([key, v]) => ({
        key,
        value: String(v && v.value !== undefined ? v.value : ''),
        updated_at: (v && v.updated_at) || null
      }))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }

  /**
   * Compact text for the system prompt. This is the whole point of the store:
   * a new session should know the standing facts without having to ask for
   * them. Budgeted, because memory that crowds out the task is worse than none.
   */
  block(maxChars = 1400) {
    const entries = this.allEntries();
    if (!entries.length) return '';
    const lines = [];
    let used = 0;
    for (const e of entries) {
      const value = e.value.replace(/\s+/g, ' ').trim();
      if (!value) continue;
      const line = `- ${e.key}: ${value.length > 220 ? value.slice(0, 217) + '…' : value}`;
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join('\n');
  }

  /** Write facts that are missing; never overwrite what the user already set. */
  seed(facts = {}) {
    let added = 0;
    for (const [key, value] of Object.entries(facts)) {
      if (key in this.data) continue;
      if (value === undefined || value === null || String(value).trim() === '') continue;
      this.data[key] = { value: String(value), updated_at: new Date().toISOString() };
      added++;
    }
    if (added) this._save();
    return added;
  }

  execute({ action = "get", key = null, value = null }) {
    const act = (action || "get").toLowerCase();

    if (act === "set" || act === "store") {
      if (!key) return { error: "Missing 'key' argument for set." };
      this.data[key] = {
        value,
        updated_at: new Date().toISOString()
      };
      this._save();
      return { success: true, message: `Stored key '${key}'.`, key, value };
    }

    if (act === "get" || act === "recall") {
      if (!key) return { error: "Missing 'key' argument for get." };
      if (!(key in this.data)) {
        return { found: false, message: `Key '${key}' not found in persistent memory.` };
      }
      return { found: true, key, ...this.data[key] };
    }

    if (act === "delete" || act === "forget") {
      if (!key) return { error: "Missing 'key' argument for delete." };
      if (key in this.data) {
        delete this.data[key];
        this._save();
        return { success: true, message: `Deleted key '${key}' from memory.` };
      }
      return { found: false, message: `Key '${key}' did not exist.` };
    }

    if (act === "list" || act === "all") {
      return {
        total_keys: Object.keys(this.data).length,
        keys: Object.keys(this.data),
        entries: this.data
      };
    }

    return { error: `Unknown memory action: ${action}. Use get, set, delete, or list.` };
  }
}

const store = new MemoryStore();
module.exports = {
  manageMemory: (args) => store.execute(args),
  memoryBlock: (maxChars) => store.block(maxChars),
  memoryEntries: () => store.allEntries(),
  memorySeed: (facts) => store.seed(facts),
  memoryStore: store
};
