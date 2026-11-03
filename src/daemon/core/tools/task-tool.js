// src/daemon/core/tools/task-tool.js — subagent schemas (execution is handled by the engine).
const TASK_PARAMS = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'A self-contained objective for the subagent.' },
    context: { type: 'string', description: 'Optional background: paths, constraints, what is already known.' }
  },
  required: ['goal']
};

const TASKS_PARAMS = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: 'Up to 4 independent objectives to run in parallel (each gets its own context and receipts).'
    }
  },
  required: ['tasks']
};

function stub() {
  return { error: 'task tools are executed by the engine, not the registry.' };
}

const TASK_TOOLS = [
  {
    name: 'task',
    description: 'Spawn one focused subagent with its own context and receipts. Use for self-contained research or verification that would flood the main context.',
    parameters: TASK_PARAMS,
    handler: stub
  },
  {
    name: 'tasks',
    description: 'Run up to 4 independent subagents in parallel and collect their reports. Use for comparisons or multi-file investigations.',
    parameters: TASKS_PARAMS,
    handler: stub
  }
];

module.exports = { TASK_TOOLS, stub };
