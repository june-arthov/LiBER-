// src/daemon/core/circuit-breaker.js
class CircuitBreaker {
  constructor(maxIterations = 5) {
    this.maxIterations = maxIterations;
    this.counters = new Map(); // agentId -> count
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
    return (this.counters.get(agentId) || 0) >= this.maxIterations;
  }
}

module.exports = new CircuitBreaker();
