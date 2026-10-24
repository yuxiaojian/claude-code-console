import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, STALE_AFTER_MS, promptText } from '../src/store.js';

const SID = 'sess-1';
const T0 = Date.parse('2026-10-24T10:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();

const base = (sec, extra) => ({ sessionId: SID, timestamp: at(sec), cwd: '/work/acme/api', gitBranch: 'main', isSidechain: false, ...extra });
const prompt = (sec, text) => base(sec, { type: 'user', message: { role: 'user', content: text } });
const asst = (sec, id, content, { stop = null, usage = { input_tokens: 10, output_tokens: 5 }, model = 'claude-opus-5-5' } = {}) =>
  base(sec, { type: 'assistant', message: { id, model, role: 'assistant', content, stop_reason: stop, usage } });
const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (sec, toolUseId) => base(sec, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] } });

function storeAt(sec) {
  let t = T0 + sec * 1000;
  const store = new Store({ now: () => t });
  store.setNow = s => { t = T0 + s * 1000; };
  return store;
}

test('phase follows the conversation: prompt → tool → working → waiting', () => {
  const st = storeAt(0);
  const one = () => st.summarize(st.sessions.get(SID));

  st.ingest(prompt(0, 'fix the tests'));
  assert.equal(one().status, 'working');
  assert.equal(one().turns, 1);

  st.ingest(asst(1, 'm1', [toolUse('t1', 'Bash', { command: 'npm test' })], { stop: 'tool_use' }));
  assert.equal(one().status, 'tool');
  assert.deepEqual(one().currentTool.name, 'Bash');
  assert.equal(one().currentTool.target, 'npm test');

  st.ingest(toolResult(2, 't1'));
  assert.equal(one().status, 'working');
  assert.equal(one().currentTool, null);

  st.ingest(asst(3, 'm2', [{ type: 'text', text: 'All green.' }], { stop: 'end_turn' }));
  assert.equal(one().status, 'waiting');
  assert.equal(one().project, 'acme/api');
});

test('AskUserQuestion is reported as needing an answer', () => {
  const st = storeAt(0);
  st.ingest(prompt(0, 'plan it'));
  st.ingest(asst(1, 'm1', [toolUse('q1', 'AskUserQuestion', { questions: [] })], { stop: 'tool_use' }));
  assert.equal(st.summarize(st.sessions.get(SID)).status, 'question');
});

test('streamed message usage is counted once (deltas only)', () => {
  const st = storeAt(0);
  st.ingest(prompt(0, 'hi'));
  const usage = out => ({ input_tokens: 3, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 } });
  st.ingest(asst(1, 'm1', [{ type: 'text', text: 'a' }], { usage: usage(4) }));
  st.ingest(asst(1, 'm1', [toolUse('t1', 'Read', { file_path: '/x/y.js' })], { usage: usage(4) }));
  st.ingest(asst(2, 'm1', [toolUse('t2', 'Read', { file_path: '/x/z.js' })], { usage: usage(90), stop: 'tool_use' }));
  const s = st.summarize(st.sessions.get(SID));
  assert.equal(s.apiCalls, 1);
  assert.deepEqual(s.tokens, { input: 3, output: 90, cacheWrite5m: 0, cacheWrite1h: 200, cacheRead: 1000 });
  // Opus 5.5: $4 in, $20 out, 1h write 2x input, read $0.20
  const expected = (3 * 4 + 90 * 20 + 200 * 8 + 1000 * 0.2) / 1e6;
  assert.ok(Math.abs(s.cost.usd - expected) < 1e-12);
  assert.equal(s.cost.source, 'estimate');
  assert.deepEqual(s.files, ['/x/z.js', '/x/y.js']);
  // Spend is bucketed by local day, and the deltas add up to the same total.
  const days = Object.entries(s.spendByDay);
  assert.equal(days.length, 1);
  assert.ok(Math.abs(days[0][1] - expected) < 1e-12);
});

test('working sessions go stale without events; waiting does not', () => {
  const st = storeAt(0);
  st.ingest(prompt(0, 'long job'));
  st.setNow(STALE_AFTER_MS / 1000 + 5);
  assert.equal(st.summarize(st.sessions.get(SID)).status, 'stale');

  st.ingest(asst(1, 'm1', [{ type: 'text', text: 'done' }], { stop: 'end_turn' }));
  assert.equal(st.summarize(st.sessions.get(SID)).status, 'waiting');
});

