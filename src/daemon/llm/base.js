// src/daemon/llm/base.js
/**
 * Base LLM Adapter
 * Semua provider LLM harus mengimplementasikan class ini.
 */
class LLMAdapter {
  constructor(config) {
    this.config = config;
  }

  /**
   * Mengirim prompt dan menerima respon teks tunggal.
   * @param {Array} messages - Format: [{ role: 'user', content: '...' }]
   * @param {Object} options - Parameter tambahan (temperature, max_tokens, dll)
   */
  async generate(messages, options = {}) {
    throw new Error("Method 'generate()' must be implemented.");
  }

  /**
   * Mengirim prompt dan menerima respon secara streaming.
   * @param {Array} messages 
   * @param {Function} onChunk - Callback untuk setiap potongan teks yang diterima.
   * @param {Object} options 
   */
  async stream(messages, onChunk, options = {}) {
    throw new Error("Method 'stream()' must be implemented.");
  }
}

module.exports = LLMAdapter;
