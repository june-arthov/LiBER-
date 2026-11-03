// src/daemon/liberd.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const llmManager = require('./llm/manager');
const ConfigLoader = require('../utils/config-loader');
const liberEngine = require('./core/engine');
const memory = require('./core/memory');
const registry = require('./core/registry');
const circuitBreaker = require('./core/circuit-breaker');
const trace = require('./core/trace');
const auth = require('./core/auth');
const policy = require('./core/policy');
const journal = require('./core/journal');
const modelSwitch = require('./core/model-switch');
const configApply = require('./core/config-apply');
const workspace = require('./core/workspace');
const skills = require('./core/skills');
const { AgentQueue } = require('./core/lock');
const logger = require('../utils/logger');

class LiberDaemon {
  constructor() {
    this.agents = new Map();
    this.port = 4567;
    this.server = null;
    this.hitlPending = null; // { resolve, agentId, command }
    this.queue = new AgentQueue(); // one turn at a time per agent
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

  persistConfigChanges(changes) {
    try {
      const cfgPath = path.resolve(process.cwd(), process.env.LIBER_CONFIG || 'liber.yaml');
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        // engine.* lives under the agent: section in liber.yaml.
        const yamlChanges = {};
        for (const [key, value] of Object.entries(changes)) {
          yamlChanges[key.startsWith('engine.') ? `agent.${key}` : key] = value;
        }
        const patched = configApply.patchYamlKeys(raw, yamlChanges);
        if (patched !== raw) {
          const tmp = `${cfgPath}.tmp`;
          fs.writeFileSync(tmp, patched, 'utf8');
          fs.renameSync(tmp, cfgPath);
        }
      }
    } catch (e) {
      logger.error('SYSTEM', 'CONFIG_PERSIST_FAILED', { error: e.message });
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
          skills: config.skills || {},
          limits: config.limits || {},
          memory: config.memory || {}
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

  /**
   * Apply one dotted config path to a live agent config, with the side effects
   * each subsystem needs. Handles nested keys (limits.circuit_breaker.max_loops).
   */
  applyConfigPath(agent, dottedPath, value) {
    const cfg = agent.config;
    const [top, ...rest] = dottedPath.split('.');
    const setDeep = (obj, keys, val) => {
      let cur = obj;
      for (let i = 0; i < keys.length - 1; i++) {
        if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = val;
    };

    if (top === 'engine') setDeep(cfg, ['engine', ...rest], value);
    else if (top === 'grounding') setDeep(cfg, ['grounding', ...rest], value);
    else if (top === 'limits') {
      setDeep(cfg, ['limits', ...rest], value);
      if (rest[0] === 'circuit_breaker' && rest[1] === 'max_loops') this.maxLoops = value;
    }
    else if (top === 'memory') {
      setDeep(cfg, ['memory', ...rest], value);
      if (rest[0] === 'window_size') memory.resize(value);
    }
    else if (top === 'telemetry') {
      setDeep(cfg, ['telemetry', ...rest], value);
      if (rest[0] === 'trace') this.traceEnabled = !!value;
    }
    else if (top === 'policy') {
      const pol = policy.current();
      const terminal = { ...pol.terminal };
      if (rest[0] === 'terminal') terminal[rest[1]] = value;
      policy.configure({
        write_roots: rest[0] === 'write_roots' ? value : pol.write_roots,
        allow_outside_workspace: pol.allow_outside_workspace,
        terminal
      });
    }
  }

  async handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const endpoint = url.pathname;
    res.setHeader('Content-Type', 'application/json');

    // CORS for the desktop shell (Neutralino/WebView2 origin) and any local client.
    // The daemon binds to loopback and every stateful endpoint still requires the
    // bearer token, so a wildcard origin does not weaken access control.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Unauthenticated liveness probe only — it exposes no state.
    if (endpoint === '/healthz') {
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Unauthenticated bootstrap info for local shells: the daemon's cwd and where
    // its token FILE lives (the path only — the token itself is never served).
    if (endpoint === '/whoami') {
      let version = '0.0.0';
      try { version = require('../../package.json').version || version; } catch { /* best effort */ }
      res.end(JSON.stringify({
        app: 'liber',
        version,
        cwd: process.cwd(),
        token_path: path.join(process.cwd(), '.liber', 'daemon.token'),
        platform: process.platform,
        arch: process.arch,
        cpus: (require('os').cpus() || []).length,
        user: (() => { try { return require('os').userInfo().username; } catch { return null; } })()
      }));
      return;
    }

    if (!auth.isAuthorized(req, this.token)) {
      res.statusCode = 401;
      res.end(JSON.stringify({
        success: false,
        error: 'Unauthorized. Send Authorization: Bearer <token> (token: .liber/daemon.token).'
      }));
      logger.warn('SYSTEM', 'AUTH_FAILED', { endpoint, ip: req.socket.remoteAddress });
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
      else if (endpoint === '/turns') {
        res.end(JSON.stringify({ success: true, turns: journal.list() }));
      }
      else if (endpoint === '/resume') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { agentId } = JSON.parse(body || '{}');
        const id = agentId || Array.from(this.agents.keys())[0];
        if (!this.agents.has(id)) throw new Error(`Agent ${id} not found`);

        const agent = this.agents.get(id);
        const result = await this.queue.run(id, () => liberEngine.resume(id, {
          agentConfig: agent.config,
          memory,
          llmManager,
          onEvent: () => {},
          maxLoops: this.maxLoops
        }));

        if (result && result.response && this.traceEnabled) {
          trace.appendTurn({ agentId: id, userMessage: '(resumed turn)', result, model: agent.config.engine?.model });
        }
        res.end(JSON.stringify(result));
      }
      else if (endpoint === '/hitl/verdict') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { verdict } = JSON.parse(body || '{}');
        const handled = this.resolveHitl(verdict === 'approve' || verdict === true);
        res.end(JSON.stringify({ success: true, handled }));
      }
      else if (endpoint === '/sessions') {
        if (req.method === 'GET') {
          const overview = {};
          for (const [agentId, messages] of memory.history?.entries() || []) {
            const assistant = messages.filter(m => m.role === 'assistant');
            overview[agentId] = {
              messages: messages.length,
              last: assistant.length ? String(assistant[assistant.length - 1].content || '').slice(0, 80) : null
            };
          }
          const persisted = {};
          try {
            if (memory.persistPath && fs.existsSync(memory.persistPath)) {
              persisted.size_bytes = fs.statSync(memory.persistPath).size;
              persisted.file = memory.persistPath;
            }
          } catch { /* best effort */ }
          res.end(JSON.stringify({ success: true, sessions: overview, persisted }));
          return;
        }
        if (req.method === 'DELETE') {
          memory.clearAll();
          res.end(JSON.stringify({ success: true, cleared: true }));
          return;
        }
      }
      else if (endpoint === '/config/backup') {
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const outDir = path.join(process.cwd(), '.liber');

          if (fs.existsSync(outDir)) {
            for (const f of fs.readdirSync(outDir)) {
              if (f.startsWith('liber.yaml.backup')) fs.unlinkSync(path.join(outDir, f));
            }
          }
          fs.mkdirSync(outDir, { recursive: true });

          const cfgPath = path.resolve(process.cwd(), process.env.LIBER_CONFIG || 'liber.yaml');
          const target = path.join(outDir, `liber.yaml.backup-${stamp}`);
          if (fs.existsSync(cfgPath)) {
            fs.copyFileSync(cfgPath, target);
          }
          res.end(JSON.stringify({ success: true, backup: target }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
      }
      else if (endpoint === '/workspace') {
        res.end(JSON.stringify({ success: true, workspace: workspace.summary(), activity: workspace.recent(20) }));
      }
      else if (endpoint === '/skills') {
        const scanned = skills.scan(true);
        const list = Array.from(scanned.values ? scanned.values() : Object.values(scanned))
          .map(s => ({
            name: s.name,
            description: String(s.description || '').slice(0, 200),
            source: s.source || null,
            always: !!s.always,
            triggers: s.triggers || [],
            bytes: s.size || (String(s.body || '').length || null)
          }));
        res.end(JSON.stringify({ success: true, skills: list, index: skills.indexLines() }));
      }
      else if (endpoint === '/compact') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { agentId, keep = 6 } = JSON.parse(body || '{}');
        const id = agentId || Array.from(this.agents.keys())[0];
        const before = memory.get(id).length;
        if (before <= keep + 2) {
          res.end(JSON.stringify({
            success: false,
            error: `Nothing to compact (${before} messages, keep=${keep}).`,
            before
          }));
          return;
        }
        const history = memory.get(id);
        const old = history.slice(0, history.length - keep);
        const tail = history.slice(-keep);
        const transcript = old
          .map(m => `${m.role.toUpperCase()}: ${String(m.content).slice(0, 1200)}`)
          .join('\n');
        let method = 'trim';
        let summary = '';
        try {
          const out = await llmManager.generate([
            {
              role: 'system',
              content: 'Summarize this conversation history so an agent can continue the work. Keep decisions, files touched, open questions, and any verified facts with their receipt ids. Be dense; no preamble.'
            },
            { role: 'user', content: transcript }
          ], { temperature: 0.1, max_tokens: 700 });
          summary = String(out?.content || '').trim();
          if (summary) method = 'model';
        } catch {
          method = 'trim';
        }
        if (!summary) {
          summary = `[COMPACTED] ${old.length} earlier messages dropped; the last ${keep} are below.`;
        }
        memory.clear(id);
        memory.add(id, 'system', `[COMPACTED HISTORY]\n${summary}`);
        for (const m of tail) memory.add(id, m.role, m.content);
        res.end(JSON.stringify({
          success: true,
          method,
          before,
          after: memory.get(id).length,
          summary_chars: summary.length
        }));
      }
      else if (endpoint === '/revert') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { agentId, turns = 1 } = JSON.parse(body || '{}');
        const id = agentId || Array.from(this.agents.keys())[0];
        const history = memory.get(id);
        if (!history.length) {
          res.end(JSON.stringify({ success: false, error: 'No history to revert.' }));
          return;
        }
        let dropped = 0;
        for (let i = 0; i < Math.max(1, Math.min(Number(turns) || 1, 10)); i++) {
          while (history.length && history[history.length - 1].role === 'assistant') {
            history.pop();
            dropped++;
          }
          if (history.length && history[history.length - 1].role === 'user') {
            history.pop();
            dropped++;
          }
        }
        memory.clear(id);
        for (const m of history) memory.add(id, m.role, m.content);
        res.end(JSON.stringify({ success: true, dropped, remaining: memory.get(id).length }));
      }
      else if (endpoint === '/config/export') {
        try {
          const cfgPath = path.resolve(process.cwd(), process.env.LIBER_CONFIG || 'liber.yaml');
          const raw = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
          const secrets = require('./core/secrets');
          res.end(JSON.stringify({ success: true, path: cfgPath, yaml: secrets.redact(raw) }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
      }
      else if (endpoint === '/config/reset') {
        const defs = configApply.defaults();
        const { changes, error } = configApply.validateConfigUpdate(defs);
        if (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error }));
          return;
        }
        for (const [, agent] of this.agents.entries()) {
          for (const [p, value] of Object.entries(changes)) {
            this.applyConfigPath(agent, p, value);
          }
          if (Object.keys(changes).some(k => k.startsWith('engine.'))) {
            const cfg = agent.config;
            const key = ConfigLoader.resolveApiKey(cfg.engine.provider, cfg.engine.endpoint);
            if (key) cfg.engine.apiKey = key;
            llmManager.initialize(cfg.engine);
          }
        }
        this.persistConfigChanges(changes);
        const firstReset = Array.from(this.agents.values())[0];
        res.end(JSON.stringify({
          success: true,
          reset: Object.keys(changes),
          applied: configApply.sanitizeConfig(firstReset?.config, this.traceEnabled, process.cwd())
        }));
        return;
      }
      else if (endpoint === '/config') {
        if (req.method === 'GET') {
          const first = Array.from(this.agents.values())[0];
          res.end(JSON.stringify({
            success: true,
            config: configApply.sanitizeConfig(first?.config, this.traceEnabled, process.cwd())
          }));
          return;
        }

        // POST: whitelisted live updates, applied to every agent and persisted.
        let body = '';
        for await (const chunk of req) body += chunk;
        let payload;
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON body.' }));
          return;
        }
        const { changes, error } = configApply.validateConfigUpdate(payload);
        if (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error }));
          return;
        }

