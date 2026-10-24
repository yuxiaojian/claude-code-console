import fs from 'node:fs';
import path from 'node:path';

// Claude Code writes ~/.claude/sessions/<pid>.json for every running process, with its
// session id and a busy / idle / waiting status. A session whose process is alive is
// open somewhere else (usually a terminal), and the console must not write to it too.

const READ_EVERY_MS = 2_000;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

export class LiveSessions {
  constructor(dir) {
    this.dir = dir;
    this.readAt = 0;
    this.bySession = new Map(); // sessionId -> { pid, status, entrypoint, kind }
  }

  /** Running processes by session id, re-read at most every couple of seconds. */
  current() {
    if (Date.now() - this.readAt < READ_EVERY_MS) return this.bySession;
    this.readAt = Date.now();
    const next = new Map();
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { /* no sessions dir yet */ }
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      let info;
      try { info = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { continue; }
      if (!info?.sessionId || !Number.isInteger(info.pid) || !alive(info.pid)) continue;
      next.set(info.sessionId, { pid: info.pid, status: info.status || '', entrypoint: info.entrypoint || '', kind: info.kind || '' });
    }
    this.bySession = next;
    return next;
  }
}
