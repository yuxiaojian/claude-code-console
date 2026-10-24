import fsp from 'node:fs/promises';
import { promptText, toolTarget } from './store.js';

// Turns a session's main transcript into conversation items for the viewer.
// Files can be tens of MB (tool outputs, file contents, images), so each one is read
// incrementally, only a trimmed copy of each item is kept, and a few files are cached.

const CACHE_FILES = 6;
const CHUNK = 1 << 20;
const TEXT_MAX = 20_000;     // assistant and user text
const OUTPUT_HEAD = 3_000;   // tool output keeps its start and end
const OUTPUT_TAIL = 2_000;
const INPUT_MAX = 2_000;     // each string field of a tool input
const DIFF_LINES = 400;

export const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
export const headTail = s => (s.length > OUTPUT_HEAD + OUTPUT_TAIL + 100
  ? { text: `${s.slice(0, OUTPUT_HEAD)}\n…\n${s.slice(-OUTPUT_TAIL)}`, truncated: true }
  : { text: s, truncated: false });

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

const DIFF_KEYS = new Set(['old_string', 'new_string', 'content', 'edits']);

function trimInput(input, dropDiffKeys) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (dropDiffKeys && DIFF_KEYS.has(k)) continue;
    if (typeof v === 'string') out[k] = clip(v, INPUT_MAX);
    else if (v && typeof v === 'object') {
      const json = JSON.stringify(v);
      out[k] = json.length > INPUT_MAX * 2 ? clip(json, INPUT_MAX * 2) : v; // big structures become clipped JSON text
    } else out[k] = v;
  }
  return out;
}

/** Diff hunks for file edits, in the shape Claude Code's structuredPatch uses. */
function diffFor(name, input, result) {
  let hunks = Array.isArray(result?.structuredPatch) && result.structuredPatch.length ? result.structuredPatch : null;
  if (!hunks && name === 'Edit' && typeof input?.old_string === 'string') {
    const lines = [...input.old_string.split('\n').map(l => `-${l}`), ...input.new_string.split('\n').map(l => `+${l}`)];
    hunks = [{ oldStart: 0, newStart: 0, lines }];
  }
  if (!hunks && name === 'Write' && typeof input?.content === 'string') {
    hunks = [{ oldStart: 0, newStart: 1, lines: input.content.split('\n').map(l => `+${l}`) }];
  }
  if (!hunks) return null;
  let budget = DIFF_LINES;
  const out = [];
  for (const h of hunks) {
    if (budget <= 0) break;
    const lines = (h.lines || []).slice(0, budget).map(l => clip(String(l), 500));
    budget -= lines.length;
    out.push({ oldStart: h.oldStart, newStart: h.newStart, lines });
  }
  const total = hunks.reduce((n, h) => n + (h.lines?.length || 0), 0);
  return { hunks: out, truncated: total > DIFF_LINES };
}

/** Incremental parser for one transcript file. */
export class Conversation {
  constructor() {
    this.items = [];
    this.tools = new Map();  // tool_use id -> item
    this.seen = new Set();   // line uuids, Claude Code occasionally rewrites a line
    this.compactedAt = null;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
  }

  #push(item) { this.items.push(item); return item; }

  ingest(e) {
    if (!e || typeof e !== 'object') return;
    if (e.isSidechain || e.agentId) return;
    if (e.uuid) {
      if (this.seen.has(e.uuid)) return;
      this.seen.add(e.uuid);
    }
    const at = e.timestamp ? Date.parse(e.timestamp) : null;
    if (e.type === 'user') return this.#user(e, at);
    if (e.type === 'assistant') return this.#assistant(e, at);
    if (e.type === 'system') return this.#system(e, at);
  }

