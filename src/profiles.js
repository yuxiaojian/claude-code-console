import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Claude Code keeps its transcripts, running-process records, login and settings in one
// config dir: ~/.claude, or wherever $CLAUDE_CONFIG_DIR points (e.g. a second account in
// ~/.claude-personal). The console watches one of them at a time. Switching builds a fresh
// store and watcher for the new dir and drops the old ones; sessions the console starts use
// the active dir, so they log in and write transcripts where the console is looking.

export const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');

export function expandHome(p) {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(1));
  return p;
}

/** A dir as it's stored and compared: absolute, no trailing slash, ~ expanded. */
export function normalizeDir(p) {
  return path.resolve(expandHome(String(p).trim()));
}

/** The CLAUDE_CONFIG_DIR value for a dir: none for the default, since Claude Code keys its login on it. */
export const envFor = dir => (dir === DEFAULT_CLAUDE_DIR ? null : dir);

export class ClaudeProfiles extends EventEmitter {
  /**
   * `open(dir)` builds and starts { store, watcher, live } for a dir; `close(ctx)` stops them.
   * `onSwitch(dir)` runs before a switch is announced (the CLI closes Claude chat runs there).
   * `fixed` (an explicit --dir) turns switching off.
   */
  constructor({ config, initial = DEFAULT_CLAUDE_DIR, fixed = false, open, close = () => {}, onSwitch = () => {} }) {
    super();
    this.config = config;
    this.fixed = fixed;
    this.open = open;
    this.closeCtx = close;
    this.onSwitch = onSwitch;
    this.active = normalizeDir(initial);
    this.current = null; // { store, watcher, live }
    this.switching = null;
    const saved = config.claudeDirs();
    this.dirs = [...new Set([DEFAULT_CLAUDE_DIR, ...saved, this.active])];
  }

  async init() {
    this.current = await this.open(this.active);
    this.onSwitch(this.active);
    return this.current;
  }

  list() {
    return {
      fixed: this.fixed,
      switching: Boolean(this.switching),
      active: this.active,
      dirs: this.dirs.map(dir => ({
        dir,
        isDefault: dir === DEFAULT_CLAUDE_DIR,
        active: dir === this.active,
        exists: isDir(dir),
      })),
    };
  }

  #save() { this.config.setClaude({ dirs: this.dirs.filter(d => d !== DEFAULT_CLAUDE_DIR), active: this.active }); }

  add(input) {
    const dir = normalizeDir(input);
    if (!isDir(dir)) throw new Error('Not a folder');
    if (!this.dirs.includes(dir)) this.dirs.push(dir);
    this.#save();
    this.emit('change');
    return dir;
  }

  remove(input) {
    const dir = normalizeDir(input);
    if (dir === DEFAULT_CLAUDE_DIR) throw new Error("The default config dir can't be removed");
    if (dir === this.active) throw new Error('Switch to another config dir before removing this one');
    this.dirs = this.dirs.filter(d => d !== dir);
    this.#save();
    this.emit('change');
  }

  /** Watch `dir` instead. Resolves once its sessions are loaded. */
  async select(input) {
    if (this.fixed) throw new Error('The transcript dir was set with --dir, so the config dir is fixed');
    const dir = normalizeDir(input);
    if (!this.dirs.includes(dir)) throw new Error('Unknown config dir. Add it first.');
    if (!isDir(dir)) throw new Error('That folder no longer exists');
    if (this.switching) throw new Error('Already switching config dir');
    if (dir === this.active) return this.current;
    this.switching = (async () => {
      this.emit('change');
      const next = await this.open(dir);
      const prev = this.current;
      this.active = dir;
      this.current = next;
      this.onSwitch(dir);
      this.#save();
      this.closeCtx(prev);
      this.emit('switch', next);
    })();
    try { await this.switching; } finally { this.switching = null; this.emit('change'); }
    return this.current;
  }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
