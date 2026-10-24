import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { dayKey } from './store.js';

// A "PA" (personal assistant) is a folder: the git repo root a session ran in, so sessions
// started in repo/ and repo/src land together, and worktrees join their main repo.

const NEEDS = new Set(['approval', 'question', 'waiting', 'error']);
const ACTIVE = new Set(['tool', 'working']);
const URGENCY = ['approval', 'question', 'error', 'waiting', 'tool', 'working', 'stale', 'idle', 'ended'];
const DAY_MS = 86_400_000;

const roots = new Map(); // cwd -> root

/** The PA folder for a session's cwd. Cached; call clearRootCache() to pick up new repos. */
export function projectRoot(cwd) {
  if (!cwd) return '';
  let root = roots.get(cwd);
  if (root === undefined) { root = findRoot(cwd); roots.set(cwd, root); }
  return root;
}

export function clearRootCache() { roots.clear(); }

function findRoot(cwd) {
  const home = os.homedir();
  // Resolve links so /tmp/x and /private/tmp/x (how Claude Code records it on macOS) are one PA.
  let start = path.resolve(cwd);
  try { start = fs.realpathSync(start); } catch { /* deleted folder: keep the path as recorded */ }
  cwd = start;
  for (let dir = start; ; dir = path.dirname(dir)) {
    // A dotfiles repo in $HOME would otherwise swallow every non-repo folder.
    if (dir === home && dir !== start) return cwd;
    const git = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(git); } catch { /* not here */ }
    if (st?.isDirectory()) return dir;
    if (st?.isFile()) return worktreeMain(git) || dir;
    if (path.dirname(dir) === dir) return cwd;
  }
}

/** A worktree's .git file points at <main>/.git/worktrees/<name>, whose `commondir` leads back to <main>/.git. */
function worktreeMain(gitFile) {
  try {
    const gitdir = fs.readFileSync(gitFile, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1].trim();
    if (!gitdir) return null;
    const abs = path.resolve(path.dirname(gitFile), gitdir);
    const common = fs.readFileSync(path.join(abs, 'commondir'), 'utf8').trim(); // absent for submodules
    return path.dirname(path.resolve(abs, common));
  } catch {
    return null;
  }
}

export const projectId = root => crypto.createHash('sha1').update(root).digest('hex').slice(0, 10);

/** User choices per PA (name, pinned, hidden, added), kept in a small JSON file. */
export class Config {
  constructor(file = null) {
    this.file = file;
    this.pas = {};
    if (!file || !fs.existsSync(file)) return;
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
      throw new Error(`Can't read ${file}: ${err.message}. Fix or delete it.`);
    }
    if (data?.pas && typeof data.pas === 'object') this.pas = data.pas;
  }

  get(root) { return this.pas[root] || {}; }

  /** Folders the user added by hand, which show up even without sessions. */
  added() { return Object.keys(this.pas).filter(r => this.pas[r].added); }

  /** Merge `patch`; null/false/'' clear a field, and an entry with nothing left is dropped. */
  set(root, patch) {
    const next = { ...this.get(root) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null || v === false || v === '') delete next[k]; else next[k] = v;
    }
    if (Object.keys(next).length) this.pas[root] = next; else delete this.pas[root];
    this.#save();
  }

  remove(root) {
    delete this.pas[root];
    this.#save();
  }

  #save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, pas: this.pas }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}

/**
 * Group session summaries into PAs. Sets `pa` (the PA id) on each summary.
 * Spend is estimated from transcript tokens and bucketed by day; `days` is the loaded window.
 */
export function buildProjects(sessions, config, { now = Date.now(), days = 7 } = {}) {
  const today = dayKey(now);
  const from = dayKey(now - (days - 1) * DAY_MS);
  const byRoot = new Map();
  const get = root => {
    let p = byRoot.get(root);
    if (!p) byRoot.set(root, p = { root, sessions: [] });
    return p;
  };
  for (const s of sessions) {
    const p = get(projectRoot(s.cwd));
    s.pa = projectId(p.root);
    p.sessions.push(s);
  }
  for (const root of config.added()) get(projectRoot(root) || root); // saved before links were resolved

  // Default names are the folder name, or parent/folder when two PAs share one.
  const base = root => path.basename(root) || root;
  const seen = new Map();
  for (const root of byRoot.keys()) seen.set(base(root), (seen.get(base(root)) || 0) + 1);
  const defaultName = root => !root ? '(no folder)'
    : seen.get(base(root)) > 1 ? root.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : base(root);

  const totals = { needs: 0, active: 0, sessions: sessions.length, today: 0, period: 0, days };
  const projects = [];
  for (const { root, sessions: list } of byRoot.values()) {
    const prefs = config.get(root);
    list.sort((a, b) => URGENCY.indexOf(a.status) - URGENCY.indexOf(b.status) || (b.lastActivity || 0) - (a.lastActivity || 0));
    const latest = list.reduce((m, s) => (!m || (s.lastActivity || 0) > (m.lastActivity || 0) ? s : m), null);
    let spendToday = 0, spendPeriod = 0;
    for (const s of list) {
      for (const [day, usd] of Object.entries(s.spendByDay || {})) {
        if (day === today) spendToday += usd;
        if (day >= from) spendPeriod += usd;
      }
    }
    const p = {
      id: projectId(root),
      root,
      name: prefs.name || defaultName(root),
      pinned: Boolean(prefs.pinned),
      hidden: Boolean(prefs.hidden),
      added: Boolean(prefs.added),
      model: prefs.model || '',
      permissionMode: prefs.permissionMode || '',
      models: [...new Set(list.map(s => s.model).filter(m => m && m !== '<synthetic>'))],
      status: list[0]?.status || 'empty',
      counts: {
        needs: list.filter(s => NEEDS.has(s.status)).length,
        active: list.filter(s => ACTIVE.has(s.status)).length,
        sessions: list.length,
      },
      spend: { today: spendToday, period: spendPeriod },
      lastActivity: latest?.lastActivity || null,
      latest: latest ? { id: latest.id, title: latest.title || latest.lastPrompt || '', status: latest.status } : null,
    };
    projects.push(p);
    if (!p.hidden) {
      totals.needs += p.counts.needs;
      totals.active += p.counts.active;
    }
    totals.today += spendToday;
    totals.period += spendPeriod;
  }
  projects.sort((a, b) => (b.pinned - a.pinned) || (b.counts.needs > 0) - (a.counts.needs > 0)
    || (b.lastActivity || 0) - (a.lastActivity || 0) || a.name.localeCompare(b.name));
  return { projects, totals };
}
