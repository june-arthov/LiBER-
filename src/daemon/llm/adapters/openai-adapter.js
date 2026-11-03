// src/daemon/llm/adapters/openai-adapter.js
const LLMAdapter = require('../base');

class OpenAIAdapter extends LLMAdapter {
  async generate(messages, options = {}) {
    const response = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: messages,
        temperature: options.temperature ?? this.config.temperature ?? 0.7,
        max_tokens: options.max_tokens || this.config.max_tokens || undefined,
        stream: false
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.choices) {
      throw new Error('HTTP ' + response.status + ': ' + (data.error?.message || data.error || response.statusText));
    }
    return data.choices[0].message.content;
  }

  async stream(messages, onChunk, options = {}) {
    const response = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: messages,
        temperature: options.temperature ?? this.config.temperature ?? 0.7,
        max_tokens: options.max_tokens || this.config.max_tokens || undefined,
        stream: true
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 300) || response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.substring(6));
            const content = json.choices[0]?.delta?.content;
            if (content) onChunk(content);
          } catch (e) {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    }
  }
}

module.exports = OpenAIAdapter;

