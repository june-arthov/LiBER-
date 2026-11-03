// src/daemon/core/registry.js — Merlin Tool Registry & Schema Engine
const { readFile, writeFile, patchFile, searchFiles } = require('./tools/file-tools');
const { runTerminal, isCommandSensitive } = require('./tools/terminal-tool');
const { manageTodo } = require('./tools/todo-tool');
const { manageMemory } = require('./tools/memory-tool');

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

  async execute(name, args = {}) {
    const tool = this.get(name);
    if (!tool) {
      return { error: `Tool '${name}' is not registered.` };
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
