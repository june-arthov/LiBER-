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
    try {
      this._rotateIfNeeded();
      fs.appendFileSync(this.logFile, logString + '\n');
    } catch {
      // never let logging break the harness
    }
  }

  _rotateIfNeeded() {
    const MAX = 5 * 1024 * 1024; // 5 MB
    try {
      const stat = fs.statSync(this.logFile);
      if (stat.size > MAX) {
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      }
    } catch {
      // file missing or unreadable — nothing to rotate
    }
  }
}

module.exports = new Logger();
