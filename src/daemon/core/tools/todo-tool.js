// src/daemon/core/tools/todo-tool.js — Liber Task Planning & Tracking Tool
class TodoManager {
  constructor() {
    this.tasks = [];
    this.counter = 1;
  }

  execute({ action = "list", task = null, id = null }) {
    const act = (action || "list").toLowerCase();

    if (act === "add") {
      if (!task) return { error: "Missing task description for action 'add'." };
      const item = { id: this.counter++, task, status: "pending", created_at: new Date().toISOString() };
      this.tasks.push(item);
      return { success: true, message: `Task #${item.id} added.`, tasks: this.tasks };
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
      return { success: true, message: "All tasks cleared." };
    }

    // Default: list
    return {
      total: this.tasks.length,
      pending: this.tasks.filter(t => t.status === "pending").length,
      completed: this.tasks.filter(t => t.status === "completed").length,
      tasks: this.tasks
    };
  }
}

const manager = new TodoManager();
module.exports = {
  manageTodo: (args) => manager.execute(args)
};
