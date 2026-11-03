// src/daemon/core/circuit-breaker.js
class CircuitBreaker {
  constructor(maxIterations = 5) {
    this.defaultLimit = maxIterations;
    this.limits = new Map();   // agentId -> max iterations
    this.counters = new Map(); // agentId -> count
  }

  configureLimit(agentId, maxIterations) {
    if (Number.isFinite(maxIterations) && maxIterations > 0) {
      this.limits.set(agentId, maxIterations);
    }
  }

  increment(agentId) {
    const count = (this.counters.get(agentId) || 0) + 1;
    this.counters.set(agentId, count);
    return count;
  }

  reset(agentId) {
    this.counters.delete(agentId);
  }

  isBroken(agentId) {
    const limit = this.limits.get(agentId) || this.defaultLimit;
    return (this.counters.get(agentId) || 0) >= limit;
  }
}

module.exports = new CircuitBreaker();
