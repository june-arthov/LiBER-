// src/utils/config-loader.js
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const KEY_ENV = {
  openai: ['OPENAI_API_KEY', 'OLLAMA_CLOUD_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  ollama: ['OLLAMA_CLOUD_API_KEY', 'OPENAI_API_KEY']
};

// OpenAI-compatible vendors use their own key names — resolve by endpoint host.
const ENDPOINT_KEY_ENV = [
  [/groq\.com/i, ['GROQ_API_KEY']],
  [/deepseek\.com/i, ['DEEPSEEK_API_KEY']],
  [/mistral\.ai/i, ['MISTRAL_API_KEY']],
  [/openrouter\.ai/i, ['OPENROUTER_API_KEY']],
  [/api\.x\.ai/i, ['XAI_API_KEY']],
  [/together\.xyz/i, ['TOGETHER_API_KEY']],
  [/ollama\.com/i, ['OLLAMA_CLOUD_API_KEY']],
  [/api\.openai\.com/i, ['OPENAI_API_KEY']],
  [/anthropic\.com/i, ['ANTHROPIC_API_KEY']],
  [/generativelanguage\.googleapis\.com/i, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']],
  [/localhost|127\.0\.0\.1/i, []] // local Ollama needs no key
];

function envVarsFromFile() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return {};
    return Object.fromEntries(
      fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter(line => line.includes('=') && !line.trim().startsWith('#')).map(line => {
        const idx = line.indexOf('=');
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
      })
    );
  } catch {
    return {};
  }
}

function lookup(names) {
  const fromEnv = names.map(n => process.env[n]).find(Boolean);
  if (fromEnv) return fromEnv;
  const file = envVarsFromFile();
  return names.map(n => file[n]).find(Boolean) || null;
}

/**
 * Provider + endpoint aware key resolution: the endpoint host decides the key
 * name first (Groq/DeepSeek/Mistral/... each have their own), then the provider.
 * Process environment always wins over .env.
 */
function resolveApiKey(provider, endpoint) {
  const ep = String(endpoint || '');
  for (const [re, names] of ENDPOINT_KEY_ENV) {
    if (re.test(ep)) return names.length ? lookup(names) : null;
  }
  const envNames = KEY_ENV[String(provider || 'openai').toLowerCase()] || KEY_ENV.openai;
  return lookup(envNames);
}

class ConfigLoader {
  static load(configPath = 'liber.yaml') {
    try {
      // 1. Load YAML config
      const absolutePath = path.resolve(process.cwd(), configPath);
      const fileContents = fs.readFileSync(absolutePath, 'utf8');
      const config = yaml.load(fileContents);

      // 2. Secret Management: provider-aware key from environment or .env
      const provider = (config.agent?.engine?.provider || 'openai').toLowerCase();
      const envKey = resolveApiKey(provider);

      if (envKey && config.agent?.engine) {
        config.agent.engine.apiKey = envKey;
      }

      return config;
    } catch (e) {
      console.error(`[Error] Failed to load config: ${e.message}`);
      process.exit(1);
    }
  }
}

module.exports = ConfigLoader;
module.exports.resolveApiKey = resolveApiKey;
