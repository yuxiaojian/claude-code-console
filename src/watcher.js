import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Tailer } from './tailer.js';

const isTranscript = f => f.endsWith('.jsonl');

/**
 * Watches ~/.claude/projects for transcript changes and feeds new lines to `onLine`.
 *
 * fs.watch (recursive) gives low latency but can drop events, so a periodic
 * stat-based rescan acts as a safety net. Both paths go through the Tailer,
 * which only ever reads bytes it hasn't seen.
 *
 * Emits 'change' after new data has been read.
 */
export class TranscriptWatcher extends EventEmitter {
  constructor({ root, sinceMs, onLine, rescanMs = 5000 }) {
    super();
    this.root = root;
    this.sinceMs = sinceMs;
    this.rescanMs = rescanMs;
    this.sizes = new Map(); // path -> last seen size
    this.tailer = new Tailer(onLine);
  }

  async start() {
    await fsp.mkdir(this.root, { recursive: true }).catch(() => {});
    const files = await this.#list();
    // Oldest-created first: a forked session copies its original's lines, and the store
    // can only tell the copy apart if it has already seen the original.
    files.sort((a, b) => (a.bornMs || a.mtimeMs) - (b.bornMs || b.mtimeMs));
    for (const f of files) {
      if (f.mtimeMs < this.sinceMs) continue;
      this.sizes.set(f.path, f.size);
      await this.tailer.poke(f.path);
    }
    this.emit('change');

    try {
      this.fsw = fs.watch(this.root, { recursive: true }, (_ev, rel) => {
        if (rel && isTranscript(rel.toString())) this.#poke(path.join(this.root, rel.toString()));
      });
      this.fsw.on('error', () => {}); // rescan still covers us
    } catch {
      // Recursive watch unsupported on this platform: polling only.
    }
    this.timer = setInterval(() => this.#rescan(), this.rescanMs);
    this.timer.unref?.();
  }

  stop() {
    this.fsw?.close();
    clearInterval(this.timer);
  }

  async #poke(p) {
    await this.tailer.poke(p);
    this.emit('change');
  }

  async #rescan() {
    let changed = false;
    for (const f of await this.#list()) {
      if (this.sizes.get(f.path) === f.size) continue;
      if (!this.sizes.has(f.path) && f.mtimeMs < this.sinceMs) continue;
      this.sizes.set(f.path, f.size);
      await this.tailer.poke(f.path);
      changed = true;
    }
    if (changed) this.emit('change');
  }

  /** All transcripts: <root>/<project>/<session>.jsonl and <root>/<project>/<session>/subagents/*.jsonl */
  async #list() {
    const out = [];
    const walk = async (dir, depth) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (depth < 3) await walk(p, depth + 1);
        } else if (isTranscript(ent.name)) {
          try {
            const st = await fsp.stat(p);
            out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, bornMs: st.birthtimeMs });
          } catch { /* vanished */ }
        }
      }
    };
    await walk(this.root, 0);
    return out;
  }
}
