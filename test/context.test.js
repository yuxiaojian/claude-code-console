import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { CodexStore } from '../src/codex/store.js';
import { contextWindow } from '../src/pricing.js';
import { ids, meta, turnContext, started, user, agent, ingestFiles, writeRollouts, count } from './codex-helpers.js';

const SID = 'ctx-1';
const T0 = Date.parse('2026-10-24T10:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const base = (sec, extra) => ({ sessionId: SID, timestamp: at(sec), cwd: '/w', isSidechain: false, ...extra });
const asst = (sec, id, usage, model = 'claude-opus-5-5', extra = {}) =>
  base(sec, { type: 'assistant', message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage }, ...extra });
const compactEv = (sec, meta) => base(sec, { type: 'system', subtype: 'compact_boundary', compactMetadata: meta });
const ctxOf = st => st.summarize(st.sessions.get(SID)).context;
const mk = () => new Store({ now: () => T0 + 600_000 });

test('claude: no usage yet is unknown, not 0%', () => {
  const st = mk();
  st.ingest(base(0, { type: 'user', message: { role: 'user', content: 'hello' } }));
  const c = ctxOf(st);
  assert.equal(c.tokens, null); assert.equal(c.window, null); assert.equal(c.pct, null);
});

test('claude: last request occupancy, floored percent, pinned model/window/source/time', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', { input_tokens: 100_000, cache_read_input_tokens: 50_000, output_tokens: 999 }));
  const c = ctxOf(st);
  assert.equal(c.tokens, 150_999);
  assert.equal(c.window, 1_000_000);
  assert.equal(c.pct, 15);
  assert.equal(c.model, 'claude-opus-5-5');
  assert.equal(c.windowSource, 'model-table');
  assert.equal(c.at, T0 + 1000);
});

test('claude: unknown model has no window and no 200k guess; tokens stay known', () => {
  assert.equal(contextWindow('claude-future-9'), null);
  const st = mk();
  st.ingest(asst(1, 'm1', { input_tokens: 1000, output_tokens: 10 }, 'claude-future-9'));
  const c = ctxOf(st);
  assert.equal(c.tokens, 1010); assert.equal(c.window, null); assert.equal(c.pct, null); assert.equal(c.windowSource, null);
});

test('claude: zero, malformed and empty usage', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', { input_tokens: 0, output_tokens: 0 }));
  assert.equal(ctxOf(st).tokens, 0);
  assert.equal(ctxOf(st).pct, 0);
  st.ingest(asst(2, 'm2', {}));            // no counts: not a measurement
  st.ingest(asst(3, 'm3', 'garbage'));
  assert.equal(ctxOf(st).tokens, 0);
  assert.equal(ctxOf(st).at, T0 + 1000);
});

test('claude: model switch does not rescale an old reading, a new one replaces it', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', { input_tokens: 150_000, output_tokens: 0 }, 'claude-opus-5-5'));
  st.ingest(base(2, { type: 'assistant', message: { id: 'syn', model: '<synthetic>', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 5, output_tokens: 5 } }, isApiErrorMessage: true }));
  let c = ctxOf(st);
  assert.equal(c.window, 1_000_000); assert.equal(c.model, 'claude-opus-5-5'); assert.equal(c.tokens, 150_000);
  st.ingest(asst(3, 'm2', { input_tokens: 150_000, output_tokens: 0 }, 'claude-haiku-4-5'));
  c = ctxOf(st);
  assert.equal(c.window, 200_000); assert.equal(c.pct, 75); assert.equal(c.model, 'claude-haiku-4-5');
  st.ingest(asst(4, 'm3', { input_tokens: 210_000, output_tokens: 0 }, 'claude-haiku-4-5'));
  c = ctxOf(st);
  assert.equal(c.pct, 105, 'over-limit is reported, not clamped');
});

