// src/daemon/llm/adapters/ollama-adapter.js
const LLMAdapter = require('../base');

class OllamaAdapter extends LLMAdapter {
  async generate(messages, options = {}) {
    const response = await fetch(`${this.config.endpoint}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: this.config.model,
        messages: messages,
        stream: false,
        options: options
      })
    });
    const data = await response.json();
    return data.message.content;
  }

  async stream(messages, onChunk, options = {}) {
    const response = await fetch(`${this.config.endpoint}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: this.config.model,
        messages: messages,
        stream: true,
        options: options
      })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message && json.message.content) {
            onChunk(json.message.content);
          }
          if (json.done) return;
        } catch (e) {
          // Handle partial JSON chunks
        }
      }
    }
  }
}

module.exports = OllamaAdapter;
