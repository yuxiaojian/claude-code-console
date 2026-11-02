// Context-window measurements, shared by both providers.
//
// A measurement is the last reported request's occupancy, pinned with the model, window,
// window source and time it was taken. Used tokens and the window are independently
// nullable: null means "not reported", never zero. A later model change does not rescale
// an old measurement; only a new measurement replaces it.
//
// ctx = { tokens, model, window, windowSource, at, stale }
//   windowSource: 'reported' (the provider said so) | 'model-table' (our static table: an estimate)
//   stale: null | 'compacted' (a compaction invalidated the count; waiting for the next report)

export const newCtx = () => ({ tokens: null, model: null, window: null, windowSource: null, at: null, stale: null });

const validTokens = n => Number.isFinite(n) && n >= 0;
const validWindow = n => Number.isFinite(n) && n > 0;

/** An observation older than the last measurement or compaction is a replay; ignore it. */
export function isReplay(ctx, ts, floor = null) {
  if (!ts) return false;
  return (ctx.at != null && ts < ctx.at) || (floor != null && ts < floor);
}

/** Record a new reading. Returns false (and changes nothing) for a replay. */
export function measure(ctx, { tokens, model = null, window = null, windowSource = null, ts = null }, floor = null) {
  if (isReplay(ctx, ts, floor)) return false;
  ctx.tokens = validTokens(tokens) ? tokens : null;
  ctx.model = model || null;
  ctx.window = validWindow(window) ? window : null;
  ctx.windowSource = ctx.window ? windowSource : null;
  ctx.at = ts ?? ctx.at;
  ctx.stale = null;
  return true;
}

/** A compaction: keep a valid post-compaction count, otherwise invalidate until the next report. */
export function compact(ctx, { postTokens, model = null, window = null, windowSource = null, ts = null }) {
  if (validTokens(postTokens)) {
    ctx.tokens = postTokens;
    ctx.model = model || null;
    ctx.window = validWindow(window) ? window : null;
    ctx.windowSource = ctx.window ? windowSource : null;
    ctx.stale = null;
  } else {
    ctx.tokens = null;
    ctx.stale = 'compacted';
  }
  if (ts) ctx.at = Math.max(ctx.at ?? 0, ts);
}

/** The shape sent to the browser. `pct` (integer, floored, may exceed 100) only when both inputs are usable. */
export function summarizeCtx(ctx) {
  const tokens = validTokens(ctx.tokens) ? ctx.tokens : null;
  const window = validWindow(ctx.window) ? ctx.window : null;
  return {
    tokens,
    window,
    pct: tokens != null && window != null ? Math.floor((tokens / window) * 100) : null,
    model: ctx.model,
    windowSource: window != null ? ctx.windowSource : null,
    at: ctx.at,
    stale: ctx.stale,
  };
}
