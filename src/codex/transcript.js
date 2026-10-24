import path from 'node:path';
import { clip, headTail } from '../transcript.js';
import { redact } from './errors.js';

// Turns a Codex rollout into the same conversation items the Claude viewer renders.
// The rollout records each finished item as event_msg/item_completed; those are the
// source here. Raw response_item lines duplicate them and are skipped.
// Shell commands show as Bash and file changes as Edit, so the browser renders them as it
// does for Claude Code. Unknown item types are left out rather than guessed at.

const TEXT_MAX = 20_000;
const DIFF_LINES = 400;

const textOf = content => (Array.isArray(content) ? content : [])
  .map(c => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');

/** Hunks from a unified diff, or from a new file's content, in the viewer's shape. */
export function diffHunks(change) {
  const hunks = [];
  if (typeof change?.unified_diff === 'string') {
    let cur = null;
    for (const line of change.unified_diff.split('\n')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { cur = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] }; hunks.push(cur); continue; }
      if (cur && /^[ +-]/.test(line)) cur.lines.push(line);
    }
  } else if (typeof change?.content === 'string') {
    hunks.push({ oldStart: 0, newStart: 1, lines: change.content.split('\n').map(l => `${change.type === 'delete' ? '-' : '+'}${l}`) });
  }
  let budget = DIFF_LINES;
  const out = [];
  for (const h of hunks) {
    if (budget <= 0) break;
    const lines = h.lines.slice(0, budget).map(l => clip(l, 500));
    budget -= lines.length;
    out.push({ ...h, lines });
  }
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  return out.length ? { hunks: out, truncated: total > DIFF_LINES } : null;
}

export class CodexConversation {
  constructor() {
    this.items = [];
    this.seen = new Set(); // item ids: a re-read or repeated line adds nothing
    this.offset = 0;
    this.partial = Buffer.alloc(0);
  }

  #push(item) { this.items.push(item); }

  ingest(e) {
    if (!e || typeof e !== 'object' || e.type !== 'event_msg') return;
    const p = e.payload || {};
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || null : null;
    switch (p.type) {
      case 'item_completed': return this.#item(p.item, at);
      case 'turn_aborted': return this.#push({ k: 'info', at, text: p.reason === 'interrupted' ? 'Interrupted' : 'Turn aborted' });
      case 'error': return this.#push({ k: 'error', at, text: redact(p.message || 'Codex reported an error', 2000) });
      case 'context_compacted': return this.#push({ k: 'info', at, text: 'Conversation compacted' });
      default: return;
    }
  }

  #item(item, at) {
    if (!item || typeof item !== 'object' || typeof item.type !== 'string') return;
    if (typeof item.id === 'string') {
      if (this.seen.has(item.id)) return;
      this.seen.add(item.id);
    }
    switch (item.type) {
      case 'UserMessage': {
        const text = textOf(item.content);
        if (text.trim()) this.#push({ k: 'user', at, text: clip(text, TEXT_MAX) });
        return;
      }
      case 'AgentMessage': {
        const text = textOf(item.content);
        if (text.trim()) this.#push({ k: 'text', at, text: clip(text, TEXT_MAX) });
        return;
      }
      case 'Reasoning': {
        const text = (Array.isArray(item.summary_text) ? item.summary_text : []).filter(t => typeof t === 'string').join('\n');
        if (text.trim()) this.#push({ k: 'thinking', at, text: clip(text, TEXT_MAX) });
        return;
      }
      case 'CommandExecution': {
        const command = String(Array.isArray(item.command) ? item.command.at(-1) : item.command || '');
        const declined = item.status === 'declined';
        const out = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
        this.#push({
          k: 'tool', at, id: item.id, name: 'Bash', target: clip(command.replace(/\s+/g, ' '), 80),
          input: { command: clip(command, 2000) },
          result: { ...headTail(declined ? 'Declined' : out), error: declined || item.status === 'failed' || (Number.isInteger(item.exit_code) && item.exit_code !== 0), at },
        });
        return;
      }
      case 'FileChange': {
        const changes = item.changes && typeof item.changes === 'object' ? Object.entries(item.changes) : [];
        const failed = item.status && item.status !== 'completed';
        for (const [file, change] of changes) {
          this.#push({
            k: 'tool', at, id: `${item.id}:${file}`, name: 'Edit', target: path.basename(file),
            input: { file_path: file },
            diff: diffHunks(change),
            result: { text: failed ? String(item.status) : '', truncated: false, error: Boolean(failed), at },
          });
        }
        return;
      }
      case 'Extension': {
        const label = item.kind === 'web.search' ? 'Web search' : String(item.kind || 'Extension');
        this.#push({ k: 'tool', at, id: item.id, name: label, target: clip(String(item.query || ''), 80), input: item.query ? { query: clip(String(item.query), 2000) } : {}, result: { text: '', truncated: false, error: false, at } });
        return;
      }
      default:
        return;
    }
  }

  view(from, to) {
    return this.items.slice(from, to);
  }
}

/**
 * A fork's conversation: the inherited history (each ancestor's own file up to where the
 * next fork branched off), a note for any history that couldn't be followed, then its own.
 */
export async function readCodexConversation(reader, store, s) {
  const { chain, missing } = store.ancestry(s.id);
  const parts = [];
  if (missing) {
    parts.push([{ k: 'info', at: s.startedAt, text: `Earlier history${missing.id ? ` from ${missing.id.slice(0, 8)}` : ''} isn't available (${missing.reason})` }]);
  }
  for (const link of chain) {
    try {
      parts.push((await reader.read(link.file, link.end)).items);
    } catch {
      parts.push([{ k: 'info', at: s.startedAt, text: `Earlier history from ${link.id.slice(0, 8)} isn't available (unreadable)` }]);
    }
  }
  if (chain.length || missing) parts.push([{ k: 'info', at: s.startedAt, text: 'Forked here' }]);
  parts.push((await reader.read(s.file)).items);
  const items = parts.flat();
  return { items, view: (from, to) => items.slice(from, to) };
}
