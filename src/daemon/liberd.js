// src/daemon/liberd.js
const http = require('http');
const llmManager = require('./llm/manager');
const ConfigLoader = require('../utils/config-loader');
const merlinEngine = require('./core/engine');
const memory = require('./core/memory');
const registry = require('./core/registry');
const circuitBreaker = require('./core/circuit-breaker');
const trace = require('./core/trace');
const auth = require('./core/auth');
const policy = require('./core/policy');
const logger = require('../utils/logger');

class LiberDaemon {
  constructor() {
    this.agents = new Map();
    this.port = 4567;
    this.server = null;
    this.hitlPending = null; // { resolve, agentId, command }
  }

  resolveHitl(approved) {
    if (this.hitlPending) {
      this.hitlPending.resolve(approved);
      this.hitlPending = null;
      return true;
    }
    return false;
  }

  waitForHitl(agentId, command, timeoutMs = 60000) {
    return new Promise((resolve) => {
      this.hitlPending = { resolve, agentId, command };
      setTimeout(() => {
        if (this.hitlPending && this.hitlPending.command === command) {
          this.hitlPending = null;
          resolve(false); // timeout defaults to deny
        }
      }, timeoutMs);
    });
  }

  async fetchAvailableModels(engine) {
    if (!engine || !engine.endpoint || !engine.apiKey) return [];
    try {
      const url = `${engine.endpoint}/models`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${engine.apiKey}` }
      });
      if (!res.ok) return [];
      const data = await res.json();
      if (Array.isArray(data.data)) {
        return data.data.map(m => m.id);
      }
      if (Array.isArray(data.models)) {
        return data.models.map(m => m.name || m.id);
      }
      return [];
    } catch {
      return [];
    }
  }

  persistModelChange(newModel) {
    try {
      const fs = require('fs');
      const path = require('path');
      const cfgPath = path.resolve(process.cwd(), process.env.LIBER_CONFIG || 'liber.yaml');
      if (fs.existsSync(cfgPath)) {
        let raw = fs.readFileSync(cfgPath, 'utf8');
        raw = raw.replace(/model:\s*["'][^"']+["']/, `model: "${newModel}"`);
        fs.writeFileSync(cfgPath, raw, 'utf8');
      }
    } catch (e) {
      console.error(`[liberd] Failed to update liber.yaml: ${e.message}`);
    }
  }

  async start(configPath = process.env.LIBER_CONFIG || 'liber.yaml') {
    console.log(`[liberd] Starting Liber Production-Grade Daemon...`);
    try {
      const config = ConfigLoader.load(configPath);
      llmManager.initialize(config.agent.engine);
      policy.configure(config.policy || {});
      this.token = auth.ensureToken();

      this.maxLoops = config.limits?.circuit_breaker?.max_loops || 12;
      if (config.memory?.persist !== false) {
        memory.attach(config.memory?.path || '.liber/session.json', config.memory?.window_size);
      }
      this.traceEnabled = config.telemetry?.trace !== false;

      const agentId = config.agent.name || 'default-agent';
      this.agents.set(agentId, {
        config: {
          ...config.agent,
          grounding: config.grounding || {},
          skills: config.skills || {}
        },
        status: 'RUNNING',
        startTime: Date.now(),
        metrics: { tokens: 0, requests: 0 }
      });

      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      // Bind to loopback by default: the daemon has no auth, so exposing it on the LAN
      // would let any device spend the API key or call /shutdown. Override deliberately
      // with LIBER_HOST only behind a trusted proxy.
      const host = process.env.LIBER_HOST || '127.0.0.1';
      this.server.listen(this.port, host, () => {
        logger.info('SYSTEM', 'DAEMON_START', { port: this.port, host });
      });
    } catch (err) {
      logger.error('SYSTEM', 'BOOT_FAILED', { error: err.message });
      process.exit(1);
    }
  }

  /**
   * Public view of an agent. Never exposes credentials or raw config.
   */
  sanitizeAgent(id, data) {
    const engine = data.config?.engine || {};
    return {
      id,
      status: data.status,
      startTime: data.startTime,
      metrics: data.metrics,
      name: data.config?.name || id,
      version: data.config?.version || null,
      model: engine.model || null,
      provider: engine.provider || null,
      grounding: data.config?.grounding?.enabled !== false
    };
  }

  async handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const endpoint = url.pathname;
    res.setHeader('Content-Type', 'application/json');

    // Unauthenticated liveness probe only — it exposes no state.
    if (endpoint === '/healthz') {
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (!auth.isAuthorized(req, this.token)) {
      res.statusCode = 401;
      res.end(JSON.stringify({
        success: false,
        error: 'Unauthorized. Send Authorization: Bearer <token> (token: .liber/daemon.token).'
      }));
      return;
    }

    try {
      if (endpoint === '/ps') {
        const status = Array.from(this.agents.entries()).map(([id, data]) => this.sanitizeAgent(id, data));
        res.end(JSON.stringify({ success: true, data: status }));
      } 
      else if (endpoint === '/shutdown') {
        res.end(JSON.stringify({ success: true }));
        setTimeout(() => { this.stop(); process.exit(0); }, 100);
      }
      else if (endpoint === '/session/clear') {
        memory.clearAll();
        res.end(JSON.stringify({ success: true, cleared: true }));
      }
      else if (endpoint === '/hitl/verdict') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { verdict } = JSON.parse(body || '{}');
        const handled = this.resolveHitl(verdict === 'approve' || verdict === true);
        res.end(JSON.stringify({ success: true, handled }));
      }
      else if (endpoint === '/models') {
        const firstAgent = Array.from(this.agents.values())[0];
        const engine = firstAgent?.config?.engine || {};
        const models = await this.fetchAvailableModels(engine);
        res.end(JSON.stringify({ success: true, active: engine.model, models }));
      }
      else if (endpoint === '/model/switch') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { model } = JSON.parse(body || '{}');
        if (!model) throw new Error("Missing 'model' parameter.");

        for (const [id, agent] of this.agents.entries()) {
          agent.config.engine.model = model;
          llmManager.initialize(agent.config.engine);
        }

        this.persistModelChange(model);
        res.end(JSON.stringify({ success: true, active: model }));
      }
      else if (endpoint === '/chat/stream') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');

        const sendEvent = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        let body = '';
        for await (const chunk of req) body += chunk;
        const { agentId, message } = JSON.parse(body || '{}');

        if (!this.agents.has(agentId)) {
          sendEvent('error', { error: `Agent ${agentId} not found` });
          res.end();
          return;
        }

        const agent = this.agents.get(agentId);
        try {
          const result = await merlinEngine.runTurn({
            agentId,
            agentConfig: agent.config,
            userMessage: message,
            memory,
            llmManager,
            onEvent: sendEvent,
            waitForHitl: (aid, toolName, args) => this.waitForHitl(aid, `${toolName}: ${JSON.stringify(args)}`),
            maxLoops: this.maxLoops
          });
          if (this.traceEnabled) {
            trace.appendTurn({ agentId, userMessage: message, result, model: agent.config.engine?.model });
          }
        } catch (err) {
          sendEvent('error', { error: err.message });
        }
        res.end();
      }
      else if (endpoint === '/chat') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { agentId, message } = JSON.parse(body || '{}');

        if (!this.agents.has(agentId)) throw new Error(`Agent ${agentId} not found`);
        const agent = this.agents.get(agentId);

        const result = await merlinEngine.runTurn({
          agentId,
          agentConfig: agent.config,
          userMessage: message,
          memory,
          llmManager,
          waitForHitl: () => Promise.resolve(true),
          maxLoops: this.maxLoops
        });

        if (this.traceEnabled) {
          trace.appendTurn({ agentId, userMessage: message, result, model: agent.config.engine?.model });
        }

        res.end(JSON.stringify(result));
      } 
      else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: 'Endpoint not found' }));
      }
    } catch (err) {
      logger.error('SYSTEM', 'REQUEST_FAILED', { error: err.message });
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = new LiberDaemon();

