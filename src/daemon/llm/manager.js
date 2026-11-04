// src/daemon/llm/manager.js
const OllamaAdapter = require('./adapters/ollama-adapter');
const OpenAIAdapter = require('./adapters/openai-adapter');
const AnthropicAdapter = require('./adapters/anthropic-adapter');
const GeminiAdapter = require('./adapters/gemini-adapter');

class LLMManager {
  constructor() {
    this.adapters = {
      ollama: OllamaAdapter,
      openai: OpenAIAdapter,
      anthropic: AnthropicAdapter,
      gemini: GeminiAdapter
      // Provider baru tinggal ditambahkan di sini
    };
    this.activeAdapter = null;
    this.retry = { attempts: 3, baseMs: 700 };
  }

  /**
   * Inisialisasi adapter berdasarkan konfigurasi di liber.yaml
   * @param {Object} config - Bagian 'engine' dari liber.yaml
   */
  initialize(config) {
    this.engineConfig = { ...config };
    const ProviderClass = this.adapters[config.provider];
    if (!ProviderClass) {
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
    }
    
    console.log(`[Liber-Daemon] Initializing LLM engine: ${config.provider} (${config.model})`);
    this.retry = {
      attempts: Math.max(1, Math.min(parseInt(config.retry_attempts, 10) || 3, 6)),
      baseMs: Math.max(100, parseInt(config.retry_base_ms, 10) || 700)
    };
    this.activeAdapter = new ProviderClass(config);
    return this.activeAdapter;
  }

  isRetryable(err) {
    const msg = String(err?.message || '');
    if (/HTTP (400|401|403|404|422)\b/.test(msg)) return false; // client errors: retrying cannot help
    return /HTTP (429|5\d\d)|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|network|socket hang up|aborted/i.test(msg);
  }

  /**
   * Retry the same request on the next model of the SAME provider/endpoint.
   * That is all a single-key setup can do: same base URL and key, different
   * model id, so a dead or over-quota model does not kill the turn.
   */
  async _withModelFallback(fn, canRetry = () => true) {
    const base = this.engineConfig || {};
    const chain = [base.model, ...(Array.isArray(base.fallback_models) ? base.fallback_models : [])]
      .map(m => String(m || '').trim())
      .filter((m, i, all) => m && all.indexOf(m) === i);
    let index = 0;
    let lastErr;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const next = chain[index + 1];
        if (!next || !canRetry()) break;
        try {
          this.initialize({ ...base, model: next });
        } catch (initErr) {
          lastErr = initErr;
          break;
        }
        this.lastFallback = { from: chain[index], to: next, error: String(err && err.message || err).slice(0, 200), at: Date.now() };
        if (typeof this.onFallback === 'function') { try { this.onFallback(this.lastFallback); } catch { /* never break a turn */ } }
        index++;
      }
    }
    throw lastErr;
  }

  async generate(messages, options = {}) {
    if (!this.activeAdapter) throw new Error("LLM Engine not initialized. Call initialize() first.");
    return this._withModelFallback(() => this._withRetry(() => this.activeAdapter.generate(messages, options)));
  }

  /**
   * Native tool calling: returns { content, tool_calls, finish_reason }.
   */
  async generateChat(messages, options = {}) {
    if (!this.activeAdapter) throw new Error("LLM Engine not initialized. Call initialize() first.");
    if (typeof this.activeAdapter.chat !== 'function') {
      throw new Error('Active adapter does not support native tool calling.');
    }
    return this._withModelFallback(() => this._withRetry(() => this.activeAdapter.chat(messages, options)));
  }

  async _withRetry(fn) {
    let lastErr;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const canRetry = attempt < this.retry.attempts && this.isRetryable(err);
        if (!canRetry) throw err;
        const wait = Math.min(this.retry.baseMs * 2 ** (attempt - 1), 8000);
        console.warn(`[Liber-Daemon] LLM error (${err.message}) — retry ${attempt}/${this.retry.attempts} in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  getLastUsage() {
    return this.activeAdapter?.lastUsage || null;
  }

  /** Chain of thought the provider returned on the most recent call, if any. */
  getLastReasoning() {
    return this.activeAdapter?.lastReasoning || null;
  }

  async stream(messages, onChunk, options = {}) {
    if (!this.activeAdapter) throw new Error("LLM Engine not initialized. Call initialize() first.");
    if (typeof this.activeAdapter.stream !== 'function') {
      throw new Error('Active adapter does not support streaming.');
    }
    // A stream that already emitted text cannot be replayed: falling back would
    // duplicate the partial answer, so retry only while nothing was sent.
    let emitted = false;
    const guard = (t) => { emitted = true; onChunk(t); };
    return this._withModelFallback(() => this.activeAdapter.stream(messages, guard, options), () => !emitted);
  }
}

module.exports = new LLMManager();
