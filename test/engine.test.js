// test/engine.test.js — end-to-end turn loop with a scripted model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'liber-engine-'));
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.1.0' }, null, 2));
process.chdir(tmp);

const engine = require('../src/daemon/core/engine');
const memory = require('../src/daemon/core/memory');

function cfg(overrides = {}) {
  return {
    name: 'test-bot',
    engine: { model: 'fixture-model' },
    grounding: {
      enabled: true,
      max_repairs: 2,
      require_readback: true,
      require_citations: true,
      doctrine_budget_chars: 4000,
      ...overrides
    }
  };
}

function scripted(responses) {
  let i = 0;
  return {
    calls: [],
    async generate(messages) {
      this.calls.push(messages);
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    }
  };
}

test('blocks a hallucinated version, forces a read, then delivers a cited answer', async () => {
  const llm = scripted([
    '[THOUGHT: I remember this project.] [FINAL: package.json declares version 9.9.9.]',
    '[TOOL: read_file({"path": "package.json"})]',
    '[FINAL: package.json declares version 0.1.0 [E1].]'
  ]);
  const events = [];
  const res = await engine.runTurn({
    agentId: 't-repair',
    agentConfig: cfg(),
    userMessage: 'Which version is declared in package.json?',
    memory,
    llmManager: llm,
    onEvent: (e, d) => events.push({ e, d }),
    maxLoops: 8
  });

  assert.equal(res.grounding.status, 'PASS', JSON.stringify(res.grounding.violations));
  assert.equal(res.repairs, 1);
  assert.equal(res.grounding.ledger.receipts.length, 1);
  assert.equal(res.grounding.ledger.receipts[0].tool, 'read_file');
  assert.match(res.response, /\[E1\]/);
  assert.ok(!/GROUNDING AUDIT/.test(res.response));
  assert.ok(events.some(x => x.e === 'grounding_audit' && x.d.status === 'repair'));
  assert.ok(events.some(x => x.e === 'grounding_pass'));
});

test('never lets an unsupported claim ship as fact', async () => {
  const llm = scripted(['[FINAL: I fixed the bug. All tests pass.]']);
  const res = await engine.runTurn({
    agentId: 't-unrepairable',
    agentConfig: cfg({ max_repairs: 2 }),
    userMessage: 'fix the bug',
    memory,
    llmManager: llm,
    onEvent: () => {},
    maxLoops: 8
  });

  assert.equal(res.grounding.status, 'REPAIR');
  assert.equal(res.repairs, 2);
  assert.match(res.response, /GROUNDING AUDIT/);
  assert.match(res.response, /NOT verified/);
  assert.equal(res.grounded, false);
});

test('write without read-back is caught; read-back clears it', async () => {
  const llm = scripted([
    '[TOOL: write_file({"path": "out.txt", "content": "hello"})]',
    '[FINAL: I created out.txt.]',
    '[TOOL: read_file({"path": "out.txt"})]',
    '[FINAL: out.txt now contains the word hello [E2].]'
  ]);
  const res = await engine.runTurn({
    agentId: 't-readback',
    agentConfig: cfg(),
    userMessage: 'create out.txt with hello',
    memory,
    llmManager: llm,
    onEvent: () => {},
    maxLoops: 8
  });

  assert.equal(res.grounding.status, 'PASS', JSON.stringify(res.grounding.violations));
  assert.equal(res.repairs, 1);
  const kinds = res.grounding.ledger.receipts.map(r => r.kind);
  assert.deepEqual(kinds, ['write', 'read']);
  assert.equal(fs.readFileSync(path.join(tmp, 'out.txt'), 'utf8'), 'hello');
});

test('honest uncertainty is delivered without repair', async () => {
  const llm = scripted(['[FINAL: UNVERIFIED: the version may be 0.1.0 — no tool receipt.]']);
  const res = await engine.runTurn({
    agentId: 't-hedge',
    agentConfig: cfg(),
    userMessage: 'what version?',
    memory,
    llmManager: llm,
    onEvent: () => {},
    maxLoops: 4
  });
  assert.equal(res.grounding.status, 'PASS');
  assert.equal(res.repairs, 0);
  assert.match(res.response, /UNVERIFIED/);
});

test('general knowledge needs no receipts', async () => {
  const llm = scripted(['[FINAL: Array.prototype.map returns a new array in JavaScript.]']);
  const res = await engine.runTurn({
    agentId: 't-knowledge',
    agentConfig: cfg(),
    userMessage: 'what does map return?',
    memory,
    llmManager: llm,
    onEvent: () => {},
    maxLoops: 4
  });
  assert.equal(res.grounding.status, 'PASS');
  assert.equal(res.grounding.ledger.receipts.length, 0);
});

test('argument validation blocks execution and feeds the error back', async () => {
  const llm = scripted([
    '[TOOL: read_file({"pathx": "package.json"})]',
    '[FINAL: I could not read the file — invalid arguments were rejected [E1].]'
  ]);
  const res = await engine.runTurn({
    agentId: 't-args',
    agentConfig: cfg(),
    userMessage: 'read package.json',
    memory,
    llmManager: llm,
    onEvent: () => {},
    maxLoops: 6
  });
  const first = res.grounding.ledger.receipts[0];
  assert.equal(first.ok, false);
  assert.equal(first.tool, 'read_file');
});

test('loop exhaustion reports honestly instead of claiming completion', async () => {
  const llm = scripted(['[TOOL: read_file({"path": "package.json"})]']);
  const res = await engine.runTurn({
    agentId: 't-exhaust',
    agentConfig: cfg(),
    userMessage: 'loop forever',
    memory,
    llmManager: llm,
    onEvent: () => {},
    maxLoops: 3
  });
  assert.match(res.response, /Execution limit reached/);
  assert.match(res.response, /No completion is claimed/);
});

test('observations are delivered as user turns, never mid-conversation system turns', async () => {
  const seen = [];
  const llm = {
    async generate(messages) {
      seen.push(messages.map(m => ({ role: m.role, content: String(m.content).slice(0, 40) })));
      const last = messages[messages.length - 1];
      if (last.role === 'user' && last.content.startsWith('OBSERVATION')) {
        return '[FINAL: package.json declares version 0.1.0 [E1].]';
      }
      return '[TOOL: read_file({"path": "package.json"})]';
    }
  };

  const res = await engine.runTurn({
    agentId: 't-roles',
    agentConfig: cfg(),
    userMessage: 'which version?',
    memory,
    llmManager: llm,
    onEvent: () => {},
    maxLoops: 4
  });

  assert.equal(res.grounding.status, 'PASS');
  const secondCall = seen[1];
  assert.equal(secondCall[secondCall.length - 1].role, 'user');
  assert.match(secondCall[secondCall.length - 1].content, /^OBSERVATION/);
  assert.ok(!secondCall.slice(1).some(m => m.role === 'system'), 'no system turns after the prompt');
});

test('duplicate identical tool calls are suppressed to break loops', async () => {
  const llm = scripted(['[TOOL: read_file({"path": "package.json"})]']);
  const res = await engine.runTurn({
    agentId: 't-loopguard',
    agentConfig: cfg(),
    userMessage: 'repeat forever',
    memory,
    llmManager: llm,
    onEvent: () => {},
    maxLoops: 5
  });
  assert.equal(res.grounding.ledger.receipts.length, 2, 'third and later identical calls must not execute');
  assert.equal(res.grounding.status, 'INCOMPLETE');
});
