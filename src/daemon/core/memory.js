// src/daemon/core/memory.js
class MemoryManager {
  constructor(windowSize = 10) {
    this.windowSize = windowSize;
    this.history = new Map(); // agentId -> messages[]
  }

  add(agentId, role, content) {
    if (!this.history.has(agentId)) {
      this.history.set(agentId, []);
    }
    const mem = this.history.get(agentId);
    mem.push({ role, content });
    if (mem.length > this.windowSize) mem.shift();
  }

  get(agentId) {
    return this.history.get(agentId) || [];
  }

  clear(agentId) {
    this.history.delete(agentId);
  }
}

module.exports = new MemoryManager();
