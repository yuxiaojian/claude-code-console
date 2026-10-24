import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStore, usageFromCodex } from '../src/codex/store.js';
import { agent, aborted, call, complete, count, ids, ingestFiles, meta, output, started, turnContext, usage, user, writeRollouts } from './codex-helpers.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex', 'rollout-0.164.0-exec.jsonl');

test('a captured 0.164.0 exec rollout: status, prompts, usage and context', () => {
  const store = new CodexStore();
  ingestFiles(store, [FIXTURE]);
  const [s] = store.snapshot(Date.parse('2026-10-24T21:17:00Z'));
  assert.equal(s.id, '01a16fc5-2236-70f3-a6b9-922d03763852');
  assert.equal(s.provider, 'codex');
  assert.equal(s.entrypoint, 'exec');
  assert.equal(s.model, 'gpt-6.1-sol');
  assert.deepEqual(s.policy, { approval: 'on-request', sandbox: 'read-only' });
  assert.equal(s.turns, 2);
  assert.match(s.lastPrompt, /touch probe\.txt/);
  assert.equal(s.status, 'waiting');
  assert.equal(s.apiCalls, 4, 'one per token_usage_record');
  // The four records sum to the thread total Codex reported (55,438 in / 104 out).
  const t = s.tokens;
  assert.equal(t.input + t.cacheRead + t.cacheWrite5m, 55_438);
  assert.equal(t.output, 104);
  assert.equal(t.cacheRead, 41_238);
  assert.equal(s.context.window, 475_000);
  assert.equal(s.context.tokens, 14_197);
  assert.equal(s.cost.usd, null, 'no known price for this model');
  assert.equal(s.cost.source, 'unknown');
  assert.deepEqual(s.cost.unknownModels, ['gpt-6.1-sol']);
  assert.equal(s.cost.incomplete, true);
});

