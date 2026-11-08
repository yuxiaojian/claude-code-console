import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { Config } from '../src/projects.js';
import { createServer } from '../src/server.js';
import { Runner } from '../src/runner.js';
import { ClaudeProfiles, DEFAULT_CLAUDE_DIR, envFor, normalizeDir } from '../src/profiles.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-prof-')));

/** A store holding one session, standing in for a loaded config dir. */
function fakeOpen(opened) {
  return async dir => {
    opened.push(dir);
    const store = new Store();
    store.ingest({ type: 'user', sessionId: `s-${path.basename(dir)}`, timestamp: new Date().toISOString(), cwd: '/nowhere', message: { role: 'user', content: 'hi' } });
    const watcher = Object.assign(new EventEmitter(), { stopped: false, stop() { this.stopped = true; } });
    return { store, watcher, live: { current: () => new Map() } };
  };
}

test('normalizeDir expands ~ and drops trailing slashes; the default dir sets no env', () => {
  assert.equal(normalizeDir('~/.claude-personal/'), path.join(os.homedir(), '.claude-personal'));
  assert.equal(envFor(DEFAULT_CLAUDE_DIR), null);
  assert.equal(envFor('/x/.claude-work'), '/x/.claude-work');
});

test('profiles add, switch, persist and refuse bad removals', async () => {
  const file = path.join(tmp(), 'config.json');
  const other = tmp();
  const config = new Config(file);
  const opened = [], switched = [];
  const p = new ClaudeProfiles({ config, open: fakeOpen(opened), close: ctx => ctx.watcher.stop(), onSwitch: d => switched.push(d) });
  const first = await p.init();
  assert.deepEqual(opened, [DEFAULT_CLAUDE_DIR]);
  assert.throws(() => p.add(path.join(other, 'missing')), /Not a folder/);
  p.add(other + '/');
  assert.deepEqual(p.list().dirs.map(d => d.dir), [DEFAULT_CLAUDE_DIR, other]);
  await assert.rejects(p.select('/not/added'), /Add it first/);

  const events = [];
  p.on('switch', next => events.push(next));
  await p.select(other);
  assert.equal(p.active, other);
  assert.equal(first.watcher.stopped, true, 'the old watcher stops');
  assert.equal(events.length, 1);
  assert.deepEqual(switched, [DEFAULT_CLAUDE_DIR, other]);
  assert.throws(() => p.remove(other), /Switch to another/);
  assert.throws(() => p.remove(DEFAULT_CLAUDE_DIR), /can't be removed/);

  const reloaded = new Config(file);
  assert.deepEqual(reloaded.claudeDirs(), [other], 'the default dir is not stored');
  assert.equal(reloaded.activeClaudeDir(), other);

  await p.select(DEFAULT_CLAUDE_DIR);
  p.remove(other);
  assert.deepEqual(new Config(file).claudeDirs(), []);
});

test('a fixed --dir refuses switching', async () => {
  const p = new ClaudeProfiles({ config: new Config(), fixed: true, open: fakeOpen([]) });
  await p.init();
  await assert.rejects(p.select(DEFAULT_CLAUDE_DIR), /fixed/);
});

test('the runner points new processes at the active config dir', async () => {
  const seen = [];
  const query = ({ options }) => {
    seen.push(options.env.CLAUDE_CONFIG_DIR);
    const it = (async function* () {})();
    return Object.assign(it, { close() {} });
  };
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/from/the/shell';
  try {
    const r = new Runner({ query });
    r.configDir = '/x/.claude-personal';
    await r.start({ cwd: '/', prompt: 'hi' });
    r.configDir = null;
    await r.start({ cwd: '/', prompt: 'hi' });
    assert.deepEqual(seen, ['/x/.claude-personal', undefined], 'the default dir unsets an inherited CLAUDE_CONFIG_DIR');
    r.closeAll();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

function request(port, { method = 'GET', path: p = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `localhost:${port}`, 'x-console': '1' } }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('the server lists config dirs and follows a switch', async () => {
  const other = tmp();
  const p = new ClaudeProfiles({ config: new Config(), open: fakeOpen([]) });
  const { store, watcher, live } = await p.init();
  const server = createServer({ store, watcher, live, profiles: p });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    let view = (await request(port, { path: '/api/sessions' })).body;
    assert.equal(view.claudeDirs.active, DEFAULT_CLAUDE_DIR);
    assert.deepEqual(view.sessions.map(s => s.nativeId), ['s-.claude']);

    assert.equal((await request(port, { method: 'POST', path: '/api/claude-dirs', body: { path: 'relative/dir' } })).status, 400);
    assert.equal((await request(port, { method: 'POST', path: '/api/claude-dirs', body: { path: other } })).status, 200);
    const sel = await request(port, { method: 'POST', path: '/api/claude-dirs/select', body: { path: other } });
    assert.equal(sel.status, 200);
    assert.equal(sel.body.active, other);

    view = (await request(port, { path: '/api/sessions' })).body;
    assert.deepEqual(view.sessions.map(s => s.nativeId), [`s-${path.basename(other)}`], 'sessions come from the new dir');
  } finally {
    server.close();
  }
});
