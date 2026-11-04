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
const providers = require('./core/providers');
const budget = require('./core/budget');
const memoryBank = require('./core/tools/memory-tool');
const automations = require('./core/automations');
const vault = require('./core/vault');
const voice = require('./core/voice');
const connectors = require('./core/connectors');
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

  /**
   * One timer for the whole daemon: every 30s, run whatever is due. A job that is
   * already running is skipped, and markRun() records the run so the next tick
   * cannot fire it twice.
   */
  startAutomations() {
    if (this._autoTimer || process.env.LIBER_AUTOMATIONS === 'off') return;
    this._autoRunning = this._autoRunning || new Set();
    this._autoTimer = setInterval(() => { this.tickAutomations().catch(() => {}); }, 30_000);
    if (this._autoTimer.unref) this._autoTimer.unref();
    logger.info('SYSTEM', 'AUTOMATIONS_ARMED', { jobs: automations.list().length });
  }

  async tickAutomations() {
    const agentId = Array.from(this.agents.keys())[0];
    if (!agentId) return;
    const agent = this.agents.get(agentId);
    if (agent?.status === 'RUNNING' && this.queue?.busy?.()) { /* a manual turn owns the queue */ }
    for (const job of automations.list()) {
      if (!job.due) continue;
      if (this._autoRunning.has(job.id)) continue;
      this._autoRunning.add(job.id);
      try {
        logger.info('SYSTEM', 'AUTOMATION_FIRE', { id: job.id, name: job.name });
        const result = await this.queue.run(agentId, () => liberEngine.runTurn({
          agentId,
          memoryKey: `${agentId}#auto:${job.id}`,
          agentConfig: agent.config,
          userMessage: job.prompt,
          memory, llmManager,
          onEvent: () => {},
          maxLoops: this.maxLoops,
          waitForHitl: async () => false
        }));
        automations.markRun(job.id, {
          ok: result?.success !== false,
          chars: String(result?.response || '').length,
          excerpt: result?.response,
          error: result?.success === false ? result.error : null
        });
        logger.info('SYSTEM', 'AUTOMATION_DONE', { id: job.id, ok: result?.success !== false });
      } catch (err) {
        automations.markRun(job.id, { ok: false, error: err.message });
        logger.warn('SYSTEM', 'AUTOMATION_FAILED', { id: job.id, error: err.message });
      } finally {
        this._autoRunning.delete(job.id);
      }
    }
  }

  /**
   * Turn every declared HTTP connector into a tool. Called at boot and on
   * /connectors/reload, so editing connectors.json does not need a restart.
   */
  installConnectors() {
    try {
      const registry = require('./core/registry');
      const out = connectors.install(registry);
      this._connectors = out.installed;
      logger.info('SYSTEM', 'CONNECTORS_INSTALLED', { tools: out.installed, problems: out.problems.length });
      return out;
    } catch (e) {
      logger.warn('SYSTEM', 'CONNECTORS_FAILED', { error: e.message });
      return { installed: [], problems: [e.message] };
    }
  }

  /** Facts a fresh session should not have to discover again. */
  seedStandingFacts(config) {
    try {
      const facts = {
        'workspace.root': process.cwd(),
        'workspace.os': `${process.platform} ${process.arch}`,
        'workspace.user': (() => { try { return require('os').userInfo().username; } catch { return null; } })(),
        'engine.provider': config?.agent?.engine?.provider,
        'engine.model': config?.agent?.engine?.model
      };
      try {
        const { execFileSync } = require('child_process');
        const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: process.cwd(), encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
        if (remote) facts['workspace.remote'] = remote;
      } catch { /* not a git repo: fine */ }
      const added = memoryBank.memorySeed(facts);
      if (added) logger.info('SYSTEM', 'MEMORY_SEEDED', { added });
    } catch (err) {
      logger.warn('SYSTEM', 'MEMORY_SEED_FAILED', { error: err.message });
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

      this.seedStandingFacts(config);
      // Plaintext provider keys move into the encrypted vault on first boot.
      try {
        const mv = vault.migrateCredentials();
        if (mv.moved?.length) logger.info('SYSTEM', 'VAULT_MIGRATED_KEYS', { count: mv.moved.length });
      } catch (e) { logger.warn('SYSTEM', 'VAULT_MIGRATION_FAILED', { error: e.message }); }
      this.startAutomations();
      this.installConnectors();
      // Adopt .liber/daemon.token as the local admin client on first boot.
      try { auth.bootstrap(); } catch (e) { logger.warn('SYSTEM', 'AUTH_BOOTSTRAP_FAILED', { error: e.message }); }
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      // Bind to loopback by default: the daemon has no auth, so exposing it on the LAN
      // would let any device spend the API key or call /shutdown. Override deliberately
      // with LIBER_HOST only behind a trusted proxy.
      const host = process.env.LIBER_HOST || '127.0.0.1';
      // A workspace switch respawns the daemon; the old socket can outlive the old
      // process for a moment, so retry the bind instead of crashing on EADDRINUSE.
      let bindAttempt = 0;
      const bind = () => {
        this.server.listen(this.port, host, () => {
          logger.info('SYSTEM', 'DAEMON_START', { port: this.port, host, cwd: process.cwd() });
        });
      };
      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && bindAttempt < 20) {
          bindAttempt++;
          setTimeout(bind, 300);
          return;
        }
        logger.error('SYSTEM', 'BIND_FAILED', { error: err.message });
        process.exit(1);
      });
      bind();
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

    // Every request is resolved to a client, then checked for scope and rate.
    const requestStart = Date.now();
    const client = auth.verify(auth.extract(req));
    if (!client) {
      res.statusCode = 401;
      res.end(JSON.stringify({
        success: false,
        error: 'Unauthorized. Send Authorization: Bearer <token>. The desktop token lives in .liber/daemon.token; other clients get their own from /clients (scope admin).'
      }));
      logger.warn('SYSTEM', 'AUTH_FAILED', { endpoint, ip: req.socket.remoteAddress });
      auth.audit({ client: null, ip: req.socket.remoteAddress, method: req.method, endpoint, decision: 'deny', reason: 'bad token' });
      return;
    }
    const needed = auth.scopeFor(req.method, endpoint);
    if (!auth.can(client, needed)) {
      res.statusCode = 403;
      res.end(JSON.stringify({
        success: false,
        error: `Client '${client.id}' lacks the '${needed}' scope for ${req.method} ${endpoint}.`,
        scopes: client.scopes,
        required: needed
      }));
      auth.audit({ client: client.id, method: req.method, endpoint, decision: 'deny', reason: 'scope ' + needed });
      return;
    }
    const limited = auth.rateLimit(client);
    if (!limited.allowed) {
      res.statusCode = 429;
      res.setHeader('retry-after', Math.ceil(limited.retryAfterMs / 1000));
      res.end(JSON.stringify({
        success: false,
        error: `Rate limit reached for '${client.id}' (${limited.limit}/min). Retry in ${Math.ceil(limited.retryAfterMs / 1000)}s.`,
        retry_after_ms: limited.retryAfterMs
      }));
      auth.audit({ client: client.id, method: req.method, endpoint, decision: 'deny', reason: 'rate limit' });
      return;
    }
    auth.touch(client);
    res.on('finish', () => auth.audit({
      client: client.id,
      method: req.method,
      endpoint,
      status: res.statusCode,
      scope: needed,
      ms: Date.now() - requestStart
    }));

    try {
      if (endpoint === '/clients' || endpoint === '/clients/rotate' || endpoint === '/clients/audit') {
        if (endpoint === '/clients' && req.method === 'GET') {
          res.end(JSON.stringify({ success: true, clients: auth.list(), scopes: auth.SCOPES }));
          return;
        }
        if (endpoint === '/clients' && req.method === 'POST') {
          let b = ''; for await (const ch of req) b += ch;
          const body = JSON.parse(b || '{}');
          const out = auth.create(body.label, { scopes: body.scopes, perMin: body.perMin });
          // The token is in this response and nowhere else, ever.
          res.statusCode = out.ok ? 200 : 400;
          res.end(JSON.stringify({ success: out.ok, ...out, clients: auth.list() }));
          return;
        }
        if (endpoint === '/clients' && req.method === 'DELETE') {
          const out = auth.revoke(String(url.searchParams.get('id') || ''));
          res.statusCode = out.ok ? 200 : 400;
          res.end(JSON.stringify({ success: out.ok, ...out, clients: auth.list() }));
          return;
        }
        if (endpoint === '/clients/rotate') {
          let b = ''; for await (const ch of req) b += ch;
          const body = JSON.parse(b || '{}');
          const out = auth.rotate(String(body.id || ''));
          res.statusCode = out.ok ? 200 : 400;
          res.end(JSON.stringify({ success: out.ok, ...out, clients: auth.list() }));
          return;
        }
        if (endpoint === '/clients/audit') {
          let lines = [];
          try {
            lines = require('fs').readFileSync(path.join(process.cwd(), '.liber', 'auth-audit.log'), 'utf8')
              .trim().split('\n').filter(Boolean).slice(-Number(url.searchParams.get('tail') || 40))
              .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          } catch { }
          res.end(JSON.stringify({ success: true, entries: lines }));
          return;
        }
        res.statusCode = 405;
        res.end(JSON.stringify({ success: false, error: 'Method not allowed.' }));
        return;
      }
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
        if (req.method === 'DELETE') {
          const id = url.searchParams.get('agentId');
          const targets = id ? [id] : journal.list().map(t => t.agentId).filter(Boolean);
          for (const t of targets) journal.clear(t);
          res.end(JSON.stringify({ success: true, cleared: targets.length }));
          return;
        }
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
          maxLoops: this.maxLoops,
          waitForHitl: (aid, toolName, args) => this.waitForHitl(aid, `${toolName}: ${JSON.stringify(args)}`)
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
      else if (endpoint === '/sessions/history') {
        // The window keeps rendered HTML in memory only, so after a restart a
        // session looked empty while its messages were still on disk. This
        // endpoint is what makes a session reopenable.
        const key = url.searchParams.get('key');
        if (!key) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Missing key.' }));
          return;
        }
        const messages = (memory.get(key) || []).map(m => ({
          role: m.role,
          content: String(m.content || ''),
          ts: m.ts || null
        }));
        const firstUser = messages.find(m => m.role === 'user' && !/^(OBSERVATION \[E|STOP —|You have at most|You returned an empty response|Your reply contained no \[FINAL|DENIED: approval|GROUNDING AUDIT|Your previous answer)/.test(m.content));
        res.end(JSON.stringify({
          success: true,
          key,
          title: firstUser ? firstUser.content.replace(/\s+/g, ' ').slice(0, 60) : null,
          messages
        }));
        return;
      }
      else if (endpoint === '/sessions/search') {
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        if (!q) {
          res.end(JSON.stringify({ success: true, q, hits: [] }));
          return;
        }
        const hits = [];
        for (const [key, messages] of memory.history?.entries() || []) {
          for (const m of messages) {
            const text = String(m.content || '');
            const at = text.toLowerCase().indexOf(q);
            if (at < 0) continue;
            hits.push({
              key,
              role: m.role,
              snippet: text.slice(Math.max(0, at - 40), at + 90).replace(/\s+/g, ' ').trim(),
              at
            });
            if (hits.length >= 60) break;
          }
          if (hits.length >= 60) break;
        }
        res.end(JSON.stringify({ success: true, q, hits }));
        return;
      }
      else if (endpoint === '/sessions') {
        if (req.method === 'GET') {
          const overview = {};
          for (const [agentId, messages] of memory.history?.entries() || []) {
            const assistant = messages.filter(m => m.role === 'assistant');
            const noise = /^(OBSERVATION \[E|STOP —|You have at most|You returned an empty response|Your reply contained no \[FINAL|DENIED: approval|GROUNDING AUDIT|Your previous answer)/;
            const firstUser = messages.find(m => m.role === 'user' && !noise.test(String(m.content || '')));
            overview[agentId] = {
              messages: messages.length,
              title: firstUser ? String(firstUser.content).replace(/\s+/g, ' ').slice(0, 60) : null,
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
          // ?key=agent#session drops one session; without it the whole store goes.
          const key = url.searchParams.get('key');
          if (key) {
            memory.clear(key);
            res.end(JSON.stringify({ success: true, cleared: key }));
            return;
          }
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
      else if (endpoint === '/providers') {
        res.end(JSON.stringify({
          success: true,
          ...providers.status(),
          imports: providers.imports(),
          store: providers.storePath()
        }));
      }
      else if (endpoint === '/providers/key') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { id, key } = JSON.parse(body || '{}');
        const r = providers.setKey(id, key);
        if (!r.ok) { res.statusCode = 400; res.end(JSON.stringify({ success: false, error: r.error })); return; }
        res.end(JSON.stringify({ success: true, id: r.id, hint: r.hint }));
      }
      else if (endpoint === '/providers/clear') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { id } = JSON.parse(body || '{}');
        const r = providers.clear(id);
        res.end(JSON.stringify({ success: r.ok, error: r.error || null }));
      }
      else if (endpoint === '/providers/custom') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const r = providers.setCustom(JSON.parse(body || '{}'));
        if (!r.ok) { res.statusCode = 400; res.end(JSON.stringify({ success: false, error: r.error })); return; }
        res.end(JSON.stringify({ success: true, id: r.id }));
      }
      else if (endpoint === '/providers/test') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { id, key } = JSON.parse(body || '{}');
        res.end(JSON.stringify({ success: true, result: await providers.test(id, { key }) }));
      }
      else if (endpoint === '/providers/import') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { id } = JSON.parse(body || '{}');
        const r = providers.importFrom(id);
        if (!r.ok) { res.statusCode = 400; res.end(JSON.stringify({ success: false, error: r.error })); return; }
        res.end(JSON.stringify({ success: true, imported: r.id, via: r.via, hint: r.hint, expires_at: r.expires_at }));
      }
      else if (endpoint === '/providers/oauth/start') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const r = await providers.deviceStart(JSON.parse(body || '{}'));
        if (!r.ok) { res.statusCode = 400; res.end(JSON.stringify({ success: false, error: r.error })); return; }
        res.end(JSON.stringify({ success: true, ...r }));
      }
      else if (endpoint === '/providers/oauth/poll') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const r = await providers.devicePoll(JSON.parse(body || '{}'));
        res.end(JSON.stringify({ success: !!r.ok, ...r }));
      }
      else if (endpoint === '/workspace') {
        res.end(JSON.stringify({ success: true, workspace: workspace.summary(), activity: workspace.recent(20) }));
      }
      else if (endpoint === '/git') {
        // Real repository state: local branches, the origin URL and how far the
        // branch has drifted from its upstream. No cached guesses.
        res.end(JSON.stringify({
          success: true,
          ...workspace.gitState(),
          github_url: workspace.githubUrl()
        }));
      }
      else if (endpoint === '/git/checkout') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { branch: target } = JSON.parse(body || '{}');
        const r = workspace.checkout(target);
        res.statusCode = r.ok ? 200 : 400;
        res.end(JSON.stringify({ success: r.ok, ...r }));
      }
      else if (endpoint === '/git/fetch') {
        const r = workspace.fetchRemote();
        res.statusCode = r.ok ? 200 : 400;
        res.end(JSON.stringify({ success: r.ok, ...r }));
      }
      else if (endpoint === '/workspace/switch') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const requested = String(JSON.parse(body || '{}').path || '').trim();
        if (!requested) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Missing path.' }));
          return;
        }
        const target = path.resolve(requested);
        let stat = null;
        try { stat = fs.statSync(target); } catch { /* reported below */ }
        if (!stat || !stat.isDirectory()) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: `Not a directory: ${target}` }));
          return;
        }

        // The daemon is rooted at its own cwd, so switching workspaces means
        // restarting it there. The config file stays the one this daemon booted
        // with (absolute path via LIBER_CONFIG) so the model and policy survive.
        const configPath = path.resolve(process.cwd(), process.env.LIBER_CONFIG || 'liber.yaml');
        const stateDir = path.join(target, '.liber');
        let copiedKeys = false;
        try {
          fs.mkdirSync(stateDir, { recursive: true });
          const src = path.resolve(process.cwd(), '.liber', 'credentials.json');
          const dst = path.join(stateDir, 'credentials.json');
          // Keys follow the app, not the folder: a new workspace with no store of
          // its own inherits the configured providers instead of silently losing them.
          if (fs.existsSync(src) && !fs.existsSync(dst)) {
            fs.copyFileSync(src, dst);
            try { fs.chmodSync(dst, 0o600); } catch { /* best effort on Windows */ }
            copiedKeys = true;
          }
        } catch (err) {
          logger.warn('SYSTEM', 'WORKSPACE_STATE_PREP_FAILED', { error: err.message });
        }

        const entry = path.resolve(__dirname, '..', '..', 'bin', 'liberd-entry');
        res.end(JSON.stringify({ success: true, switching: true, cwd: target, keys_copied: copiedKeys, config: configPath }));

        // Give the response a moment to flush before the process goes away.
        setTimeout(() => {
          const { spawn } = require('child_process');
          const child = spawn(process.execPath, [entry], {
            cwd: target,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, LIBER_CONFIG: configPath }
          });
          child.unref();
          logger.info('SYSTEM', 'WORKSPACE_SWITCH', { from: process.cwd(), to: target });
          setTimeout(() => process.exit(0), 250);
        }, 120);
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
      else if (endpoint === '/sandbox') {
        if (req.method === 'GET') {
          const term = policy.terminalConfig();
          const terminalTool = require('./core/tools/terminal-tool');
          const dockerOk = terminalTool.containerAvailable(true);
          let dockerVersion = null;
          if (dockerOk) {
            try {
              dockerVersion = String(require('child_process').execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 8000, windowsHide: true })).trim();
            } catch { dockerVersion = null; }
          }
          let wsl = false;
          try {
            const out = require('child_process').execFileSync('wsl.exe', ['-l', '-q'], { timeout: 8000, windowsHide: true });
            wsl = String(out).replace(/\0/g, '').trim().length > 0;
          } catch { wsl = false; }
          res.end(JSON.stringify({
            success: true,
            backend: term.backend,
            sandbox: term.sandbox,
            capabilities: {
              'constrained-language': process.platform === 'win32',
              docker: dockerOk,
              wsl,
              'windows-sandbox': false
            },
            docker: { available: dockerOk, server: dockerVersion, image: term.image, network: term.allow_network === true, memory: term.memory, pids: term.pids },
            note: dockerOk
              ? 'Commands run in a container with no network, a read-only root and only the workspace mounted.'
              : 'Docker is not reachable, so commands fall back to PowerShell Constrained Language Mode (not a container).'
          }));
          return;
        }
        res.statusCode = 405;
        res.end(JSON.stringify({ success: false, error: 'Method not allowed.' }));
        return;
      }
      else if (endpoint === '/connectors' || endpoint === '/connectors/reload') {
        if (endpoint === '/connectors/reload') {
          const out = this.installConnectors();
          res.end(JSON.stringify({ success: true, ...out, connectors: connectors.load().connectors.map(c => ({ id: c.id, label: c.label, actions: c.actions.map(a => a.name) })) }));
          return;
        }
        const parsed = connectors.load();
        res.end(JSON.stringify({
          success: true,
          file: connectors.FILE(),
          connectors: parsed.connectors.map(c => ({ id: c.id, label: c.label, baseUrl: c.baseUrl, actions: c.actions.map(a => ({ name: a.name, method: a.method, path: a.path, description: a.description })) })),
          problems: parsed.problems
        }));
        return;
      }
      else if (endpoint === '/voice' || endpoint === '/voice/speak') {
        if (endpoint === '/voice' && req.method === 'GET') {
          const voices = await voice.voices();
          res.end(JSON.stringify({ success: true, available: voice.available(), voices, audioDir: voice.AUDIO_DIR() }));
          return;
        }
        if (endpoint === '/voice/speak' && req.method === 'POST') {
          let b = ''; for await (const ch of req) b += ch;
          const body = JSON.parse(b || '{}');
          const out = await voice.speak(body.text, { voice: body.voice, rate: body.rate, play: body.play !== false });
          logger.info('SYSTEM', 'VOICE_SPEAK', { ok: out.ok, bytes: out.bytes || 0 });
          res.statusCode = out.ok ? 200 : 400;
          res.end(JSON.stringify({ success: out.ok, ...out }));
          return;
        }
        res.statusCode = 405;
        res.end(JSON.stringify({ success: false, error: 'Method not allowed.' }));
        return;
      }
      else if (endpoint === '/vault' || endpoint === '/vault/migrate') {
        const readBody = async () => { let b = ''; for await (const ch of req) b += ch; return JSON.parse(b || '{}'); };
        if (endpoint === '/vault' && req.method === 'GET') {
          res.end(JSON.stringify({ success: true, entries: vault.list(), status: vault.status() }));
          return;
        }
        if (endpoint === '/vault' && req.method === 'POST') {
          const body = await readBody();
          // A value goes in and never comes back out through this route.
          const out = vault.set(body.name, body.value, body.meta || {});
          res.statusCode = out.ok ? 200 : 400;
          res.end(JSON.stringify({ success: out.ok, ...out, entries: vault.list() }));
          return;
        }
        if (endpoint === '/vault' && req.method === 'DELETE') {
          const out = vault.remove(String(url.searchParams.get('name') || ''));
          res.statusCode = out.ok ? 200 : 404;
          res.end(JSON.stringify({ success: out.ok, ...out, entries: vault.list() }));
          return;
        }
        if (endpoint === '/vault/migrate') {
          const out = vault.migrateCredentials();
          logger.info('SYSTEM', 'VAULT_MIGRATION', { moved: out.moved });
          res.end(JSON.stringify({ success: out.ok, ...out, entries: vault.list() }));
          return;
        }
        res.statusCode = 405;
        res.end(JSON.stringify({ success: false, error: 'Method not allowed.' }));
        return;
      }
      else if (endpoint === '/automations' || endpoint === '/automations/update' || endpoint === '/automations/run') {
        const readBody = async () => { let b = ''; for await (const ch of req) b += ch; return JSON.parse(b || '{}'); };
        if (endpoint === '/automations' && req.method === 'GET') {
          res.end(JSON.stringify({ success: true, jobs: automations.list() }));
          return;
        }
        if (endpoint === '/automations' && req.method === 'POST') {
          const created = automations.create(await readBody());
          res.statusCode = created.ok ? 200 : 400;
          res.end(JSON.stringify({ success: created.ok, ...created, jobs: automations.list() }));
          return;
        }
        if (endpoint === '/automations/update') {
          const body = await readBody();
          const out = automations.update(String(body.id || ''), body.patch || body);
          res.statusCode = out.ok ? 200 : 400;
          res.end(JSON.stringify({ success: out.ok, ...out, jobs: automations.list() }));
          return;
        }
        if (endpoint === '/automations/run') {
          const body = await readBody();
          const id = String(body.id || url.searchParams.get('id') || '');
          const job = automations.list().find(j => j.id === id);
          if (!job) { res.statusCode = 404; res.end(JSON.stringify({ success: false, error: 'No such automation.' })); return; }
          const agentId = Array.from(this.agents.keys())[0];
          const agent = this.agents.get(agentId);
          try {
            const result = await this.queue.run(agentId, () => liberEngine.runTurn({
              agentId,
              memoryKey: `${agentId}#auto:${job.id}`,
              agentConfig: agent.config,
              userMessage: job.prompt,
              memory, llmManager,
              onEvent: () => {},
              maxLoops: this.maxLoops,
              waitForHitl: async () => false
            }));
            automations.markRun(job.id, {
              ok: result?.success !== false,
              chars: String(result?.response || '').length,
              excerpt: result?.response,
              error: result?.success === false ? result.error : null
            });
            res.end(JSON.stringify({ success: true, response: String(result?.response || '').slice(0, 400), jobs: automations.list() }));
          } catch (err) {
            automations.markRun(job.id, { ok: false, error: err.message });
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: err.message, jobs: automations.list() }));
          }
          return;
        }
        if (endpoint === '/automations' && req.method === 'DELETE') {
          const id = url.searchParams.get('id');
          const out = automations.remove(String(id || ''));
          res.statusCode = out.ok ? 200 : 404;
          res.end(JSON.stringify({ success: out.ok, ...out, jobs: automations.list() }));
          return;
        }
        res.statusCode = 405;
        res.end(JSON.stringify({ success: false, error: 'Method not allowed.' }));
        return;
      }
      else if (endpoint === '/memory') {
        // The same store the agent's memory tool writes to, exposed so the
        // window can show what a new session will already know.
        if (req.method === 'GET') {
          res.end(JSON.stringify({
            success: true,
            entries: memoryBank.memoryEntries(),
            block: memoryBank.memoryBlock(1400),
            chars: memoryBank.memoryBlock(1400).length
          }));
          return;
        }
        if (req.method === 'DELETE') {
          const key = url.searchParams.get('key');
          if (!key) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: 'Missing key.' }));
            return;
          }
          const out = memoryBank.manageMemory({ action: 'delete', key });
          res.end(JSON.stringify({ success: true, deleted: key, ...out }));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || '{}');
        const key = String(parsed.key || '').trim();
        if (!key) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Missing key.' }));
          return;
        }
        const written = memoryBank.manageMemory({ action: 'set', key, value: parsed.value ?? '' });
        res.end(JSON.stringify({ success: true, ...written, entries: memoryBank.memoryEntries() }));
        return;
      }
      else if (endpoint === '/budget') {
        const first = Array.from(this.agents.values())[0];
        const limits = first?.config?.limits || {};
        const engine = first?.config?.engine || {};
        if (req.method === 'POST') {
          // Reset today's counter so a blocked day can be resumed without
          // editing JSON on disk.
          let body = '';
          for await (const chunk of req) body += chunk;
          const action = String(JSON.parse(body || '{}').action || 'reset');
          if (action === 'reset') budget.reset();
          res.end(JSON.stringify({ success: true, action, budget: budget.summary(limits, engine) }));
          return;
        }
        res.end(JSON.stringify({ success: true, budget: budget.summary(limits, engine) }));
        return;
      }
      else if (endpoint === '/budget/limit') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || '{}');
        const tokens = Number(parsed.tokens);
        if (!Number.isFinite(tokens) || tokens < 0) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'tokens must be a number >= 0 (0 = no limit).' }));
          return;
        }
        const { changes, error } = configApply.validateConfigUpdate({ 'limits.max_tokens_per_day': tokens });
        if (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error }));
          return;
        }
        for (const [, agent] of this.agents.entries()) {
          for (const [p, value] of Object.entries(changes)) this.applyConfigPath(agent, p, value);
        }
        this.persistConfigChanges(changes);
        const first = Array.from(this.agents.values())[0];
        res.end(JSON.stringify({
          success: true,
          limit_tokens: tokens,
          budget: budget.summary(first?.config?.limits || {}, first?.config?.engine || {})
        }));
        return;
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
      else if (endpoint === '/chat/stream' || endpoint === '/resume/stream') {
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
        const parsed = JSON.parse(body || '{}');
        let agentId = parsed.agentId || Array.from(this.agents.keys())[0];
        const { sessionId, message } = parsed;

        // The window can hang up mid-turn (stop button, closed app). Stop spending
        // tokens between iterations instead of finishing a reply nobody will see.
        let clientGone = false;
        res.on('close', () => { if (!res.writableEnded) clientGone = true; });
        const shouldStop = () => clientGone;

        if (!this.agents.has(agentId)) {
          sendEvent('error', { error: `Agent ${agentId} not found` });
          res.end();
          return;
        }

        const agent = this.agents.get(agentId);

        if (endpoint === '/resume/stream') {
          try {
            const result = await this.queue.run(agentId, () => liberEngine.resume(agentId, {
              agentConfig: agent.config,
              memory,
              llmManager,
              onEvent: sendEvent,
              maxLoops: this.maxLoops,
              shouldStop,
              waitForHitl: (aid, toolName, args) => this.waitForHitl(aid, `${toolName}: ${JSON.stringify(args)}`)
            }));
            if (result && result.success === false) sendEvent('error', { error: result.error });
            else if (this.traceEnabled && result && result.response) {
              trace.appendTurn({ agentId, userMessage: '(resumed turn)', result, model: agent.config.engine?.model });
            }
          } catch (err) {
            sendEvent('error', { error: err.message });
          }
          res.end();
          return;
        }

        // A session is its own history key; omitting sessionId keeps the old behaviour.
        const memoryKey = sessionId ? `${agentId}#${sessionId}` : agentId;
        try {
          const result = await this.queue.run(agentId, () => liberEngine.runTurn({
            agentId,
            memoryKey,
            agentConfig: agent.config,
            userMessage: message,
            memory,
            llmManager,
            onEvent: sendEvent,
            waitForHitl: (aid, toolName, args) => this.waitForHitl(aid, `${toolName}: ${JSON.stringify(args)}`),
            maxLoops: this.maxLoops,
            shouldStop
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
        const { agentId, sessionId, message } = JSON.parse(body || '{}');

        if (!this.agents.has(agentId)) throw new Error(`Agent ${agentId} not found`);
        const agent = this.agents.get(agentId);
        const memoryKey = sessionId ? `${agentId}#${sessionId}` : agentId;

        const result = await this.queue.run(agentId, () => liberEngine.runTurn({
          agentId,
          memoryKey,
          agentConfig: agent.config,
          userMessage: message,
          memory,
          llmManager,
          // This endpoint answers with one JSON body, so there is no channel to
          // ask a human: it fails closed. A command that needs approval is
          // refused and the reply reports the denial. Use /chat/stream when the
          // client can show a prompt and POST /hitl/verdict.
          waitForHitl: () => Promise.resolve(false),
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
    // a headless browser must not outlive the daemon that started it
    try { require('./core/tools/browser-tool').close(); } catch { /* not launched */ }
    if (this._autoTimer) { clearInterval(this._autoTimer); this._autoTimer = null; }
  }
}

module.exports = new LiberDaemon();

