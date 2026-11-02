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

// ---------- identity-based pairing (senior sw_cc08f453) ----------
const tsx = sec => new Date(Date.now() - 60_000 + sec * 1000).toISOString();
const tstart = (sec, turn, window) => ({ timestamp: tsx(sec), type: 'event_msg', payload: { type: 'task_started', turn_id: turn, model_context_window: window } });
const tctx = (sec, turn, model) => ({ timestamp: tsx(sec), type: 'turn_context', payload: { ...(turn ? { turn_id: turn } : {}), cwd: '/tmp/proj', model } });
const tcount = (sec, total, window) => countEv(sec, total, window);

test('(b) claude: a rejected replayed opus line leaves compaction on haiku’s window', () => {
  const st = mk();
  st.ingest(asst(20, 'm1', { input_tokens: 40_000, output_tokens: 0 }, 'claude-haiku-4-5'));
  st.ingest(asst(10, 'm0', { input_tokens: 5000, output_tokens: 0 }, 'claude-opus-5-5'));
  st.ingest(compactEv(30, { postTokens: 20_000 }));
  const c = ctxOf(st);
  assert.equal(c.model, 'claude-haiku-4-5'); assert.equal(c.window, 200_000); assert.equal(c.pct, 10);
});

test('(c) claude main and child: a streamed line without a model keeps its message’s model; a new id stays unknown', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', { input_tokens: 1000, output_tokens: 10 }, 'claude-sonnet-4-6'));
  st.ingest(asst(2, 'm1', { input_tokens: 1000, output_tokens: 20 }, null));
  let c = ctxOf(st);
  assert.equal(c.model, 'claude-sonnet-4-6'); assert.equal(c.window, 1_000_000); assert.equal(c.tokens, 1020);
  st.ingest(asst(3, 'm2', { input_tokens: 2000, output_tokens: 0 }, null));
  c = ctxOf(st);
  assert.equal(c.model, null); assert.equal(c.window, null); assert.equal(c.pct, null); assert.equal(c.tokens, 2000);
  const sub = (sec, id, model, out) => ({ sessionId: SID, agentId: 'k', isSidechain: true, timestamp: at(sec), type: 'assistant', message: { id, ...(model ? { model } : {}), content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 500, output_tokens: out } } });
  st.ingest(sub(4, 'c1', 'claude-haiku-4-5', 1)); st.ingest(sub(5, 'c1', undefined, 2));
  let k = st.summarize(st.sessions.get(SID)).subagents[0].context;
  assert.equal(k.model, 'claude-haiku-4-5'); assert.equal(k.window, 200_000);
  st.ingest(sub(6, 'c2', undefined, 3));
  k = st.summarize(st.sessions.get(SID)).subagents[0].context;
  assert.equal(k.window, null); assert.equal(k.model, null);
});

test('claude: compaction with no prior reading shows postTokens with window unknown', () => {
  const st = mk();
  st.ingest(compactEv(5, { postTokens: 3000 }));
  const c = ctxOf(st);
  assert.equal(c.tokens, 3000); assert.equal(c.window, null); assert.equal(c.pct, null);
});