test('claude: model switch with no new measurement keeps the measured model', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', { input_tokens: 150_000, output_tokens: 0 }, 'claude-opus-5-5'));
  st.ingest(asst(2, 'm2', undefined, 'claude-haiku-4-5'));
  const s = st.summarize(st.sessions.get(SID));
  assert.equal(s.model, 'claude-haiku-4-5');
  assert.equal(s.context.model, 'claude-opus-5-5');
  assert.equal(s.context.window, 1_000_000);
});

test('claude: compaction with postTokens 0, a count, and no count', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', { input_tokens: 500_000, output_tokens: 0 }));
  st.ingest(compactEv(10, { postTokens: 0 }));
  assert.equal(ctxOf(st).tokens, 0); assert.equal(ctxOf(st).stale, null); assert.equal(ctxOf(st).pct, 0);
  st.ingest(compactEv(20, { postTokens: 7000 }));
  assert.equal(ctxOf(st).tokens, 7000);
  st.ingest(compactEv(30, {}));
  const c = ctxOf(st);
  assert.equal(c.tokens, null); assert.equal(c.pct, null); assert.equal(c.stale, 'compacted');
  st.ingest(asst(31, 'm2', { input_tokens: 9000, output_tokens: 0 }));
  assert.equal(ctxOf(st).tokens, 9000); assert.equal(ctxOf(st).stale, null);
});

test('claude: a replayed pre-compaction line cannot restore an obsolete reading', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', { input_tokens: 500_000, output_tokens: 0 }));
  st.ingest(compactEv(10, { postTokens: 7000 }));
  st.ingest(asst(5, 'm9', { input_tokens: 400_000, output_tokens: 0 }));
  assert.equal(ctxOf(st).tokens, 7000);
  // restart: the same file read again
  st.ingest(asst(1, 'm1', { input_tokens: 500_000, output_tokens: 0 }));
  assert.equal(ctxOf(st).tokens, 7000);
});

test('claude: subagents have their own context; the parent never changes', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', { input_tokens: 40_000, output_tokens: 0 }));
  const sub = (aid, sec, id, usage, model) => ({ sessionId: SID, agentId: aid, isSidechain: true, timestamp: at(sec), type: 'assistant', message: { id, model, content: [{ type: 'text', text: 'x' }], usage } });
  st.ingest(sub('a1', 2, 's1', { input_tokens: 90_000, output_tokens: 10 }, 'claude-haiku-4-5'));
  st.ingest(sub('a2', 3, 's2', { input_tokens: 5000, output_tokens: 5 }, 'claude-future-9'));
  st.ingest({ sessionId: SID, agentId: 'a3', isSidechain: true, timestamp: at(4), type: 'user', message: { role: 'user', content: 'go' } });
  const s = st.summarize(st.sessions.get(SID));
  assert.equal(s.context.tokens, 40_000);
  const by = Object.fromEntries(s.subagents.map(a => [a.id, a.context]));
  assert.equal(by.a1.tokens, 90_010); assert.equal(by.a1.window, 200_000); assert.equal(by.a1.pct, 45);
  assert.equal(by.a2.tokens, 5005); assert.equal(by.a2.pct, null);
  assert.equal(by.a3.tokens, null, 'no evidence: unavailable, not the parent’s value');
  assert.equal(by.a3.window, null);
});

// ---------- Codex ----------
const cx = events => {
  const f = writeRollouts({ a: events });
  const st = new CodexStore();
  ingestFiles(st, [f.a]);
  return { st, sum: () => st.summarize(st.sessions.get(ids.a)) };
};
const countEv = (sec, total, window, extra = {}) => ({ timestamp: new Date(Date.now() - 60_000 + sec * 1000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: total }, ...(window === undefined ? {} : { model_context_window: window }), ...extra } } });
const compactedEv = sec => ({ timestamp: new Date(Date.now() - 60_000 + sec * 1000).toISOString(), type: 'event_msg', payload: { type: 'context_compacted' } });

test('codex: no usage yet is unknown; a task_started window alone is not a measurement', () => {
  const { sum } = cx([meta(ids.a), turnContext(), started(), user('hi')]);
  const c = sum().context;
  assert.equal(c.tokens, null); assert.equal(c.window, null); assert.equal(c.pct, null);
});

