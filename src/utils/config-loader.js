// src/utils/config-loader.js
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

class ConfigLoader {
  static load(configPath = 'liber.yaml') {
    try {
      // 1. Load YAML config
      const absolutePath = path.resolve(process.cwd(), configPath);
      const fileContents = fs.readFileSync(absolutePath, 'utf8');
      const config = yaml.load(fileContents);

      // 2. Secret Management: Load API Key from environment or .env
      const envKey = process.env.OLLAMA_CLOUD_API_KEY || process.env.OPENAI_API_KEY;
      if (envKey && config.agent?.engine) {
        config.agent.engine.apiKey = envKey;
      }

      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const envVars = Object.fromEntries(
          envContent.split(/\r?\n/).filter(line => line.includes('=') && !line.trim().startsWith('#')).map(line => {
            const idx = line.indexOf('=');
            return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
          })
        );
        
        // Inject API Key into config if found in .env
        const fileKey = envVars.OLLAMA_CLOUD_API_KEY || envVars.OPENAI_API_KEY;
        if (fileKey && config.agent?.engine) {
          config.agent.engine.apiKey = fileKey;
        }
      }

      return config;
    } catch (e) {
      console.error(`[Error] Failed to load config: ${e.message}`);
      process.exit(1);
    }
  }
}

module.exports = ConfigLoader;