const tdone = (sec, turn) => ({ timestamp: tsx(sec), type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: 'ok' } });
const tabort = (sec, turn) => ({ timestamp: tsx(sec), type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' } });

test('claude: a model-only line is evidence for a later usage line of the same message.id; conflicts are unknown', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', undefined, 'claude-haiku-4-5', {}));
  st.ingest(asst(2, 'm1', { input_tokens: 1000, output_tokens: 1 }, null));
  let c = ctxOf(st);
  assert.equal(c.model, 'claude-haiku-4-5'); assert.equal(c.window, 200_000);
  st.ingest(asst(3, 'm2', undefined, 'claude-haiku-4-5', {}));
  st.ingest(asst(4, 'm2', undefined, 'claude-opus-5-5', {}));
  st.ingest(asst(5, 'm2', { input_tokens: 1000, output_tokens: 2 }, null));
  c = ctxOf(st);
  assert.equal(c.model, null); assert.equal(c.window, null);
  const sub = (sec, id, model, usage) => ({ sessionId: SID, agentId: 'k', isSidechain: true, timestamp: at(sec), type: 'assistant', message: { id, ...(model ? { model } : {}), content: [{ type: 'text', text: 'x' }], ...(usage ? { usage } : {}) } });
  st.ingest(sub(6, 'c1', 'claude-haiku-4-5')); st.ingest(sub(7, 'c1', null, { input_tokens: 50, output_tokens: 1 }));
  let k = st.summarize(st.sessions.get(SID)).subagents[0].context;
  assert.equal(k.model, 'claude-haiku-4-5'); assert.equal(k.window, 200_000);
  st.ingest(sub(8, 'c2', 'claude-haiku-4-5')); st.ingest(sub(9, 'c2', 'claude-opus-5-5')); st.ingest(sub(10, 'c2', null, { input_tokens: 50, output_tokens: 1 }));
  k = st.summarize(st.sessions.get(SID)).subagents[0].context;
  assert.equal(k.model, null); assert.equal(k.window, null);
});

test('claude: a known model conflict is not bypassed by a later line’s own model', () => {
  const st = mk();
  st.ingest(asst(1, 'm1', undefined, 'claude-haiku-4-5', {}));
  st.ingest(asst(2, 'm1', undefined, 'claude-opus-5-5', {}));
  st.ingest(asst(3, 'm1', { input_tokens: 100, output_tokens: 1 }, 'claude-haiku-4-5'));
  const c = ctxOf(st);
  assert.equal(c.model, null); assert.equal(c.window, null); assert.equal(c.tokens, 101);
});

// ---------- Codex: same-record-only context (ADR-004) ----------
const xtc = (sec, model = 'gpt-test', turn = 'T1') => tctx(sec, turn, model);

test('codex: a count with its own window gives the exact percent; the model is not reported', () => {
  const c = cx([meta(ids.a), turnContext(), started(), tcount(5, 100_000, 400_000)]).sum().context;
  assert.equal(c.tokens, 100_000); assert.equal(c.window, 400_000); assert.equal(c.pct, 25);
  assert.equal(c.model, null); assert.equal(c.windowSource, 'reported'); assert.equal(c.modelNote, 'not reported');
});

test('codex: a count without a window has an unknown window, never one from another record', () => {
  const c = cx([meta(ids.a), tstart(1, 'T1', 400_000), xtc(2), tcount(3, 100_000, 400_000), tcount(4, 50_000, undefined)]).sum().context;
  assert.equal(c.tokens, 50_000); assert.equal(c.window, null); assert.equal(c.pct, null);
  const first = cx([meta(ids.a), tstart(1, 'T1', 400_000), xtc(2), tcount(3, 60_000, undefined)]).sum().context;
  assert.equal(first.window, null, 'task_started window is not used');
});

test('codex: task_started, turn_context and close events, in any order, replayed or duplicated, never change context', () => {
  const noise = [tstart(6, 'T1', 999), xtc(7, 'other'), tdone(8, 'T1'), tabort(9, 'T1'), tstart(10, 'T1', 1), tstart(1, 'T0', 5), tdone(2, 'T0'), xtc(3, 'x', 'Z'), xtc(11, 'y', null)];
  const base = [meta(ids.a), tstart(1, 'T1', 400_000), xtc(2), tcount(5, 100_000, 400_000)];
  const before = cx(base).sum().context;
  for (const order of [noise, [...noise].reverse(), [...noise, ...noise]]) {
    const c = cx([...base, ...order]).sum().context;
    assert.deepEqual(c, before);
  }
});

test('codex: a window-only record shows used unknown of N with no reading, and is ignored after one', () => {
  const lone = [meta(ids.a), turnContext(), ev(3, { type: 'token_count', info: { model_context_window: 100 } })];
  let c = cx(lone).sum().context;
  assert.equal(c.tokens, null); assert.equal(c.window, 100); assert.equal(c.pct, null); assert.equal(c.model, null);
  c = cx([...lone, ev(2, { type: 'token_count', info: { model_context_window: 7 } })]).sum().context;
  assert.equal(c.window, 100, 'the newest limit wins; an older one is ignored');
  c = cx([meta(ids.a), turnContext(), tcount(5, 40_000, 200_000), ev(6, { type: 'token_count', info: { model_context_window: 999 } })]).sum().context;
  assert.equal(c.window, 200_000); assert.equal(c.pct, 20);
  c = cx([...lone, ev(4, { type: 'token_count', info: { last_token_usage: { total_tokens: 5 } } })]).sum().context;
  assert.equal(c.tokens, 5); assert.equal(c.window, null, 'the partial limit is not carried into a count without a window');
});

test('codex: a replayed older token_count and an older partial limit are ignored', () => {
  let c = cx([meta(ids.a), turnContext(), tcount(9, 80_000, 400_000), tcount(2, 10_000, 50_000)]).sum().context;
  assert.equal(c.tokens, 80_000); assert.equal(c.window, 400_000);
  c = cx([meta(ids.a), turnContext(), tcount(9, 80_000, 400_000), ev(2, { type: 'token_count', info: { model_context_window: 50_000 } })]).sum().context;
  assert.equal(c.window, 400_000);
});

test('codex: compaction marks the reading stale and keeps its own window; the next count replaces it', () => {
  const pre = [meta(ids.a), turnContext(), tcount(5, 300_000, 400_000), compactedEv(6)];
  let c = cx(pre).sum().context;
  assert.equal(c.tokens, null); assert.equal(c.pct, null); assert.equal(c.stale, 'compacted'); assert.equal(c.window, 400_000);
  c = cx([...pre, tcount(8, 20_000, 400_000)]).sum().context;
  assert.equal(c.tokens, 20_000); assert.equal(c.pct, 5); assert.equal(c.stale, null);
});

test('codex: failed 9377a3f sequences (eviction, replay, older open turn) have no effect on context', () => {
  // many closed turns, then a replayed evicted turn's start/context, then a count with no window
  const evs = [meta(ids.a)];
  for (let i = 0; i < 250; i++) evs.push(tstart(1 + i * 0.01, `T${i}`, 100_000), xtc(1 + i * 0.01, 'A', `T${i}`), tdone(1 + i * 0.01, `T${i}`));
  evs.push(tstart(30, 'T0', 100_000), xtc(30, 'A', 'T0'), tcount(31, 10_000, undefined));
  let c = cx(evs).sum().context;
  assert.equal(c.window, null); assert.equal(c.model, null); assert.equal(c.pct, null);
  // an older open turn's window must not back-fill a later count
  c = cx([meta(ids.a), tstart(1, 'T1', 100_000), xtc(2), tstart(3, 'T2', 200_000), xtc(4, 'B', 'T2'), tdone(5, 'T2'), tcount(6, 10_000, undefined)]).sum().context;
  assert.equal(c.window, null); assert.equal(c.model, null);
  // equal-time restart of a completed turn
  c = cx([meta(ids.a), tstart(1, 'T1', 100_000), tdone(5, 'T1'), tstart(5, 'T1', 100_000), tcount(6, 10_000, undefined)]).sum().context;
  assert.equal(c.window, null);
});
