import { test } from 'node:test';
import assert from 'node:assert/strict';

// public/core.js touches browser globals at import; stub the few it needs.
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = globalThis;
const { contextView } = await import('../public/context.js');

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
