// Anthropic first-party list prices, USD per million tokens.
// Cache writes are billed at 1.25x input (5-minute TTL) or 2x input (1-hour TTL).
// Cache reads vary by model, so each entry states its own rate.
// Bedrock / Vertex bill at partner rates, so treat estimates there as approximate.
//
// Order matters: the first entry whose `match` is a substring of the model id wins,
// so more specific ids (e.g. "claude-fable-5-1") must come before broader ones ("claude-fable-5").
const MODELS = [
  { match: 'claude-fable-5-1',  input: 10, output: 50, cacheRead: 0.25, context: 1_000_000 },
  { match: 'claude-mythos-5-1', input: 10, output: 50, cacheRead: 0.25, context: 1_000_000 },
  { match: 'claude-fable-5',    input: 10, output: 50, cacheRead: 1.00, context: 1_000_000 },
  { match: 'claude-mythos-5',   input: 10, output: 50, cacheRead: 1.00, context: 1_000_000 },
  { match: 'claude-opus-5-5',   input: 4,  output: 20, cacheRead: 0.20, context: 1_000_000 },
  { match: 'claude-opus-5',     input: 5,  output: 25, cacheRead: 0.50, context: 1_000_000 },
  { match: 'claude-opus-4-8',   input: 5,  output: 25, cacheRead: 0.50, context: 1_000_000 },
  { match: 'claude-opus-4-7',   input: 5,  output: 25, cacheRead: 0.50, context: 1_000_000 },
  { match: 'claude-opus-4-6',   input: 5,  output: 25, cacheRead: 0.50, context: 1_000_000 },
  { match: 'claude-opus-4-5',   input: 5,  output: 25, cacheRead: 0.50, context: 200_000 },
  { match: 'claude-opus-4',     input: 15, output: 75, cacheRead: 1.50, context: 200_000 },
  { match: 'claude-sonnet-5-5', input: 2,  output: 10, cacheRead: 0.20, context: 1_000_000 },
  { match: 'claude-sonnet-5',   input: 2,  output: 10, cacheRead: 0.20, context: 1_000_000 },
  { match: 'claude-sonnet-4-6', input: 3,  output: 15, cacheRead: 0.30, context: 1_000_000 },
  { match: 'claude-sonnet-4',   input: 3,  output: 15, cacheRead: 0.30, context: 200_000 },
  { match: 'claude-haiku-4-5',  input: 1,  output: 5,  cacheRead: 0.10, context: 200_000 },
  { match: 'claude-3-5-haiku',  input: 0.8, output: 4, cacheRead: 0.08, context: 200_000 },
];

const DEFAULT_CONTEXT = 200_000;

export function modelInfo(model) {
  if (!model) return null;
  // Bedrock/Vertex ids look like "us.anthropic.claude-opus-4-7" or "claude-opus-4-5@20251101".
  return MODELS.find(m => model.includes(m.match)) || null;
}

export function contextWindow(model) {
  return modelInfo(model)?.context ?? DEFAULT_CONTEXT;
}

/**
 * Cost of a usage bucket. Returns null when the model is unknown,
 * so callers can show "unknown" instead of a made-up number.
 */
export function costOf(model, u) {
  const p = modelInfo(model);
  if (!p) return null;
  return (
    u.input * p.input +
    u.output * p.output +
    u.cacheWrite5m * p.input * 1.25 +
    u.cacheWrite1h * p.input * 2 +
    u.cacheRead * p.cacheRead
  ) / 1_000_000;
}

export function emptyUsage() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

/** Normalise an API `usage` object into our bucket shape. */
export function usageFromApi(usage = {}) {
  const write = usage.cache_creation_input_tokens || 0;
  const split = usage.cache_creation;
  // Older transcripts only have the total; treat it as 5-minute writes.
  const write1h = split?.ephemeral_1h_input_tokens || 0;
  const write5m = split ? (split.ephemeral_5m_input_tokens || 0) : write;
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheRead: usage.cache_read_input_tokens || 0,
  };
}
