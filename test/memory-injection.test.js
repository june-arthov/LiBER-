// The point of standing memory: a NEW session must know the fact without
// calling the memory tool. These tests cover the store contract and the prompt.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FILE = path.join(os.tmpdir(), `liber-memory-test-${process.pid}.json`);
process.env.LIBER_MEMORY_FILE = FILE;

const memory = require('../src/daemon/core/tools/memory-tool');

function reset() {
  try { fs.unlinkSync(FILE); } catch { /* first run */ }
  memory.memoryStore.data = {};
}

test('a stored fact appears in the block injected every turn', () => {
  reset();
  memory.manageMemory({ action: 'set', key: 'pref.language', value: 'Indonesian, technical terms in English' });
  const block = memory.memoryBlock(1400);
  assert.match(block, /pref\.language: Indonesian/);
});

test('the block respects its character budget', () => {
  reset();
  for (let i = 0; i < 40; i++) {
    memory.manageMemory({ action: 'set', key: 'k' + i, value: 'x'.repeat(120) });
  }
  const block = memory.memoryBlock(400);
  assert.ok(block.length <= 400, `block was ${block.length} chars`);
  assert.ok(block.split('\n').length < 40, 'it stopped early instead of dumping everything');
});

test('seeding fills gaps but never overwrites what the user set', () => {
  reset();
  memory.manageMemory({ action: 'set', key: 'workspace.root', value: 'C:/mine' });
  const added = memory.memorySeed({ 'workspace.root': 'C:/other', 'workspace.os': 'win32 x64' });
  assert.equal(added, 1, 'only the missing key is written');
  const entry = memory.memoryEntries().find(e => e.key === 'workspace.root');
  assert.equal(entry.value, 'C:/mine');
});

test('deleting removes it from the injected block', () => {
  reset();
  memory.manageMemory({ action: 'set', key: 'temp.fact', value: 'forget me' });
  assert.match(memory.memoryBlock(1400), /temp\.fact/);
  memory.manageMemory({ action: 'delete', key: 'temp.fact' });
  assert.ok(!memory.memoryBlock(1400).includes('temp.fact'));
});

test('the system prompt carries the memory block', () => {
  reset();
  memory.manageMemory({ action: 'set', key: 'user.name', value: 'June' });
  const { buildSystemPrompt } = require('../src/daemon/core/liber-soul');
  const prompt = buildSystemPrompt({ name: 'dev-bot', engine: { model: 'm' }, skills: {} }, 'TOOLS', {
    memoryBlock: memory.memoryBlock(1400),
    skillContext: ''
  });
  assert.match(prompt, /WHAT YOU ALREADY KNOW/);
  assert.match(prompt, /user\.name: June/);
  assert.match(prompt, /do not cite them/i, 'the prompt tells the model not to cite memory as receipts');
});