  #user(e, at) {
    const content = e.message?.content;
    if (Array.isArray(content) && content.some(b => b?.type === 'tool_result')) {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        const tool = this.tools.get(b.tool_use_id);
        if (!tool) continue;
        const r = e.toolUseResult && typeof e.toolUseResult === 'object' ? e.toolUseResult : null;
        let text = blockText(b.content);
        if (r && (typeof r.stdout === 'string' || typeof r.stderr === 'string')) {
          text = [r.stdout, r.stderr].filter(Boolean).join(r.stdout && r.stderr ? '\n' : '');
        }
        tool.result = { ...headTail(text || ''), error: Boolean(b.is_error), at };
        const diff = diffFor(tool.name, tool.fullInput, r);
        if (diff) tool.diff = diff;
        delete tool.fullInput;
      }
      return;
    }
    const text = blockText(content);
    if (text.startsWith('[Request interrupted')) return void this.#push({ k: 'info', at, text: 'Interrupted' });
    if (text.startsWith('<local-command-stdout>')) {
      const out = text.replace(/^<local-command-stdout>|<\/local-command-stdout>$/g, '').replace(/\u001b\[[0-9;]*m/g, '').trim();
      const last = this.items.at(-1);
      if (last?.k === 'command' && last.output == null) last.output = clip(out, TEXT_MAX);
      return;
    }
    if (e.isMeta) return;
    if (text.startsWith('This session is being continued from a previous conversation')) {
      return void this.#push({ k: 'summary', at, text: clip(text, TEXT_MAX) });
    }
    if (this.compactedAt && at && at < this.compactedAt) return; // replayed into the compacted transcript
    const prompt = promptText(content);
    if (!prompt) return;
    if (/<command-name>/.test(text)) return void this.#push({ k: 'command', at, text: prompt, output: null });
    this.#push({ k: 'user', at, text: clip(prompt, TEXT_MAX) });
  }

  #assistant(e, at) {
    const msg = e.message || {};
    if (msg.model === '<synthetic>') {
      const text = blockText(msg.content);
      if (e.isApiErrorMessage) this.#push({ k: 'error', at, text: clip(text || 'API error', 2000) });
      else if (text && !text.startsWith('No response requested')) this.#push({ k: 'info', at, text: clip(text, 2000) });
      return;
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type === 'text' && b.text?.trim()) this.#push({ k: 'text', at, text: clip(b.text, TEXT_MAX) });
      else if (b?.type === 'thinking' && b.thinking?.trim()) this.#push({ k: 'thinking', at, text: clip(b.thinking, TEXT_MAX) });
      else if (b?.type === 'tool_use') {
        const editsFile = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name);
        const item = this.#push({
          k: 'tool', at, id: b.id, name: b.name,
          target: toolTarget(b.name, b.input),
          input: trimInput(b.input, editsFile),
          result: null,
        });
        // Kept until the result arrives, for diffs when Claude Code didn't record a patch.
        if (editsFile) item.fullInput = { old_string: b.input?.old_string, new_string: b.input?.new_string, content: b.input?.content };
        if (b.id) this.tools.set(b.id, item);
      }
    }
  }

  #system(e, at) {
    if (e.subtype === 'compact_boundary') {
      if (at) this.compactedAt = at;
      const m = e.compactMetadata || {};
      const tokens = m.preTokens ? ` from ${m.preTokens.toLocaleString('en-US')} tokens` : '';
      this.#push({ k: 'info', at, text: `Conversation compacted${tokens}${m.trigger === 'auto' ? ' (automatically)' : ''}` });
    } else if (e.subtype === 'api_error') {
      const cause = e.error?.error?.message || e.error?.message || e.cause?.code || e.error?.cause?.code || 'API error';
      const retry = e.retryAttempt ? ` (retry ${e.retryAttempt}/${e.maxRetries ?? '?'})` : '';
      const last = this.items.at(-1);
      // Retries arrive one per line; show them as one item that updates.
      if (last?.k === 'error' && last.retrying) Object.assign(last, { at, text: cause + retry });
      else this.#push({ k: 'error', at, text: cause + retry, retrying: Boolean(e.retryAttempt) });
    }
  }

  /** Items without internal fields. */
  view(from, to) {
    return this.items.slice(from, to).map(({ fullInput, ...item }) => item);
  }
}

/**
 * Reads and caches conversations by file, picking up appended bytes on each request.
 * `create` makes the parser for a file (Claude Code's by default). With `end`, only the
 * first `end` bytes are read: a fixed prefix (a Codex fork's inherited history), which must
 * lie within the file and end on a line boundary.
 */
export class TranscriptReader {
  constructor(create = () => new Conversation()) {
    this.create = create;
    this.cache = new Map();
  }

  async read(file, end = null) {
    const key = end == null ? file : `${file}#${end}`;
    let c = this.cache.get(key);
    const st = await fsp.stat(file);
    if (end != null) {
      if (!Number.isSafeInteger(end) || end < 0 || end > st.size) throw new RangeError('Offset outside the file');
      if (end > 0 && !(await endsLine(file, end))) throw new RangeError('Offset is not at a line boundary');
    }
    const size = end ?? st.size;
    if (!c || size < c.offset) c = this.create();
    this.cache.delete(key);
    this.cache.set(key, c);
    if (this.cache.size > CACHE_FILES) this.cache.delete(this.cache.keys().next().value);
    if (size > c.offset) await this.#append(file, c, size);
    return c;
  }

  async #append(file, c, size) {
    const fh = await fsp.open(file, 'r');
    try {
      while (c.offset < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - c.offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, c.offset);
        if (!bytesRead) break;
        c.offset += bytesRead;
        const bytes = c.partial.length ? Buffer.concat([c.partial, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0;
        for (let i; (i = bytes.indexOf(0x0a, start)) !== -1; start = i + 1) {
          if (i === start) continue;
          let e;
          try { e = JSON.parse(bytes.toString('utf8', start, i)); } catch { continue; }
          c.ingest(e);
        }
        c.partial = Buffer.from(bytes.subarray(start));
      }
    } finally {
      await fh.close();
    }
  }
}

async function endsLine(file, end) {
  const fh = await fsp.open(file, 'r');
  try {
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, end - 1);
    return b[0] === 0x0a;
  } finally {
    await fh.close();
  }
}
