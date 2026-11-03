// src/daemon/core/tools/skill-tool.js — progressive skill access for the model.
const skills = require('../skills');

const ACTIONS = ['list', 'view', 'search', 'create', 'update'];

function manageSkill({ action = 'list', name = null, query = null, description = null, body = null, triggers = [], always = false, overwrite = false } = {}) {
  const act = String(action || 'list').toLowerCase();

  if (!ACTIONS.includes(act)) {
    return { error: `Unknown skill action '${action}'. Use: ${ACTIONS.join(', ')}.` };
  }

  if (act === 'list') {
    return {
      total: skills.scan().length,
      skills: skills.scan().map(s => ({
        name: s.name,
        description: s.description,
        always: s.always,
        source: s.source,
        files: s.files
      })),
      index: skills.indexLines()
    };
  }

  if (act === 'view') {
    if (!name) return { error: "Missing 'name' argument for action 'view'." };
    return skills.view(name);
  }

  if (act === 'search') {
    return skills.search(query);
  }

  // create / update — project-scoped writes (approval enforced by the caller)
  if (!name) return { error: `Missing 'name' argument for action '${act}'.` };
  if (!description) return { error: `Missing 'description' argument for action '${act}'.` };
  if (!body) return { error: `Missing 'body' argument for action '${act}'.` };

  return skills.writeSkill({ name, description, body, triggers, always }, act === 'update' || overwrite === true);
}

module.exports = { manageSkill, ACTIONS };