test('codex: reading pinned to the turn model with the reported window', () => {
  const { sum } = cx([meta(ids.a), turnContext(), started(), user('hi'), count(100_000, 5)]);
  const c = sum().context;
  assert.equal(c.tokens, 100_000); assert.equal(c.window, 400_000); assert.equal(c.pct, 25);
  assert.equal(c.model, 'gpt-test'); assert.equal(c.windowSource, 'reported');
});

test('codex: missing window stays unknown independently; malformed counts ignored', () => {
  const { sum } = cx([meta(ids.a), turnContext(), user('hi'), countEv(5, 1234, undefined), countEv(6, -4), countEv(7, 'x')]);
  const c = sum().context;
  assert.equal(c.tokens, 1234); assert.equal(c.window, null); assert.equal(c.pct, null);
});

test('codex: zero is a real reading and over-limit is not clamped', () => {
  let { sum } = cx([meta(ids.a), turnContext(), started(), count(0, 5)]);
  assert.equal(sum().context.pct, 0);
  ({ sum } = cx([meta(ids.a), turnContext(), started(), count(500_000, 5)]));
  assert.equal(sum().context.pct, 125);
});

test('codex: compaction invalidates the reading until the next token_count', () => {
  const pre = [meta(ids.a), turnContext(), started(), count(300_000, 5), compactedEv(6)];
  let c = cx(pre).sum().context;
  assert.equal(c.tokens, null); assert.equal(c.pct, null); assert.equal(c.stale, 'compacted');
  assert.equal(cx(pre).sum().compactions, 1);
  c = cx([...pre, count(20_000, 8)]).sum().context;
  assert.equal(c.tokens, 20_000); assert.equal(c.pct, 5); assert.equal(c.stale, null);
});

test('codex: an older token_count replayed after compaction is ignored', () => {
  const { sum } = cx([meta(ids.a), turnContext(), started(), count(300_000, 9), compactedEv(10), countEv(2, 280_000, 400_000)]);
  const c = sum().context;
  assert.equal(c.tokens, null); assert.equal(c.stale, 'compacted');
});

test('codex: a model change does not pair an old count with a new window', () => {
  const { sum } = cx([meta(ids.a), turnContext(1, { model: 'm-one' }), started(), count(100_000, 5), turnContext(6, { model: 'm-two' }), { timestamp: new Date(Date.now() - 60_000 + 7000).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't2', model_context_window: 100_000 } }]);
  const c = sum().context;
  assert.equal(c.model, 'm-one'); assert.equal(c.window, 400_000); assert.equal(c.pct, 25);
});

test('codex: children report their own context and leave the parent unchanged', () => {
  const sub = (id, extra) => meta(id, { source: { subagent: { thread_spawn: { parent_thread_id: ids.a, depth: 1 } } }, thread_source: 'subagent', ...extra });
  const f = writeRollouts({
    a: [meta(ids.a), turnContext(), started(), user('hi'), count(40_000, 5)],
    b: [sub(ids.b), turnContext(), started(), count(10_000, 6)],
    c: [sub(ids.c), turnContext()],
  });
  const st = new CodexStore();
  ingestFiles(st, [f.a, f.b, f.c]);
  const s = st.summarize(st.sessions.get(ids.a));
  assert.equal(s.context.tokens, 40_000);
  const by = Object.fromEntries(s.subagents.map(k => [k.id, k.context]));
  assert.equal(by[ids.b].tokens, 10_000); assert.equal(by[ids.b].pct, 2);
  assert.equal(by[ids.c].tokens, null); assert.equal(by[ids.c].pct, null);
});

// ---------- regressions found in QA (ingested through the stores) ----------
const ev = (sec, payload) => ({ timestamp: new Date(Date.now() - 60_000 + sec * 1000).toISOString(), type: 'event_msg', payload });

