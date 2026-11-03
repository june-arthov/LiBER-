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
    this.lastUsage = data.usage || null;
    return data.choices[0].message.content;
  }

  /**
   * Native tool calling (OpenAI-compatible). Returns the assistant message fields.
   */
  async chat(messages, options = {}) {
    const body = {
      model: this.config.model,
      messages: messages,
      temperature: options.temperature ?? this.config.temperature ?? 0.7,
      max_tokens: options.max_tokens || this.config.max_tokens || undefined,
      stream: false
    };
    const effort = options.reasoning_effort ?? this.config.reasoning_effort;
    if (effort && effort !== 'auto') body.reasoning_effort = effort;
    if (Array.isArray(options.tools) && options.tools.length) {
      body.tools = options.tools;
      body.tool_choice = options.tool_choice || 'auto';
    }

    const response = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.choices) {
      throw new Error('HTTP ' + response.status + ': ' + (data.error?.message || data.error || response.statusText));
    }

    this.lastUsage = data.usage || null;
    const msg = data.choices[0].message || {};
    return {
      content: msg.content || '',
      tool_calls: Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : null,
      finish_reason: data.choices[0].finish_reason || null
    };
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
        stream: true,
        // Ask the provider to emit a final usage chunk (OpenAI-compatible).
        stream_options: this.config.stream_usage === false ? undefined : { include_usage: true }
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
      if (!line || line === 'data: [DONE]' || !line.startsWith('data:')) return;
      try {
        const json = JSON.parse(line.slice(5).trim());
        if (json.usage) this.lastUsage = json.usage;
        const content = json.choices?.[0]?.delta?.content;
        if (content) {
          full += content;
          onChunk(content);
        }
      } catch {
        // incomplete JSON line: the buffer will complete it on the next read
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Buffer across reads: a JSON line can be split by the network.
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

module.exports = OpenAIAdapter;

