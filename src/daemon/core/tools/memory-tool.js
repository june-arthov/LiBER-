// src/daemon/core/tools/memory-tool.js — Merlin Persistent Memory Bank
const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.resolve(process.cwd(), '.liber_memory.json');

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
  manageMemory: (args) => store.execute(args)
};
