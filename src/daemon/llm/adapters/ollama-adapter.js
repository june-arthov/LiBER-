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

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 300) || response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    const handleLine = (raw) => {
      const line = raw.trim();
      if (!line) return;
      try {
        const json = JSON.parse(line);
        if (json.message?.content) {
          full += json.message.content;
          onChunk(json.message.content);
        }
        if (json.eval_count && !this.lastUsage) {
          this.lastUsage = { prompt_tokens: json.prompt_eval_count || 0, completion_tokens: json.eval_count, total_tokens: (json.prompt_eval_count || 0) + json.eval_count };
        }
      } catch {
        // incomplete JSON line: the buffer will complete it on the next read
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    }

    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);

    return full;
  }
}

module.exports = OllamaAdapter;
