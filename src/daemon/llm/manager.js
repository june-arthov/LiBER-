// src/daemon/llm/manager.js
const OllamaAdapter = require('./adapters/ollama-adapter');
const OpenAIAdapter = require('./adapters/openai-adapter');

class LLMManager {
  constructor() {
    this.adapters = {
      ollama: OllamaAdapter,
      openai: OpenAIAdapter,
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

  async generate(messages, options = {}) {
    if (!this.activeAdapter) throw new Error("LLM Engine not initialized. Call initialize() first.");

    let lastErr;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      try {
        return await this.activeAdapter.generate(messages, options);
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

  async stream(messages, onChunk, options = {}) {
    if (!this.activeAdapter) throw new Error("LLM Engine not initialized. Call initialize() first.");
    if (typeof this.activeAdapter.stream !== 'function') {
      throw new Error('Active adapter does not support streaming.');
    }
    return this.activeAdapter.stream(messages, onChunk, options);
  }
}

module.exports = new LLMManager();
