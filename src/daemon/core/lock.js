// src/daemon/core/lock.js — serialize turns per agent.
// Two simultaneous chats on one agent would interleave observations into each
// other's history and corrupt answers. Each agent gets its own promise chain.
class AgentQueue {
  constructor() {
    this.chains = new Map(); // agentId -> tail promise
    this.waiting = new Map(); // agentId -> count
  }

  run(agentId, fn) {
    const prev = this.chains.get(agentId) || Promise.resolve();
    this.waiting.set(agentId, (this.waiting.get(agentId) || 0) + 1);

    const next = prev.catch(() => {}).then(async () => {
      try {
        return await fn();
      } finally {
        this.waiting.set(agentId, Math.max(0, (this.waiting.get(agentId) || 0) - 1));
      }
    });

    // Keep the chain alive even if a turn rejects.
    this.chains.set(agentId, next.catch(() => {}));
    return next;
  }

  pending(agentId) {
    return this.waiting.get(agentId) || 0;
  }
}

module.exports = { AgentQueue };