test('codex: task_started / window-only token_count never alter a pinned reading', () => {
  const { sum } = cx([meta(ids.a), turnContext(), started(), count(80_000, 5),
    ev(6, { type: 'task_started', turn_id: 't2', model_context_window: 200_000 }),
    ev(7, { type: 'token_count', info: { model_context_window: 50_000 } }),
    turnContext(8, { model: 'other-model' })]);
  const c = sum().context;
  assert.equal(c.tokens, 80_000); assert.equal(c.window, 400_000); assert.equal(c.pct, 20);
  assert.equal(c.model, 'gpt-test'); const before = cx([meta(ids.a), turnContext(), started(), count(80_000, 5)]).sum().context;
  assert.ok(Math.abs(c.at - before.at) < 1000, 'time stays that of the measurement, not the later events');
});

test('codex: an old window or count replayed later cannot corrupt the newer reading', () => {
  const { sum } = cx([meta(ids.a), turnContext(), started(), count(80_000, 9), countEv(3, 90_000, 50_000)]);
  const c = sum().context;
  assert.equal(c.tokens, 80_000); assert.equal(c.window, 400_000); assert.equal(c.pct, 20);
});

test('codex: an old compaction replayed after a newer reading does not invalidate it', () => {
  const { sum } = cx([meta(ids.a), turnContext(), started(), count(80_000, 9), compactedEv(4)]);
  const c = sum().context;
  assert.equal(c.tokens, 80_000); assert.equal(c.stale, null);
  assert.equal(sum().compactions, 1, 'the compaction is still counted');
});

test('claude: an old compact_boundary does not replace a newer reading', () => {
  const st = mk();
  st.ingest(asst(20, 'm1', { input_tokens: 60_000, output_tokens: 0 }));
  st.ingest(compactEv(5, { postTokens: 1000 }));
  assert.equal(ctxOf(st).tokens, 60_000);
  st.ingest(compactEv(6, {}));
  assert.equal(ctxOf(st).tokens, 60_000); assert.equal(ctxOf(st).stale, null);
});

test('claude: a subagent compact_boundary updates only that subagent', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', { input_tokens: 40_000, output_tokens: 0 }));
  const sub = (sec, type, extra) => ({ sessionId: SID, agentId: 'a1', isSidechain: true, timestamp: at(sec), type, ...extra });
  st.ingest(sub(2, 'assistant', { message: { id: 's1', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 90_000, output_tokens: 0 } } }));
  st.ingest(sub(3, 'system', { subtype: 'compact_boundary', compactMetadata: { postTokens: 4000 } }));
  let s = st.summarize(st.sessions.get(SID));
  assert.equal(s.subagents[0].context.tokens, 4000); assert.equal(s.subagents[0].context.window, 200_000);
  assert.equal(s.context.tokens, 40_000); assert.equal(s.compactions, 0);
  st.ingest(sub(3.5, 'system', { subtype: 'compact_boundary', compactMetadata: {} }));
  s = st.summarize(st.sessions.get(SID));
  assert.equal(s.subagents[0].context.stale, 'compacted'); assert.equal(s.subagents[0].context.tokens, null);
  st.ingest(sub(1, 'system', { subtype: 'compact_boundary', compactMetadata: { postTokens: 1 } })); // replay
  assert.equal(st.summarize(st.sessions.get(SID)).subagents[0].context.stale, 'compacted');
});

test('claude: a negative or non-numeric usage component makes the reading unknown, never a plausible total', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', { input_tokens: 10_000, output_tokens: 0 }));
  st.ingest(asst(2, 'm2', { input_tokens: 100_000, cache_read_input_tokens: -90_000, output_tokens: 5 }));
  st.ingest(asst(3, 'm3', { input_tokens: '5', output_tokens: 5 }));
  st.ingest(asst(4, 'm4', { input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: -5 }, output_tokens: 5 }));
  const c = ctxOf(st);
  assert.equal(c.tokens, 10_000); assert.equal(c.at, T0 + 1000);
});
