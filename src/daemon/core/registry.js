// src/daemon/core/registry.js — Merlin Tool Registry & Schema Engine
const { readFile, writeFile, patchFile, searchFiles } = require('./tools/file-tools');
const { runTerminal, isCommandSensitive } = require('./tools/terminal-tool');
const { manageTodo } = require('./tools/todo-tool');
const { manageMemory } = require('./tools/memory-tool');
const { fetchUrl } = require('./tools/web-tool');
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
      description: 'Manage and track multi-step execution tasks and engineering goals.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'complete', 'delete', 'list', 'clear'], description: 'Action to perform' },
          task: { type: 'string', description: 'Task description (for action add)' },
          id: { type: 'integer', description: 'Task ID (for action complete or delete)' }
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
  }

  register(def) {
    this.tools.set(def.name, def);
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

  async execute(name, args = {}) {
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
      return await tool.handler(args);
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
