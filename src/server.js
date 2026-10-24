import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Config, buildProjects, projectId, projectRoot } from './projects.js';
import { TranscriptReader } from './transcript.js';
import { MODES } from './runner.js';

const MODEL_RE = /^[\w.:@\/\[\]-]{1,100}$/;

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TICK_MS = 5000;     // re-send so time-based status (idle/stale) updates without new events
const THROTTLE_MS = 400;  // coalesce bursts of transcript writes
const BODY_LIMIT = 256 * 1024;
const TEXT_MAX = 100_000;  // characters in one chat message
const COOKIE = 'ccc_token';
const PAGE = 150;        // conversation items per page

/** The list view: everything except the bulky log. */
function listItem(summary) {
  const { log, byModel, spendByDay, ...rest } = summary;
  return { ...rest, recent: log.slice(-3) };
}

function openPath(dir) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [dir]]
    : process.platform === 'win32' ? ['explorer', [dir]]
    : ['xdg-open', [dir]];
  execFile(cmd, args, () => {});
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => {
      body += c;
      if (body.length > BODY_LIMIT) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieToken(req) {
  return (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1] || '';
}

/**
 * `token` guards every API call (pass null only in tests). `runner` and `live` enable chat;
 * without them the console is read-only.
 */
export function createServer({ store, watcher, config = new Config(), days = 7, allowRemote = false, token = null, runner = null, live = null }) {
  const clients = new Set();
  let lastSent = -1;
  let otherVersion = 0;  // config and run changes alter the view without a transcript event
  let timer = null;
  const transcripts = new TranscriptReader();

  /** Overlay what only the console knows: approvals it's holding, sessions open in a terminal. */
  const annotate = sessions => {
    const owned = runner?.ownedSessions() || new Set();
    const terminal = live?.current() || new Map();
    for (const s of sessions) {
      const run = runner?.bySession(s.id);
      const t = owned.has(s.id) ? null : terminal.get(s.id);
      s.openIn = run ? 'console' : t ? 'terminal' : null;
      s.terminalStatus = t?.status || null;
      // A terminal process reports "waiting" while its permission prompt is up.
      if (run?.approvals.size || (t?.status === 'waiting' && ['tool', 'stale', 'working'].includes(s.status))) s.status = 'approval';
    }
    return sessions;
  };

  const view = () => {
    const now = Date.now();
    const sessions = annotate(store.snapshot(now));
    const { projects, totals } = buildProjects(sessions, config, { now, days });
    return { now, totals, projects, sessions: sessions.map(listItem), runs: runner?.snapshot() || [], chat: Boolean(runner?.query) };
  };
  const payload = () => JSON.stringify(view());
  const findProject = id => buildProjects(store.snapshot(), config, { days }).projects.find(p => p.id === id);

  const broadcast = (force = false) => {
    const version = store.version + otherVersion;
    if (!clients.size || (!force && version === lastSent)) return;
    lastSent = version;
    const data = `data: ${payload()}\n\n`;
    for (const res of clients) res.write(data);
  };

  watcher.on('change', () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; broadcast(); }, THROTTLE_MS);
  });
  const bump = () => {
    otherVersion++;
    if (timer) return;
    timer = setTimeout(() => { timer = null; broadcast(); }, THROTTLE_MS);
  };
  runner?.on('change', bump);
  const ticker = setInterval(() => broadcast(true), TICK_MS);
  ticker.unref?.();

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    // DNS-rebinding guard: a malicious page can point its own hostname at 127.0.0.1,
    // but it can't make the browser send `Host: localhost`.
    const hostname = (req.headers.host || '').replace(/:\d+$/, '');
    if (!allowRemote && !LOCAL_HOSTS.has(hostname)) return json(res, 403, { error: 'Forbidden host' });

    const url = new URL(req.url, 'http://localhost');

    // Access token: the link printed at startup carries it once; after that it lives in an
    // HttpOnly cookie. Static files hold no data, so only the API checks it.
    if (token && req.method === 'GET' && url.searchParams.has('token')) {
      if (!sameSecret(url.searchParams.get('token'), token)) return json(res, 401, { error: 'Wrong token' });
      res.writeHead(302, {
        'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        location: url.pathname + url.hash,
      });
      return res.end();
    }
    if (token && url.pathname.startsWith('/api/') && !sameSecret(cookieToken(req), token)) {
      return json(res, 401, { error: 'Open the link printed in the terminal where the console is running.' });
    }
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      return json(res, 403, { error: 'Cross-origin request' });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`retry: 2000\ndata: ${payload()}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return json(res, 200, view());
    }

    // Everything below that changes state needs a custom header. It forces a CORS preflight,
    // which we never answer, so other websites can't send these requests.
    const mutating = req.method !== 'GET';
    if (mutating && req.headers['x-console'] !== '1') return json(res, 403, { error: 'Missing header' });

    const chat = url.pathname.match(/^\/api\/(sessions|pas)\/([\w-]+)\/(messages|fork|interrupt|sessions)$/);
    if (req.method === 'POST' && chat) {
      if (!runner?.query) return json(res, 501, { error: 'Chat needs the Claude Agent SDK. Run npm install.' });
      const [, kind, id, action] = chat;
      let body;
      try { body = await readJson(req); } catch (err) { return json(res, 400, { error: err.message }); }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (body.permissionMode != null && !MODES.includes(body.permissionMode)) return json(res, 400, { error: 'Unknown permission mode' });
      /** The PA's saved defaults, with the message box's mode choice on top. */
      const settings = root => {
        const prefs = config.get(root);
        return { permissionMode: body.permissionMode || prefs.permissionMode || 'default', ...(prefs.model ? { model: prefs.model } : {}) };
      };
      if (action !== 'interrupt' && (!text || text.length > TEXT_MAX)) return json(res, 400, { error: 'Message must be 1 to 100,000 characters' });
      try {
        if (kind === 'pas') {
          if (action !== 'sessions') return json(res, 404, { error: 'Not found' });
          const p = findProject(id);
          if (!p?.root || !fs.existsSync(p.root)) return json(res, 404, { error: 'Folder not found' });
          const run = await runner.start({ cwd: p.root, prompt: text, ...settings(p.root) });
          return json(res, 200, { key: run.key });
        }
        const s = store.sessions.get(id);
        if (!s?.cwd || action === 'sessions') return json(res, 404, { error: 'Unknown session' });
        const run = runner.bySession(id);
        if (action === 'interrupt') {
          if (!run) return json(res, 409, { error: 'The console is not running this session' });
          await runner.interrupt(run);
          return json(res, 200, { ok: true });
        }
        if (!fs.existsSync(s.cwd)) return json(res, 404, { error: 'The session folder no longer exists' });
        if (action === 'fork') {
          const forked = await runner.start({ cwd: s.cwd, prompt: text, resume: id, fork: true, ...settings(projectRoot(s.cwd)) });
          return json(res, 200, { key: forked.key });
        }
        if (run) {
          if (body.permissionMode && body.permissionMode !== run.mode) await runner.setMode(run, body.permissionMode);
          runner.send(run, text);
          return json(res, 200, { key: run.key });
        }
        if (annotate([{ id }])[0].openIn === 'terminal') {
          return json(res, 409, { error: 'This session is open in a terminal. Fork it to continue here.' });
        }
        const resumed = await runner.start({ cwd: s.cwd, prompt: text, resume: id, ...settings(projectRoot(s.cwd)) });
        return json(res, 200, { key: resumed.key });
      } catch (err) {
        return json(res, 409, { error: err.message });
      }
    }

    const decide = url.pathname.match(/^\/api\/runs\/([a-f0-9]+)\/(approvals\/([\w-]+)|close|mode)$/);
    if (req.method === 'POST' && decide) {
      const run = runner?.runs.get(decide[1]);
      if (!run) return json(res, 404, { error: 'Unknown run' });
      if (decide[2] === 'close') {
        runner.close(run.key);
        return json(res, 200, { ok: true });
      }
      let body;
      try { body = await readJson(req); } catch (err) { return json(res, 400, { error: err.message }); }
      if (decide[2] === 'mode') {
        if (!MODES.includes(body.mode)) return json(res, 400, { error: 'Unknown permission mode' });
        try { await runner.setMode(run, body.mode); } catch (err) { return json(res, 409, { error: err.message }); }
        return json(res, 200, { ok: true });
      }
      const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
        ? Object.fromEntries(Object.entries(body.answers).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'))
        : null;
      const ok = runner.answer(run, decide[3], {
        allow: body.allow === true,
        always: body.always === true,
        message: typeof body.message === 'string' ? body.message.slice(0, 2000) : '',
        answers,
      });
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'That request was already answered' });
    }

    if (req.method === 'POST' && url.pathname === '/api/pas') {
      let body;
      try { body = await readJson(req); } catch (err) { return json(res, 400, { error: err.message }); }
      let dir = typeof body.path === 'string' ? body.path.trim() : '';
      if (dir === '~' || dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(1));
      if (!path.isAbsolute(dir)) return json(res, 400, { error: 'Use an absolute path' });
      let st = null;
      try { st = fs.statSync(dir); } catch { /* missing */ }
      if (!st?.isDirectory()) return json(res, 400, { error: 'Not a folder' });
      const root = projectRoot(dir);
      config.set(root, { added: true, hidden: false });
      otherVersion++;
      broadcast();
      return json(res, 200, findProject(projectId(root)));
    }

    const pa = url.pathname.match(/^\/api\/pas\/([a-f0-9]+)(\/open)?$/);
    if (pa) {
      const p = findProject(pa[1]);
      if (!p) return json(res, 404, { error: 'Unknown PA' });
      if (req.method === 'POST' && pa[2]) {
        if (!p.root || !fs.existsSync(p.root)) return json(res, 404, { error: 'Folder no longer exists' });
        openPath(p.root);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PATCH' && !pa[2]) {
        let body;
        try { body = await readJson(req); } catch (err) { return json(res, 400, { error: err.message }); }
        const patch = {};
        if ('name' in body) {
          if (typeof body.name !== 'string' || body.name.trim().length > 80) return json(res, 400, { error: 'Name must be up to 80 characters' });
          patch.name = body.name.trim();
        }
        if ('model' in body) {
          if (body.model !== '' && (typeof body.model !== 'string' || !MODEL_RE.test(body.model))) return json(res, 400, { error: 'Invalid model name' });
          patch.model = body.model;
        }
        if ('permissionMode' in body) {
          if (body.permissionMode !== '' && !MODES.includes(body.permissionMode)) return json(res, 400, { error: 'Unknown permission mode' });
          patch.permissionMode = body.permissionMode;
        }
        for (const k of ['pinned', 'hidden']) {
          if (!(k in body)) continue;
          if (typeof body[k] !== 'boolean') return json(res, 400, { error: `${k} must be true or false` });
          patch[k] = body[k];
        }
        config.set(p.root, patch);
        otherVersion++;
        broadcast();
        return json(res, 200, findProject(p.id));
      }
      if (req.method === 'DELETE' && !pa[2]) {
        // Forget the user's choices. A PA with sessions stays, because it's discovered from them.
        config.remove(p.root);
        otherVersion++;
        broadcast();
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'Method not allowed' });
    }

    const detail = url.pathname.match(/^\/api\/sessions\/([\w-]+)$/);
    if (req.method === 'GET' && detail) {
      const s = store.sessions.get(detail[1]);
      return s ? json(res, 200, store.summarize(s)) : json(res, 404, { error: 'Unknown session' });
    }

    // Conversation items. Newest page by default; `before` pages back, `from` re-reads the tail
    // (tool results attach to items already sent).
    const conv = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/transcript$/);
    if (req.method === 'GET' && conv) {
      const s = store.sessions.get(conv[1]);
      if (!s?.file) return json(res, 404, { error: 'Unknown session' });
      let c;
      try { c = await transcripts.read(s.file); } catch { return json(res, 404, { error: 'Transcript not found' }); }
      const total = c.items.length;
      const num = k => (url.searchParams.has(k) ? Math.max(0, Math.min(total, Number(url.searchParams.get(k)) || 0)) : null);
      const from = num('from');
      const end = from == null ? (num('before') ?? total) : total;
      const start = from != null ? Math.max(from, total - PAGE * 10) : Math.max(0, end - PAGE);
      return json(res, 200, { total, start, items: c.view(start, end) });
    }

    const open = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/open$/);
    if (req.method === 'POST' && open) {
      const s = store.sessions.get(open[1]);
      if (!s?.cwd) return json(res, 404, { error: 'Unknown session' });
      if (!fs.existsSync(s.cwd)) return json(res, 404, { error: 'Folder no longer exists' });
      openPath(s.cwd);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(PUBLIC_DIR, path.normalize(rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'Not found' });
      fs.readFile(file, (err, buf) => {
        if (err) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(buf);
      });
      return;
    }

    json(res, 405, { error: 'Method not allowed' });
  });

  server.on('close', () => clearInterval(ticker));
  return server;
}