test('api_error marks the session errored until the next response', () => {
  const st = storeAt(0);
  st.ingest(prompt(0, 'go'));
  st.ingest(base(1, { type: 'system', subtype: 'api_error', error: { cause: { code: 'ConnectionRefused' } }, retryAttempt: 2, maxRetries: 10 }));
  let s = st.summarize(st.sessions.get(SID));
  assert.equal(s.status, 'error');
  assert.match(s.error.message, /ConnectionRefused \(retry 2\/10\)/);
  st.ingest(asst(5, 'm1', [{ type: 'text', text: 'ok' }]));
  s = st.summarize(st.sessions.get(SID));
  assert.equal(s.status, 'working');
  assert.equal(s.error, null);
});

test('cost-state ends the session and is preferred over the estimate, plus spend after a resume', () => {
  const st = storeAt(0);
  st.ingest(prompt(0, 'go'));
  st.ingest(asst(1, 'm1', [{ type: 'text', text: 'ok' }], { stop: 'end_turn', usage: { input_tokens: 1000, output_tokens: 1000 } }));
  st.ingest({ type: 'cost-state', sessionId: SID, totalCostUSD: 1.5, totalLinesAdded: 7, totalLinesRemoved: 2 });
  let s = st.summarize(st.sessions.get(SID));
  assert.equal(s.status, 'ended');
  assert.equal(s.cost.usd, 1.5);
  assert.equal(s.cost.source, 'claude-code');
  assert.equal(s.linesAdded, 7);

  // Resumed: new spend is added on top of the reported figure.
  st.ingest(prompt(10, 'one more thing'));
  st.ingest(asst(11, 'm2', [{ type: 'text', text: 'ok' }], { stop: 'end_turn', usage: { input_tokens: 0, output_tokens: 50_000 } }));
  s = st.summarize(st.sessions.get(SID));
  assert.equal(s.status, 'waiting');
  assert.ok(Math.abs(s.cost.usd - (1.5 + 1.0)) < 1e-9);
  assert.equal(s.cost.source, 'claude-code+estimate');
});

test('subagents: metadata from meta.json, done when the parent gets the Agent tool result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-'));
  const subFile = path.join(dir, 'agent-abc.jsonl');
  fs.writeFileSync(path.join(dir, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the config loader', toolUseId: 'toolu_1' }));

  const st = storeAt(0);
  st.ingest(prompt(0, 'investigate'));
  st.ingest(asst(1, 'm1', [toolUse('toolu_1', 'Agent', { description: 'Find the config loader' })], { stop: 'tool_use' }));
  const sub = (sec, type, msg) => ({ sessionId: SID, agentId: 'abc', isSidechain: true, timestamp: at(sec), type, message: msg });
  st.ingest(sub(2, 'user', { role: 'user', content: 'Find where config is loaded' }), subFile);
  st.ingest(sub(3, 'assistant', { id: 'sm1', model: 'claude-haiku-4-5', content: [toolUse('s1', 'Grep', { pattern: 'loadConfig' })], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 40 } }), subFile);

  let s = st.summarize(st.sessions.get(SID));
  assert.equal(s.status, 'tool');
  assert.equal(s.subagents.length, 1);
  assert.equal(s.subagents[0].status, 'running');
  assert.equal(s.subagents[0].type, 'Explore');
  assert.equal(s.subagents[0].description, 'Find the config loader');
  assert.equal(s.subagents[0].tool, 'Grep · loadConfig');
  assert.equal(s.subagents[0].outputTokens, 40);
  // Subagent spend counts toward the session, but not toward its context window.
  assert.equal(s.byModel.find(m => m.model === 'claude-haiku-4-5').output, 40);

  st.ingest(toolResult(4, 'toolu_1'));
  s = st.summarize(st.sessions.get(SID));
  assert.equal(s.subagents[0].status, 'done');
  assert.equal(s.status, 'working');
});

test('subagent read after the parent already finished it is still done', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-'));
  fs.writeFileSync(path.join(dir, 'agent-late.meta.json'), JSON.stringify({ toolUseId: 'toolu_9' }));
  const st = storeAt(0);
  st.ingest(asst(1, 'm1', [toolUse('toolu_9', 'Agent', {})], { stop: 'tool_use' }));
  st.ingest(toolResult(2, 'toolu_9'));
  st.ingest({ sessionId: SID, agentId: 'late', isSidechain: true, timestamp: at(1), type: 'user', message: { role: 'user', content: 'task' } },
    path.join(dir, 'agent-late.jsonl'));
  assert.equal(st.summarize(st.sessions.get(SID)).subagents[0].status, 'done');
});

