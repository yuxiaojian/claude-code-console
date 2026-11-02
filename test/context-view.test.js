import { test } from 'node:test';
import assert from 'node:assert/strict';

// public/core.js touches browser globals at import; stub the few it needs.
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = globalThis;
const { contextView, childContextView, contextAttrs } = await import('../public/context.js');

const c = (o = {}) => ({ tokens: null, window: null, pct: null, model: null, windowSource: null, at: null, stale: null, ...o });

test('contextView: known, unknown, compacted, over-limit and unavailable are all textual', () => {
  assert.equal(contextView(c({ tokens: 43_000, window: 100_000, pct: 43, windowSource: 'reported' })).label, 'ctx 43%');
  assert.match(contextView(c({ tokens: 43_000, window: 100_000, pct: 43 })).title, /57% remaining/);
  assert.equal(contextView(c()).label, 'ctx ?');
  assert.equal(contextView(c({ window: 400_000 })).label, 'ctx ?');
  assert.match(contextView(c({ tokens: 5000 })).short, /window unknown/);
  assert.equal(contextView(c({ stale: 'compacted' })).label, 'ctx compacted');
  const over = contextView(c({ tokens: 108, window: 100, pct: 108 }));
  assert.equal(over.label, 'ctx 108%!'); assert.equal(over.bar, 100); assert.match(over.short, /over limit/);
  assert.equal(contextView(undefined).label, 'ctx ?');
  assert.equal(contextView(c({ tokens: 0, window: 100, pct: 0 })).label, 'ctx 0%');
});

test('contextView: tokens-only reads "no window"; child with no evidence says unavailable; full text is accessible', () => {
  assert.equal(contextView(c({ tokens: 1000 })).label, 'ctx 1.0K · no window');
  assert.equal(childContextView(c()).label, 'context unavailable');
  assert.equal(childContextView(undefined).label, 'context unavailable');
  assert.equal(childContextView(c({ stale: 'compacted' })).label, 'ctx compacted');
  const full = contextAttrs(contextView(c({ tokens: 86_000, window: 200_000, pct: 43, model: 'claude-opus-4-5', windowSource: 'model-table', at: Date.now() })));
  assert.match(full['aria-label'], /86,000 of 200,000 tokens used \(43%, 57% remaining\)/);
  assert.match(full['aria-label'], /opus-4-5/); assert.match(full['aria-label'], /as of/); assert.match(full['aria-label'], /model table/);
  assert.match(full['aria-label'], /Last reported request/);
});

test('contextView: a Codex reading says the model is not reported, never a session model', () => {
  const v = contextView(c({ tokens: 40_000, window: 200_000, pct: 20, windowSource: 'reported', modelNote: 'not reported' }));
  assert.match(v.title, /model not reported/); assert.match(v.title, /window reported by the provider/);
  assert.equal(v.label, 'ctx 20%');
});
