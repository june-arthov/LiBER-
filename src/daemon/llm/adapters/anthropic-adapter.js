// src/daemon/llm/adapters/anthropic-adapter.js — Anthropic Messages API.
// Translates Liber's OpenAI-shaped conversation (system/user/assistant/tool roles,
// tool_calls blocks) into Anthropic content blocks and back.
const LLMAdapter = require('../base');

class AnthropicAdapter extends LLMAdapter {
  constructor(config) {
    super(config);
    if (!this.config.endpoint) this.config.endpoint = 'https://api.anthropic.com';
  }

  buildMessages(messages) {
    let system = '';
    const out = [];
    let lastRole = null;

    const pushMerged = (role, content) => {
      if (role === lastRole) {
        const prev = out[out.length - 1];
        if (typeof prev.content === 'string') prev.content += '\n\n' + content;
        else if (Array.isArray(prev.content)) prev.content.push({ type: 'text', text: content });
      } else {
        out.push({ role, content });
        lastRole = role;
      }
    };

    for (const m of messages) {
      if (m.role === 'system') {
        system += (system ? '\n\n' : '') + String(m.content ?? '');
        continue;
      }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const blocks = m.tool_calls.map(tc => ({
          type: 'tool_use',
          id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
          name: tc.function?.name || 'tool',
          input: (() => {
            try { return JSON.parse(tc.function?.arguments || '{}'); }
            catch { return { raw: tc.function?.arguments || '' }; }
          })()
        }));
        if (String(m.content ?? '').trim()) {
          blocks.unshift({ type: 'text', text: String(m.content) });
        }
        pushMerged('assistant', blocks);
        continue;
      }
      if (m.role === 'tool') {
        pushMerged('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id || 'unknown', content: String(m.content ?? '') }]);
        continue;
      }
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      pushMerged(role, String(m.content ?? ''));
    }

    return { system: system.slice(0, 12000) || undefined, messages: out };
  }

  requestOptions(messages, options) {
    const { system, messages: msgs } = this.buildMessages(messages);
    const body = {
      model: this.config.model,
      max_tokens: options.max_tokens || this.config.max_tokens || 4096,
      temperature: options.temperature ?? this.config.temperature ?? 0.7,
      messages: msgs
    };
    if (system) body.system = system;
    if (Array.isArray(options.tools) && options.tools.length) {
      body.tools = options.tools.map(t => ({
        name: t.function?.name || 'tool',
        description: t.function?.description || '',
        input_schema: t.function?.parameters || { type: 'object' }
      }));
    }
    return {
      url: `${String(this.config.endpoint).replace(/\/+$/, '')}/v1/messages`,
      headers: {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    };
  }

  parseContent(data) {
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const toolCalls = blocks
      .filter(b => b.type === 'tool_use')
      .map(b => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
      }));
    return { text, toolCalls };
  }

  async generate(messages, options = {}) {
    const { url, headers, body } = this.requestOptions(messages, options);
    const response = await fetch(url, { method: 'POST', headers, body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${data.error?.message || data.error || response.statusText}`);
    }
    if (data.usage) {
      this.lastUsage = {
        prompt_tokens: data.usage.input_tokens || 0,
        completion_tokens: data.usage.output_tokens || 0,
        total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
      };
    }
    return this.parseContent(data).text;
  }

  async chat(messages, options = {}) {
    const { url, headers, body } = this.requestOptions(messages, options);
    const response = await fetch(url, { method: 'POST', headers, body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${data.error?.message || data.error || response.statusText}`);
    }
    if (data.usage) {
      this.lastUsage = {
        prompt_tokens: data.usage.input_tokens || 0,
        completion_tokens: data.usage.output_tokens || 0,
        total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
      };
    }
    const { text, toolCalls } = this.parseContent(data);
    return { content: text, tool_calls: toolCalls.length ? toolCalls : null };
  }

  async stream(messages, onChunk, options = {}) {
    const { url, headers, body } = this.requestOptions(messages, options);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...JSON.parse(body), stream: true }) });
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
        if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text) {
          full += json.delta.text;
          onChunk(json.delta.text);
        }
        if (json.type === 'message_delta' && json.usage) {
          this.lastUsage = {
            prompt_tokens: json.usage.input_tokens || 0,
            completion_tokens: json.usage.output_tokens || 0,
            total_tokens: (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0)
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

module.exports = AnthropicAdapter;