test('promptText ignores non-human user messages and unwraps slash commands', () => {
  assert.equal(promptText('<command-name>/compact</command-name>\n<command-args>keep tests</command-args>'), '/compact keep tests');
  assert.equal(promptText('<local-command-stdout>ok</local-command-stdout>'), null);
  assert.equal(promptText([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), null);
  assert.equal(promptText('This session is being continued from a previous conversation that ran out of context.'), null);
  assert.equal(promptText([{ type: 'text', text: 'hello' }]), 'hello');
});

test('interrupts return the session to the user', () => {
  const st = storeAt(0);
  st.ingest(prompt(0, 'go'));
  st.ingest(asst(1, 'm1', [toolUse('t1', 'Bash', { command: 'sleep 100' })], { stop: 'tool_use' }));
  st.ingest(base(2, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }));
  const s = st.summarize(st.sessions.get(SID));
  assert.equal(s.status, 'waiting');
  assert.equal(s.turns, 1);
});

test('local slash commands return to waiting once their output is printed', () => {
  const st = storeAt(0);
  st.ingest(prompt(0, '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'));
  assert.equal(st.summarize(st.sessions.get(SID)).status, 'working');
  assert.equal(st.summarize(st.sessions.get(SID)).lastPrompt, '/compact');
  st.ingest(base(60, { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', postTokens: 5000 } }));
  // Claude Code replays the command into the compacted transcript with its original timestamp.
  st.ingest(prompt(0, '<command-name>/compact</command-name>'));
  st.ingest(prompt(61, '<local-command-stdout>Compacted</local-command-stdout>'));
  const s = st.summarize(st.sessions.get(SID));
  assert.equal(s.status, 'waiting');
  assert.equal(s.context.tokens, 5000);
  assert.equal(s.compactions, 1);
  assert.equal(s.turns, 1);
});

test('metadata-only events update title and mode without counting as activity', () => {
  const st = storeAt(0);
  st.ingest(prompt(0, 'go'));
  st.ingest({ type: 'ai-title', sessionId: SID, aiTitle: 'Fix flaky tests' });
  st.ingest({ type: 'permission-mode', sessionId: SID, permissionMode: 'acceptEdits' });
  const s = st.summarize(st.sessions.get(SID));
  assert.equal(s.title, 'Fix flaky tests');
  assert.equal(s.permissionMode, 'acceptEdits');
  assert.equal(s.lastActivity, T0);
});

test('a fork is linked to its original, and its copied history is not counted twice', () => {
  const st = storeAt(0);
  const line = (sid, uuid, sec, extra) => ({ ...base(sec, extra), sessionId: sid, uuid });
  const usage = { input_tokens: 1000, output_tokens: 1000 };
  // The original: one prompt and one reply.
  st.ingest(line(SID, 'u1', 0, { type: 'user', message: { role: 'user', content: 'plan the release' } }));
  st.ingest(line(SID, 'u2', 1, { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage } }));
  // The fork starts with copies of those lines (same uuids, old timestamps), then its own.
  st.ingest(line('fork-1', 'u1', 0, { type: 'user', message: { role: 'user', content: 'plan the release' } }));
  st.ingest(line('fork-1', 'u2', 1, { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage } }));
  st.ingest(line('fork-1', 'u3', 100, { type: 'user', message: { role: 'user', content: 'now try another way' } }));
  st.ingest(line('fork-1', 'u4', 101, { type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'sure' }], stop_reason: 'end_turn', usage } }));

  const orig = st.summarize(st.sessions.get(SID));
  const fork = st.summarize(st.sessions.get('fork-1'));
  assert.equal(fork.forkedFrom, SID);
  assert.equal(orig.forkedFrom, null);
  assert.equal(fork.turns, 1, 'only the fork’s own prompt');
  assert.equal(fork.apiCalls, 1);
  assert.equal(fork.startedAt, T0 + 100_000, 'the fork starts when it was made, not when the copied lines were');
  assert.ok(Math.abs(fork.cost.usd - orig.cost.usd) < 1e-12, 'each side pays for its own call only');
});
