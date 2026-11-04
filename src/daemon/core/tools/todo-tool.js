// src/daemon/core/tools/todo-tool.js — Liber Task Planning & Tracking Tool
// Harness-style: the whole list can be rewritten in one call, and each item
// carries a status (pending | in_progress | completed).
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

class TodoManager {
  constructor() {
    this.tasks = [];
    this.counter = 1;
  }

  normaliseStatus(status) {
    const s = String(status || '').toLowerCase().replace(/[-\s]/g, '_');
    if (s === 'done' || s === 'complete') return 'completed';
    if (s === 'active' || s === 'current' || s === 'inprogress') return 'in_progress';
    return STATUSES.has(s) ? s : 'pending';
  }

  // Replace the list wholesale, keeping ids stable for unchanged items.
  set(items) {
    if (!Array.isArray(items)) return { error: "action 'set' needs an items array." };
    const next = items.slice(0, 30).map((raw, i) => {
      const item = typeof raw === 'string' ? { task: raw } : (raw || {});
      const task = String(item.task || item.text || '').trim();
      const prior = this.tasks[i];
      const same = prior && prior.task === task ? prior : null;
      return {
        id: same ? same.id : this.counter++,
        task,
        status: this.normaliseStatus(item.status || (same ? same.status : 'pending')),
        created_at: same ? same.created_at : new Date().toISOString()
      };
    }).filter(t => t.task);
    this.tasks = next;
    return { success: true, message: `Plan updated (${next.length} item${next.length === 1 ? '' : 's'}).`, tasks: this.tasks };
  }

  execute({ action = "list", task = null, id = null, status = null, items = null }) {
    const act = (action || "list").toLowerCase();

    if (act === "set" || act === "write" || act === "plan") return this.set(items);

    if (act === "add") {
      if (!task) return { error: "Missing task description for action 'add'." };
      const item = {
        id: this.counter++,
        task: String(task),
        status: this.normaliseStatus(status),
        created_at: new Date().toISOString()
      };
      this.tasks.push(item);
      return { success: true, message: `Task #${item.id} added.`, tasks: this.tasks };
    }

    if (act === "update" || act === "status") {
      if (!id) return { error: "Missing task id to update." };
      const item = this.tasks.find(t => t.id === parseInt(id, 10));
      if (!item) return { error: `Task #${id} not found.` };
      item.status = this.normaliseStatus(status);
      if (item.status === 'completed') item.completed_at = new Date().toISOString();
      return { success: true, message: `Task #${id} → ${item.status}.`, tasks: this.tasks };
    }

    if (act === "complete" || act === "done") {
      if (!id) return { error: "Missing task id to complete." };
      const item = this.tasks.find(t => t.id === parseInt(id, 10));
      if (!item) return { error: `Task #${id} not found.` };
      item.status = "completed";
      item.completed_at = new Date().toISOString();
      return { success: true, message: `Task #${id} marked as completed.`, tasks: this.tasks };
    }

    if (act === "delete" || act === "remove") {
      if (!id) return { error: "Missing task id to delete." };
      const idx = this.tasks.findIndex(t => t.id === parseInt(id, 10));
      if (idx === -1) return { error: `Task #${id} not found.` };
      const removed = this.tasks.splice(idx, 1)[0];
      return { success: true, message: `Task #${id} deleted.`, removed, tasks: this.tasks };
    }

    if (act === "clear") {
      this.tasks = [];
      return { success: true, message: "All tasks cleared.", tasks: this.tasks };
    }

    // Default: list
    return {
      total: this.tasks.length,
      pending: this.tasks.filter(t => t.status === "pending").length,
      in_progress: this.tasks.filter(t => t.status === "in_progress").length,
      completed: this.tasks.filter(t => t.status === "completed").length,
      tasks: this.tasks
    };
  }
}

const manager = new TodoManager();
module.exports = {
  manageTodo: (args) => manager.execute(args)
};
