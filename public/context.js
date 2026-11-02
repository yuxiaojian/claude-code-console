// One formatter for context-window status, so the list, Details, live line and child rows agree.
// Context is the last reported request's occupancy (not live free capacity, not cumulative spend).
import { clock, shortModel, tokens } from './core.js';

const num = n => Number(n).toLocaleString('en-US');

/** { label, level, title, over, bar } for a summary `context` object (or a missing one). */
export function contextView(c) {
  if (!c) return { label: 'ctx ?', short: 'unavailable', level: 'unknown', bar: null, title: 'Context unavailable: nothing reported', over: false };
  const when = c.at ? ` as of ${clock(c.at)}` : '';
  const model = c.model ? ` on ${shortModel(c.model)}` : c.modelNote ? ` (model ${c.modelNote})` : '';
  const src = c.windowSource === 'reported' ? 'window reported by the provider'
    : c.windowSource === 'model-table' ? 'window from the console’s model table (an estimate)' : '';
  const note = 'Last reported request, not live free capacity.';
  if (c.stale === 'compacted') {
    return { label: 'ctx compacted', short: 'compacted · awaiting next report', level: 'unknown', bar: null, over: false,
      title: `Compacted${when}; the new size has not been reported yet. ${note}` };
  }
  if (c.tokens == null && c.window == null) {
    return { label: 'ctx ?', short: 'unknown', level: 'unknown', bar: null, over: false, title: `No context usage reported yet. ${note}` };
  }
  if (c.tokens == null) {
    return { label: 'ctx ?', short: `unknown of ${tokens(c.window)}`, level: 'unknown', bar: null, over: false,
      title: `Used tokens not reported; window ${num(c.window)}${src ? ` (${src})` : ''}. ${note}` };
  }
  if (c.window == null || c.pct == null) {
    return { label: `ctx ${tokens(c.tokens)} · no window`, short: `${tokens(c.tokens)} tokens · window unknown`, level: 'unknown', bar: null, over: false,
      title: `${num(c.tokens)} tokens in the last request${model}${when}; window unknown. ${note}` };
  }
  const over = c.tokens > c.window;
  const left = Math.max(0, 100 - c.pct);
  const level = c.pct >= 80 ? 'high' : c.pct >= 50 ? 'mid' : 'ok';
  return {
    label: `ctx ${c.pct}%${over ? '!' : ''}`,
    short: `${c.pct}% used of ${tokens(c.window)}${over ? ' · over limit' : ''}`,
    level, over, bar: Math.min(100, c.pct),
    title: `${num(c.tokens)} of ${num(c.window)} tokens used (${c.pct}%${over ? ', over limit' : `, ${left}% remaining`})${model}${when}${src ? `; ${src}` : ''}. ${note}`,
  };
}

/** Attributes giving a context element the full description for hover and assistive tech. */
export function contextAttrs(v) {
  return { title: v.title, 'aria-label': `Context ${v.short}. ${v.title}` };
}

/** A subagent row's label: its own reading, or an explicit "context unavailable". */
export function childContextView(c) {
  const v = contextView(c);
  return !c || (c.tokens == null && c.window == null && !c.stale) ? { ...v, label: 'context unavailable', short: 'unavailable' } : v;
}