test('usage mapping: cached input and cache writes come out of input_tokens', () => {
  assert.deepEqual(usageFromCodex({ input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 20 }),
    { input: 300, output: 50, cacheWrite5m: 100, cacheWrite1h: 0, cacheRead: 600 });
  assert.deepEqual(usageFromCodex({ input_tokens: -5, output_tokens: 'x' }), { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
});

test('only CLI and console-started threads are shown; IDE, app-server and empty ones are not', () => {
  const f = writeRollouts({
    cli: [meta(ids.a), user('hi')],
    exec: [meta(ids.b, { source: 'exec' }), user('hi')],
    ide: [meta(ids.c, { source: 'vscode', originator: 'codex_vscode', thread_source: 'user' }), user('hi')],
    console: [meta(ids.d, { source: 'vscode', originator: 'codex_exec', thread_source: 'claude_code_console' }), user('hi')],
    empty: [meta('01a10000-0000-7000-8000-0000000000ee')],
  });
  const store = new CodexStore();
  ingestFiles(store, Object.values(f));
  assert.deepEqual(store.snapshot().map(s => s.id).sort(), [ids.a, ids.b, ids.d].sort());
  assert.equal(store.get(ids.c), null);
});

test('console-started threads stay shown after a restart (thread_source is in the rollout)', () => {
  const f = writeRollouts({ console: [meta(ids.d, { source: 'vscode', thread_source: 'claude_code_console' }), user('hi')] });
  const fresh = new CodexStore();
  ingestFiles(fresh, [f.console]);
  assert.equal(fresh.snapshot().length, 1);
});

test('status follows the rollout: working, running tool, waiting, interrupted', () => {
  const store = new CodexStore();
  const f = '/x/rollout.jsonl';
  const feed = e => store.ingest(e, f);
  feed(meta(ids.a));
  feed(turnContext());
  feed(started());
  feed(user('do it'));
  const now = Date.now();
  assert.equal(store.snapshot(now)[0].status, 'working');
  feed(call('call_1'));
  let s = store.snapshot(now)[0];
  assert.equal(s.status, 'tool');
  assert.equal(s.currentTool.name, 'exec');
  assert.equal(s.currentTool.target, 'ls -la');
  feed(output('call_1'));
  assert.equal(store.snapshot(now)[0].status, 'working');
  feed({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_2', name: 'exec', input: 'text(await tools.exec_command({cmd:"npm test -- --watch",yield_time_ms:1000}))' } });
  assert.equal(store.snapshot(now)[0].currentTool.target, 'npm test -- --watch', 'code-mode scripts show the command they run');
  feed(output('call_2'));
  feed(agent('done'));
  feed(complete());
  assert.equal(store.snapshot(now)[0].status, 'waiting');
  feed(user('again', 8));
  feed(aborted(9));
  s = store.snapshot(now)[0];
  assert.equal(s.status, 'waiting');
  assert.ok(s.log.some(l => l.text === 'Interrupted by user'));
});

test('lines before session_meta, malformed lines and unknown events change nothing', () => {
  const store = new CodexStore();
  const f = '/x/r.jsonl';
  store.ingest(user('orphan'), f);
  store.ingestLine('{not json', f);
  store.ingestLine('{"type":"session_meta","payload":{"id":"../../etc/passwd"}}', f);
  assert.equal(store.sessions.size, 0);
  store.ingest(meta(ids.a), f);
  store.ingest({ type: 'something_new', payload: { type: 'whatever' } }, f);
  store.ingest({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FutureItem', id: 'z' } } }, f);
  store.ingest({ type: 'event_msg', payload: null }, f);
  store.ingest(user('hi'), f);
  assert.equal(store.snapshot()[0].turns, 1);
});

test('usage counts once per response id and only for the file’s own thread', () => {
  const store = new CodexStore();
  const f = '/x/r.jsonl';
  const feed = e => store.ingest(e, f);
  feed(meta(ids.a));
  feed(turnContext());
  feed(user('hi'));
  feed(usage(ids.a, 'resp_1'));
  feed(usage(ids.a, 'resp_1'));                               // the same record again
  feed(usage(ids.b, 'resp_2'));                               // another thread's record
  feed(usage(ids.a, null));                                   // no response id
  feed(usage(ids.a, 'resp_3', {}, 4, { session_id: ids.b })); // owners disagree
  feed(usage(undefined, 'resp_4', {}, 4, { session_id: undefined })); // no owner at all
  feed(count(1234));
  const s = store.snapshot()[0];
  assert.equal(s.apiCalls, 1);
  assert.equal(s.tokens.output, 50);
  assert.equal(s.cost.usageSkipped, 4);
  assert.equal(s.cost.incomplete, true);
  assert.equal(s.context.tokens, 1234, 'running totals are context, never summed into usage');
});

test('re-reading a file (tailer restart) never recounts usage', () => {
  const f = writeRollouts({ a: [meta(ids.a), turnContext(), user('hi'), usage(ids.a, 'r1'), usage(ids.a, 'r2')] });
  const store = new CodexStore();
  ingestFiles(store, [f.a, f.a]);
  assert.equal(store.snapshot()[0].apiCalls, 2);
  assert.equal(store.snapshot()[0].turns, 2, 'turns are display only; usage is what must not double');
});

test('forks: usage stays with its own file whatever the discovery order; nested ancestry resolves', () => {
  const f = writeRollouts({
    a: [meta(ids.a), turnContext(), user('root'), usage(ids.a, 'ra')],
    b: [meta(ids.b, { source: 'cli', forked_from_id: ids.a, history_base: { thread_id: ids.a, end_byte_offset: 0 } }), turnContext(), user('fork'), usage(ids.b, 'rb')],
    c: [meta(ids.c, { source: 'cli', forked_from_id: ids.b, history_base: { thread_id: ids.b, end_byte_offset: 0 } }), turnContext(), user('fork2'),
      usage(ids.a, 'ra')], // an inherited record copied into the fork: not this file's thread
  });
  for (const order of [[f.a, f.b, f.c], [f.c, f.b, f.a]]) {
    const store = new CodexStore();
    ingestFiles(store, order);
    const by = Object.fromEntries(store.snapshot().map(s => [s.id, s]));
    assert.equal(by[ids.a].apiCalls, 1);
    assert.equal(by[ids.b].apiCalls, 1);
    assert.equal(by[ids.c].apiCalls, 0);
    assert.equal(by[ids.c].cost.usageSkipped, 1);
    assert.equal(by[ids.c].forkedFrom, ids.b);
    const { chain, missing } = store.ancestry(ids.c);
    assert.equal(missing, null);
    assert.deepEqual(chain.map(l => l.id), [ids.a, ids.b], 'oldest first');
  }
});

test('ancestry: missing, cyclic, invalid and mismatched references are reported, not followed', () => {
  const store = new CodexStore();
  const base = (id, parent, extra = {}) => meta(id, { forked_from_id: parent, history_base: { thread_id: parent, end_byte_offset: 10 }, ...extra });
  store.ingest(base(ids.a, ids.b), '/x/a.jsonl');
  assert.deepEqual(store.ancestry(ids.a).missing, { id: ids.b, reason: 'not loaded' });
  store.ingest(base(ids.b, ids.a), '/x/b.jsonl');
  assert.equal(store.ancestry(ids.a).missing.reason, 'cyclic reference');
  store.ingest(base(ids.c, '../../../etc/passwd'), '/x/c.jsonl');
  assert.equal(store.ancestry(ids.c).missing.reason, 'invalid reference');
  store.ingest(meta(ids.d, { forked_from_id: ids.a, history_base: { thread_id: ids.b, end_byte_offset: 10 } }), '/x/d.jsonl');
  assert.equal(store.ancestry(ids.d).missing.reason, 'invalid reference');
  const e = '01a10000-0000-7000-8000-0000000000e1';
  store.ingest(meta(e, { history_base: { thread_id: ids.a, end_byte_offset: -1 } }), '/x/e.jsonl');
  assert.equal(store.ancestry(e).missing.reason, 'invalid offset');
});

test('ancestry is bounded for long fork chains', () => {
  const store = new CodexStore();
  const id = n => `01a10000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  for (let n = 1; n <= 30; n++) store.ingest(meta(id(n), { history_base: { thread_id: id(n - 1), end_byte_offset: 0 } }), `/x/${n}.jsonl`);
  const { chain, missing } = store.ancestry(id(30));
  assert.ok(chain.length <= 17);
  assert.equal(missing.reason, 'too many nested forks');
});

test('subagents attach to their parent in either discovery order, and their usage counts there', () => {
  const spawn = { subagent: { thread_spawn: { parent_thread_id: ids.a, depth: 1, agent_role: 'worker', agent_nickname: 'Scout' } } };
  const f = writeRollouts({
    parent: [meta(ids.a), turnContext(), user('go'), usage(ids.a, 'r1')],
    child: [meta(ids.sub, { source: spawn }), turnContext(), user('sub task'), usage(ids.sub, 'r2'), complete()],
  });
  for (const order of [[f.parent, f.child], [f.child, f.parent]]) {
    const store = new CodexStore();
    ingestFiles(store, order);
    const list = store.snapshot();
    assert.equal(list.length, 1, 'a subagent is not a session of its own');
    const [s] = list;
    assert.equal(s.apiCalls, 2);
    assert.equal(s.subagents.length, 1);
    assert.deepEqual([s.subagents[0].type, s.subagents[0].description, s.subagents[0].status], ['worker', 'Scout', 'done']);
    assert.equal(store.rootOf(ids.sub).id, ids.a);
  }
});

test('a subagent of a hidden (IDE) thread stays hidden', () => {
  const f = writeRollouts({
    parent: [meta(ids.a, { source: 'vscode' }), user('go')],
    child: [meta(ids.sub, { source: { subAgent: { thread_spawn: { parent_thread_id: ids.a, depth: 1 } } } }), user('sub')],
  });
  const store = new CodexStore();
  ingestFiles(store, [f.child, f.parent]);
  assert.equal(store.snapshot().length, 0);
});

test('error events are shown redacted', () => {
  const store = new CodexStore();
  store.ingest(meta(ids.a), '/x/r.jsonl');
  store.ingest(user('hi'), '/x/r.jsonl');
  store.ingest({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'error', message: 'sk-proj-abcdefghijklmnop rejected for /Users/someone/secret/file' } }, '/x/r.jsonl');
  const s = store.snapshot()[0];
  assert.equal(s.status, 'error');
  assert.doesNotMatch(s.error.message, /sk-proj|someone/);
});

test('prune drops old sessions and their dedupe state; new lines continue without recounting', () => {
  const store = new CodexStore();
  const f = '/x/r.jsonl';
  store.ingest(meta(ids.a), f);
  store.ingest(user('hi'), f);
  store.ingest(usage(ids.a, 'r1'), f);
  store.prune(Date.now() + 1000);
  assert.equal(store.sessions.size, 0);
  store.ingest(user('back'), f);
  store.ingest(usage(ids.a, 'r2'), f);
  const [s] = store.snapshot();
  assert.equal(s.apiCalls, 1);
  assert.equal(s.cwd, '/tmp/proj', 'session_meta survives the prune');
});

test('the captured fixture holds nothing secret-looking', () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]|Bearer |\/Users\//);
});

test('the Codex watcher never creates the Codex folder', async () => {
  const { TranscriptWatcher } = await import('../src/watcher.js');
  const os = await import('node:os');
  const root = path.join(os.tmpdir(), `ccc-no-codex-${process.pid}-${Date.now()}`, 'sessions');
  const w = new TranscriptWatcher({ root, sinceMs: 0, onLine: () => {}, create: false });
  await w.start();
  w.stop();
  assert.equal(fs.existsSync(root), false);
});
