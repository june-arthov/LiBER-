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

/**
 * Provider-aware key resolution: process environment wins over .env.
 */
function resolveApiKey(provider) {
  const envNames = KEY_ENV[String(provider || 'openai').toLowerCase()] || KEY_ENV.openai;

  const fromEnv = envNames.map(n => process.env[n]).find(Boolean);
  if (fromEnv) return fromEnv;

  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const envVars = Object.fromEntries(
        envContent.split(/\r?\n/).filter(line => line.includes('=') && !line.trim().startsWith('#')).map(line => {
          const idx = line.indexOf('=');
          return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
        })
      );
      return envNames.map(n => envVars[n]).find(Boolean) || null;
    }
  } catch {
    return null;
  }
  return null;
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
