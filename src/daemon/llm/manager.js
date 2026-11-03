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
    this.activeAdapter = new ProviderClass(config);
    return this.activeAdapter;
  }

  async generate(messages, options = {}) {
    if (!this.activeAdapter) throw new Error("LLM Engine not initialized. Call initialize() first.");
    return this.activeAdapter.generate(messages, options);
  }

  async stream(messages, onChunk, options = {}) {
    if (!this.activeAdapter) throw new Error("LLM Engine not initialized. Call initialize() first.");
    return this.activeAdapter.stream(messages, onChunk, options);
  }
}

module.exports = new LLMManager();
