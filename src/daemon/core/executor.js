// src/daemon/core/executor.js — Backward compatibility facade for terminal-tool
const { runTerminal } = require('./tools/terminal-tool');

class ToolExecutor {
  async execute(command) {
    return await runTerminal({ command });
  }
}

module.exports = new ToolExecutor();