        const engineTouched = Object.keys(changes).some(k => k.startsWith('engine.'));
        for (const [id, agent] of this.agents.entries()) {
          for (const [p, value] of Object.entries(changes)) {
            this.applyConfigPath(agent, p, value);
          }
          if (engineTouched) {
            const cfg = agent.config;
            const key = ConfigLoader.resolveApiKey(cfg.engine.provider, cfg.engine.endpoint);
            if (key) cfg.engine.apiKey = key;
            llmManager.initialize(cfg.engine);
          }
        }

        this.persistConfigChanges(changes);

        const first = Array.from(this.agents.values())[0];
        res.end(JSON.stringify({
          success: true,
          applied: configApply.sanitizeConfig(first?.config, this.traceEnabled, process.cwd())
        }));
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
        const spec = modelSwitch.validateSwitch(JSON.parse(body || '{}'));
        if (spec.error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: spec.error }));
          return;
        }

        const changed = {};
        for (const [id, agent] of this.agents.entries()) {
          const engine = agent.config.engine;
          if (spec.provider && engine.provider !== spec.provider) {
            engine.provider = spec.provider;
          }
          engine.model = spec.model;
          if (spec.endpoint) engine.endpoint = spec.endpoint;
          // Endpoint-aware key: Groq/DeepSeek/Mistral/... each need their own key.
          const key = ConfigLoader.resolveApiKey(engine.provider, engine.endpoint);
          if (key) engine.apiKey = key;
          llmManager.initialize(engine);
          changed[id] = { ...modelSwitch.sanitizeEngine(engine), key_resolved: !!key };
        }

        this.persistConfigChanges({ 'engine.provider': spec.provider, 'engine.model': spec.model, 'engine.endpoint': spec.endpoint });

        const first = Array.from(this.agents.values())[0];
        res.end(JSON.stringify({
          success: true,
          active: first ? modelSwitch.sanitizeEngine(first.config.engine) : { model: spec.model, provider: spec.provider, endpoint: spec.endpoint },
          changed
        }));
      }
      else if (endpoint === '/chat/stream') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');

        const sendEvent = (event, data) => {
          // Feed the desktop Overview rail with the tool steps this daemon
          // actually executed (observations only — no invented entries).
          if (event === 'observation') {
            workspace.record({
              tool: data.tool,
              ok: data.ok,
              evidence: data.evidence,
              detail: data.command || data.output,
              exit_code: data.exit_code
            });
          }
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
          const result = await this.queue.run(agentId, () => liberEngine.runTurn({
            agentId,
            agentConfig: agent.config,
            userMessage: message,
            memory,
            llmManager,
            onEvent: sendEvent,
            waitForHitl: (aid, toolName, args) => this.waitForHitl(aid, `${toolName}: ${JSON.stringify(args)}`),
            maxLoops: this.maxLoops
          }));
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

        const result = await this.queue.run(agentId, () => liberEngine.runTurn({
          agentId,
          agentConfig: agent.config,
          userMessage: message,
          memory,
          llmManager,
          waitForHitl: () => Promise.resolve(true),
          maxLoops: this.maxLoops
        }));

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

