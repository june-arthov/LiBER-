// src/utils/logger.js
const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logFile = path.join(process.cwd(), 'liber.log');
  }

  // Structured logging for production telemetry
  info(agentId, event, details) {
    this._write('INFO', agentId, event, details);
  }

  warn(agentId, event, details) {
    this._write('WARN', agentId, event, details);
  }

  error(agentId, event, details) {
    this._write('ERROR', agentId, event, details);
  }

  _write(level, agentId, event, details) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      agentId,
      event,
      details
    };
    const logString = JSON.stringify(logEntry);
    
    // Console for TUI, File for Telemetry
    console.log(`[${level}] ${agentId} | ${event}`);
    fs.appendFileSync(this.logFile, logString + '\n');
  }
}

module.exports = new Logger();
