// src/daemon/core/stops.js — per-turn stop requests and the processes they own.
//
// The old kill switch was "close the browser": the SSE handler noticed the client
// disconnecting and the engine stopped at the next iteration. That leaves two
// holes: a caller with no socket (a script) cannot stop anything, and a terminal
// command keeps running to completion. This module closes both: a request marks
// the agent, and every child process started on its behalf is killed at once.
const stops = new Map(); // agentId -> { requested: boolean, at: number|null, children: Set }

function entry(agentId) {
  const id = String(agentId || 'default');
  if (!stops.has(id)) stops.set(id, { requested: false, at: null, children: new Set() });
  return stops.get(id);
}

function request(agentId) {
  const e = entry(agentId);
  e.requested = true;
  e.at = Date.now();
  const killed = killChildren(agentId);
  return { agentId: String(agentId || 'default'), killed };
}

function isRequested(agentId) {
  const e = stops.get(String(agentId || 'default'));
  return !!(e && e.requested);
}

function clear(agentId) {
  const e = stops.get(String(agentId || 'default'));
  if (e) { e.requested = false; e.at = null; }
}

/** Register a child process so /stop can end it mid-run. Returns a disposer. */
function track(agentId, child) {
  if (!child || typeof child.kill !== 'function') return () => {};
  const e = entry(agentId);
  e.children.add(child);
  const done = () => e.children.delete(child);
  child.once('exit', done);
  child.once('error', done);
  return done;
}

function killChildren(agentId) {
  const e = entry(agentId);
  let killed = 0;
  for (const child of [...e.children]) {
    try {
      // Kill the direct child first — it is the one we have a handle on — then, on
      // Windows, take the whole tree: powershell.exe dying does not stop the
      // command it launched.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      if (process.platform === 'win32' && child.pid) {
        require('child_process').execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true }, () => {});
      }
      killed += 1;
    } catch { /* already gone */ }
    e.children.delete(child);
  }
  return killed;
}

/** Called by the engine before it spends another model call or runs a tool. */
function shouldStop(agentId) {
  return isRequested(agentId);
}

function snapshot() {
  return [...stops.entries()].map(([agentId, e]) => ({
    agentId, requested: e.requested, at: e.at, children: e.children.size
  }));
}

module.exports = { request, isRequested, clear, track, killChildren, shouldStop, snapshot };
