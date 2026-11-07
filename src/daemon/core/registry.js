// src/daemon/core/registry.js — Liber Tool Registry & Schema Engine
const { readFile, writeFile, patchFile, searchFiles } = require('./tools/file-tools');
const { runTerminal, isCommandSensitive } = require('./tools/terminal-tool');
const { manageTodo } = require('./tools/todo-tool');
const { manageMemory } = require('./tools/memory-tool');
const { fetchUrl, searchWeb } = require('./tools/web-tool');
const { manageSkill, ACTIONS: SKILL_ACTIONS } = require('./tools/skill-tool');
const { TASK_TOOLS } = require('./tools/task-tool');
const { validateArgs } = require('./validate');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.registerDefaults();
  }

  registerDefaults() {
    // 1. read_file
    this.register({
      name: 'read_file',
      description: 'Read the contents of a file with line numbers, offset, and limit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute file path to read' },
          offset: { type: 'integer', description: 'Starting line number (1-based, default: 1)' },
          limit: { type: 'integer', description: 'Number of lines to read (default: 100)' }
        },
        required: ['path']
      },
      handler: readFile
    });

    // 2. write_file
    this.register({
      name: 'write_file',
      description: 'Create a new file or completely overwrite an existing file with the provided content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write to' },
          content: { type: 'string', description: 'Full text content to write' }
        },
        required: ['path', 'content']
      },
      handler: writeFile,
      sensitive: true
    });

    // 3. patch
    this.register({
      name: 'patch',
      description: 'Surgically replace a unique block of text (old_string) with new_string in a file using exact or fuzzy whitespace matching.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to modify' },
          old_string: { type: 'string', description: 'Exact text segment to find and replace' },
          new_string: { type: 'string', description: 'Replacement text segment' },
          replace_all: { type: 'boolean', description: 'Whether to replace all occurrences if multiple exist (default: false)' }
        },
        required: ['path', 'old_string', 'new_string']
      },
      handler: patchFile,
      sensitive: true
    });

    // 4. search_files
    this.register({
      name: 'search_files',
      description: 'Search for regex/text patterns within file contents or find file paths matching a pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or text query to search' },
          path: { type: 'string', description: 'Root directory to start search from (default: .)' },
          target: { type: 'string', enum: ['content', 'files'], description: 'Whether to search file contents or file paths (default: content)' },
          file_glob: { type: 'string', description: 'Optional filename filter (e.g. *.js, *.py)' },
          limit: { type: 'integer', description: 'Maximum matches to return (default: 50)' }
        },
        required: ['pattern']
      },
      handler: searchFiles
    });

    // 5. terminal
    this.register({
      name: 'terminal',
      description: 'Execute a system command in the host shell (PowerShell on Windows, bash on Linux/macOS).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The exact command line string to run' },
          timeout: { type: 'integer', description: 'Timeout in milliseconds (default: 45000)' }
        },
        required: ['command']
      },
      handler: runTerminal,
      isSensitiveCheck: (args) => isCommandSensitive(args.command)
    });

    // 6. todo_list
    this.register({
      name: 'todo_list',
      description: 'Maintain the visible plan for this turn. Prefer action "set" with the complete list (one item per step), then flip items to in_progress/completed as you work. The user sees this checklist live.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'add', 'update', 'complete', 'delete', 'list', 'clear'], description: 'set rewrites the whole plan; add/update/complete/delete act on one id' },
          items: {
            type: 'array',
            description: 'Full plan for action "set": [{ "task": "...", "status": "pending|in_progress|completed" }]',
            items: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'Short imperative step' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
              },
              required: ['task']
            }
          },
          task: { type: 'string', description: 'Task description (for action add)' },
          id: { type: 'integer', description: 'Task ID (for update/complete/delete)' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'New status (for action update)' }
        },
        required: ['action']
      },
      handler: manageTodo
    });

    // 7. memory
    this.register({
      name: 'memory',
      description: 'Recall, store, list, or forget persistent knowledge across sessions.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'list', 'delete'], description: 'Memory action' },
          key: { type: 'string', description: 'Key name to store or recall' },
          value: { type: 'string', description: 'Information to store (for set action)' }
        },
        required: ['action']
      },
      handler: manageMemory
    });

    // 8. fetch_url — ground external claims in retrieved text
    this.register({
      name: 'fetch_url',
      description: 'Fetch an http(s) URL and return the readable text (HTML stripped). Use to verify external facts instead of guessing.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
          maxChars: { type: 'integer', description: 'Maximum characters of text to return (default 12000)' }
        },
        required: ['url']
      },
      handler: fetchUrl
    });

    // 8c. vault — secrets the agent can use without ever printing them
    this.register({
      name: 'vault',
      description: 'Encrypted secret store. list: names and last-4 hints only · set: store a secret · get: read one back (disabled unless the operator allows it) · remove: delete. Prefer storing a key here over pasting it into a command line.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'set', 'get', 'remove'], description: 'list | set | get | remove' },
          name: { type: 'string', description: 'Secret name, e.g. github.token' },
          value: { type: 'string', description: 'Secret value (action set)' }
        },
        required: ['action']
      },
      handler: async (args) => {
        const vault = require('./vault');
        const action = String(args.action || '').toLowerCase();
        if (action === 'list') return { entries: vault.list(), status: vault.status() };
        if (action === 'set') return vault.set(args.name, args.value);
        if (action === 'remove') return vault.remove(args.name);
        if (action === 'get') {
          // Reading a secret back into the model is an operator decision: a key in
          // the transcript can be exfiltrated by any later prompt injection.
          const allowed = process.env.LIBER_VAULT_AGENT_READ === '1';
          if (!allowed) {
            return { error: 'Reading secrets back is disabled. The operator can enable it with LIBER_VAULT_AGENT_READ=1 or by wiring the value into a connector that uses it server-side.', entries: vault.list() };
          }
          const value = vault.get(args.name);
          return value === null
            ? { error: "No secret named '" + args.name + "'." }
            : { name: args.name, value };
        }
        return { error: "Unknown vault action '" + action + "'." };
      }
    });

    // 8b. browser — a real Chromium for pages that need JS, clicks or typing
    this.register({
      name: 'browser',
      description: 'Drive a real headless Chromium: open pages, click, type into forms, press keys, read text, take screenshots. Use it when a page needs JavaScript, a login, or interaction — fetch_url only reads static HTML.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'click', 'type', 'press', 'extract', 'screenshot', 'eval', 'status', 'close'], description: 'open: navigate to url · click: by selector or visible text · type: selector+text · press: key · extract: read text · screenshot: save png · close: shut the browser' },
          url: { type: 'string', description: 'http(s) URL for action open' },
          selector: { type: 'string', description: 'CSS selector or the visible text of the element' },
          text: { type: 'string', description: 'Text to type (action type)' },
          key: { type: 'string', description: 'enter | tab | escape | arrowup | arrowdown' },
          expression: { type: 'string', description: 'JavaScript to evaluate (action eval)' },
          path: { type: 'string', description: 'Where to save a screenshot (optional)' }
        },
        required: ['action']
      },
      handler: async (args) => {
        const browserTool = require('./tools/browser-tool');
        const result = await browserTool.runBrowser(args);
        // Page text is web data: flag instruction-like content before the model sees it.
        try {
          const injection = require('./injection');
          const probe = JSON.stringify(result || {});
          if (injection.scan(probe)) return { ...result, untrusted_warning: injection.WARNING };
        } catch { /* scan is best effort */ }
        return result;
      }
    });

    // 9. skill — progressive-disclosure procedure library
    this.register({
      name: 'skill',
      description: 'List, search, view, create or update procedural skills. Load a matching skill BEFORE acting instead of improvising a method.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: SKILL_ACTIONS, description: 'list | view | search | create | update' },
          name: { type: 'string', description: 'Skill name (view/create/update)' },
          query: { type: 'string', description: 'Search text (search)' },
          description: { type: 'string', description: 'One-line "Use when ..." description (create/update)' },
          body: { type: 'string', description: 'Full markdown procedure (create/update)' },
          triggers: { type: 'array', description: 'Keywords that auto-select this skill' },
          always: { type: 'boolean', description: 'Inject the body every turn (use sparingly)' },
          overwrite: { type: 'boolean', description: 'Allow replacing an existing skill' }
        },
        required: ['action']
      },
      handler: manageSkill,
      isSensitiveCheck: (args) => ['create', 'update'].includes(String(args.action || '').toLowerCase())
    });

    // 10. task / tasks — subagent orchestration (executed by the engine)
    for (const def of TASK_TOOLS) this.register(def);

    // 11. web_search — keyless search; verify important facts with fetch_url
    this.register({
      name: 'web_search',
      description: 'Search the web and return titles, URLs and snippets. Treat results as pointers; verify any important fact by fetching the primary source with fetch_url and citing the receipt.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max: { type: 'integer', description: 'Maximum results (default 8, max 10)' }
        },
        required: ['query']
      },
      handler: searchWeb
    });

    // images and video are opt-in by key: the tool explains itself when missing
    this.registerMedia();
  }

  register(def) {
    this.tools.set(def.name, def);
  }

  /** Text to image/video: provider-backed, written into the workspace, spent from
   *  the same daily budget. Registered apart because it is opt-in by key. */
  registerMedia() {
    const media = require('./tools/media-tool');

    this.register({
      name: 'image_generate',
      description: 'Generate an image from a text prompt and save it into the workspace under artifacts/media/. Requires an image provider key (OpenAI by default, or any endpoint that speaks POST /images/generations). Returns the file path and size so the result can be cited.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What the image should show' },
          size: { type: 'string', description: 'e.g. 1024x1024, 1536x1024, 1024x1536' },
          model: { type: 'string', description: 'Provider model id (default gpt-image-1)' },
          endpoint: { type: 'string', description: 'Override the provider base URL' },
          n: { type: 'integer', description: 'How many images (1-4)' }
        },
        required: ['prompt']
      },
      handler: media.imageGenerate
    });

    this.register({
      name: 'video_generate',
      description: 'Generate a short video from a text prompt through Replicate, save the mp4 under artifacts/media/, and extract a thumbnail when ffmpeg is available. Requires REPLICATE_API_TOKEN and a model version (LIBER_VIDEO_MODEL or the model argument).',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What the video should show' },
          model: { type: 'string', description: 'owner/model:version (falls back to LIBER_VIDEO_MODEL)' },
          seconds: { type: 'integer', description: 'Clip length in seconds if the model supports it' }
        },
        required: ['prompt']
      },
      handler: media.videoGenerate
    });
  }

  get(name) {
    if (name === 'shell_execute' || name === 'exec') return this.tools.get('terminal');
    return this.tools.get(name);
  }

  isSensitive(name, args = {}) {
    const tool = this.get(name);
    if (!tool) return false;
    if (typeof tool.isSensitiveCheck === 'function') {
      return tool.isSensitiveCheck(args);
    }
    return !!tool.sensitive;
  }

  /**
   * Schema-lite validation. A tool must never execute on malformed or hallucinated arguments.
   */
  validate(name, args = {}) {
    const tool = this.get(name);
    if (!tool) {
      return {
        ok: false,
        errors: [`Tool '${name}' is not registered. Available: ${Array.from(this.tools.keys()).join(', ')}.`],
        problems: [{ field: 'tool', issue: 'unknown_tool' }],
        schema: null
      };
    }
    const result = validateArgs(tool.parameters, args);
    return { ...result, schema: { required: tool.parameters?.required || [], properties: Object.keys(tool.parameters?.properties || {}) } };
  }

  async execute(name, args = {}, meta = {}) {
    const tool = this.get(name);
    if (!tool) {
      return {
        error: `Tool '${name}' is not registered. Available: ${Array.from(this.tools.keys()).join(', ')}.`,
        validation_failed: true
      };
    }

    const validation = this.validate(name, args);
    if (!validation.ok) {
      return {
        error: `Invalid arguments for '${name}': ${validation.errors.join(' ')}`,
        validation_failed: true,
        problems: validation.problems,
        schema: validation.schema
      };
    }

    try {
      return await tool.handler(args, meta);
    } catch (err) {
      return { error: `Tool '${name}' failed: ${err.message}` };
    }
  }

  getOpenAITools() {
    const list = [];
    for (const [name, def] of this.tools.entries()) {
      list.push({
        type: 'function',
        function: {
          name,
          description: def.description,
          parameters: def.parameters
        }
      });
    }
    return list;
  }

  getToolDescription() {
    const list = [];
    for (const [name, def] of this.tools.entries()) {
      const params = Object.entries(def.parameters.properties || {})
        .map(([p, info]) => `${p}: ${info.type} (${info.description})`)
        .join(', ');
      list.push(`- ${name}(${params}): ${def.description}`);
    }
    return list.join('\n');
  }
}

module.exports = new ToolRegistry();
