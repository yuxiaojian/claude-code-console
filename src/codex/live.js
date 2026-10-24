import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { UUID_RE } from './store.js';

// Which Codex threads another process has open. Codex keeps a writer lock per thread in
// $CODEX_HOME/thread-writer-locks/<thread id>.lock, but the files outlive their holders, so
// a file proves nothing by itself: lsof says who actually holds it. This is for display
// only. Whether the console may write to a thread never depends on it: only a run the
// console itself started can be continued.

const EVERY_MS = 5_000;

/** Run lsof and return { out, err, failed }. lsof exits 1 when some files have no holder. */
function lsof(files) {
  return new Promise(resolve => {
    execFile('lsof', ['-F', 'pn', '--', ...files], { timeout: 4_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const failed = Boolean(error) && !(error.code === 1 && !String(stderr).trim());
      resolve({ out: String(stdout || ''), failed });
    });
  });
}

/** lsof -F pn output -> Map(file -> Set(pid)). */
export function parseLsof(out) {
  const holders = new Map();
  let pid = null;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && Number.isInteger(pid)) {
      const name = line.slice(1);
      if (!holders.has(name)) holders.set(name, new Set());
      holders.get(name).add(pid);
    }
  }
  return holders;
}

export class CodexLive {
  /** `ownPids()` lists the console's own app-server processes; `run` is injectable for tests. */
  constructor({ dir, ownPids = () => new Set(), run = lsof, everyMs = EVERY_MS }) {
    this.dir = dir;
    this.ownPids = ownPids;
    this.run = run;
    this.everyMs = everyMs;
    this.readAt = 0;
    this.busy = null;
    this.byThread = new Map(); // thread id -> { state: 'external' | 'unknown', pids }
  }

  /** The last result, refreshed in the background when it's older than a few seconds. */
  current() {
    if (!this.busy && Date.now() - this.readAt >= this.everyMs) this.refresh();
    return this.byThread;
  }

  refresh() {
    this.readAt = Date.now();
    this.busy = this.#scan().then(m => { this.byThread = m; }, () => {}).finally(() => { this.busy = null; });
    return this.busy;
  }

  async #scan() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return new Map(); }
    const locks = names.map(n => n.match(/^(.+)\.lock$/)?.[1]).filter(id => id && UUID_RE.test(id));
    const next = new Map();
    if (!locks.length) return next;
    const files = locks.map(id => path.join(this.dir, `${id}.lock`));
    let result;
    try { result = await this.run(files); } catch { result = { out: '', failed: true }; }
    const holders = parseLsof(result.out);
    const own = this.ownPids();
    locks.forEach((id, i) => {
      const pids = [...(holders.get(files[i]) || [])];
      const others = pids.filter(p => !own.has(p));
      if (others.length) next.set(id, { state: 'external', pids: others });
      else if (!pids.length && result.failed) next.set(id, { state: 'unknown', pids: [] });
    });
    return next;
  }
}
