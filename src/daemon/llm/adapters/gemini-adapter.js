// src/daemon/llm/adapters/gemini-adapter.js — Google Gemini generateContent API.
// Translates Liber's conversation into contents/systemInstruction. Native tool
// calling is not implemented: the engine falls back to the text protocol.
const LLMAdapter = require('../base');

class GeminiAdapter extends LLMAdapter {
  constructor(config) {
    super(config);
    if (!this.config.endpoint) this.config.endpoint = 'https://generativelanguage.googleapis.com';
  }

  buildBody(messages, options = {}) {
    let system = '';
    const contents = [];
    let lastRole = null;

    for (const m of messages) {
      const text = String(m.content ?? '');
      if (m.role === 'system') {
        system += (system ? '\n\n' : '') + text;
        continue;
      }
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (role === lastRole) {
        const prev = contents[contents.length - 1];
        prev.parts.push({ text });
      } else {
        contents.push({ role, parts: [{ text }] });
        lastRole = role;
      }
    }

    const body = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? this.config.temperature ?? 0.7,
        maxOutputTokens: options.max_tokens || this.config.max_tokens || 4096
      }
    };
    if (system) body.systemInstruction = { parts: [{ text: system.slice(0, 12000) }] };
    return body;
  }

  endpoint(path) {
    return `${String(this.config.endpoint).replace(/\/+$/, '')}${path}`;
  }

  async generate(messages, options = {}) {
    const response = await fetch(
      `${this.endpoint('/v1beta/models/')}${this.config.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.config.apiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify(this.buildBody(messages, options))
      }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${data.error?.message || data.error || response.statusText}`);
    }

    const usage = data.usageMetadata;
    if (usage) {
      this.lastUsage = {
        prompt_tokens: usage.promptTokenCount || 0,
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0)
      };
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.filter(p => typeof p.text === 'string').map(p => p.text).join('');
  }

  async stream(messages, onChunk, options = {}) {
    const response = await fetch(
      `${this.endpoint('/v1beta/models/')}${this.config.model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.config.apiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify(this.buildBody(messages, options))
      }
    );

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
      if (!line || !line.startsWith('data:')) return;
      try {
        const json = JSON.parse(line.slice(5).trim());
        for (const part of json.candidates?.[0]?.content?.parts || []) {
          if (typeof part.text === 'string' && part.text) {
            full += part.text;
            onChunk(part.text);
          }
        }
        const usage = json.usageMetadata;
        if (usage) {
          this.lastUsage = {
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0)
          };
        }
      } catch { /* incomplete line */ }
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

module.exports = GeminiAdapter;
