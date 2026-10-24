import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { Config, projectId } from '../src/projects.js';

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(fn, config = new Config()) {
  const store = new Store();
  store.ingest({ type: 'user', sessionId: 'abc-123', timestamp: new Date().toISOString(), cwd: '/definitely/not/here', message: { role: 'user', content: 'hi' } });
  const server = createServer({ store, watcher: new EventEmitter(), config });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await fn(server.address().port);
  } finally {
    server.close();
  }
}

test('serves the session list to localhost', () => withServer(async port => {
  const r = await request(port, { path: '/api/sessions', headers: { host: `localhost:${port}` } });
  assert.equal(r.status, 200);
  const { sessions, projects, totals } = JSON.parse(r.body);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'abc-123');
  assert.equal(sessions[0].log, undefined, 'list view omits the full log');
  assert.equal(sessions[0].pa, projectId('/definitely/not/here'));
  assert.equal(projects[0].name, 'here');
  assert.equal(totals.needs, 0);
}));

test('rejects foreign Host headers (DNS rebinding)', () => withServer(async port => {
  const r = await request(port, { path: '/api/sessions', headers: { host: 'attacker.example' } });
  assert.equal(r.status, 403);
}));

test('open-folder requires the custom header and a known session', () => withServer(async port => {
  const host = `localhost:${port}`;
  assert.equal((await request(port, { method: 'POST', path: '/api/sessions/abc-123/open', headers: { host } })).status, 403);
  assert.equal((await request(port, { method: 'POST', path: '/api/sessions/nope/open', headers: { host, 'x-console': '1' } })).status, 404);
  // Known session, but its folder doesn't exist on this machine.
  assert.equal((await request(port, { method: 'POST', path: '/api/sessions/abc-123/open', headers: { host, 'x-console': '1' } })).status, 404);
}));

test('static files cannot escape public/', () => withServer(async port => {
  const r = await request(port, { path: '/..%2f..%2fpackage.json', headers: { host: `localhost:${port}` } });
  assert.equal(r.status, 404);
  const ok = await request(port, { path: '/', headers: { host: `localhost:${port}` } });
  assert.equal(ok.status, 200);
  assert.match(ok.body, /Claude Code Console/);
}));

test('PAs can be renamed, pinned and hidden, with validation and the custom header', () => {
  const config = new Config();
  return withServer(async port => {
    const id = projectId('/definitely/not/here');
    const patch = (body, headers = { 'x-console': '1' }) => request(port, { method: 'PATCH', path: `/api/pas/${id}`, headers, body });
    assert.equal((await patch({ name: 'Mine' }, {})).status, 403);
    assert.equal((await patch({ pinned: 'yes' })).status, 400);
    assert.equal((await patch({ name: 'x'.repeat(81) })).status, 400);
    const r = await patch({ name: ' Mine ', pinned: true });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).name, 'Mine');
    assert.deepEqual(config.get('/definitely/not/here'), { name: 'Mine', pinned: true });
    assert.equal((await request(port, { method: 'PATCH', path: '/api/pas/0000000000', headers: { 'x-console': '1' }, body: {} })).status, 404);
  }, config);
});

test('adding a folder needs an existing absolute directory', () => withServer(async port => {
  const add = p => request(port, { method: 'POST', path: '/api/pas', headers: { 'x-console': '1' }, body: { path: p } });
  assert.equal((await add('relative/dir')).status, 400);
  assert.equal((await add('/definitely/not/here')).status, 400);
  const file = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-add-'))), 'f.txt');
  fs.writeFileSync(file, '');
  assert.equal((await add(file)).status, 400);
  const dir = path.dirname(file);
  const r = await add(dir);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).counts.sessions, 0);
  const list = JSON.parse((await request(port, { path: '/api/sessions' })).body);
  assert.ok(list.projects.some(p => p.root === dir));
}));

test('the transcript endpoint pages back with `before` and re-reads the tail with `from`', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-conv-'));
  const file = path.join(dir, 'sess-9.jsonl');
  const t = new Date().toISOString();
  const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ uuid: `u${i}`, type: 'user', sessionId: 'sess-9', timestamp: t, cwd: dir, message: { role: 'user', content: `msg ${i}` } }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const store = new Store();
  for (const l of lines) store.ingestLine(l, file);
  const server = createServer({ store, watcher: new EventEmitter() });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = async q => JSON.parse((await request(port, { path: `/api/sessions/sess-9/transcript${q}` })).body);
  try {
    const last = await get('');
    assert.deepEqual([last.total, last.start, last.items.length], [200, 50, 150]);
    assert.equal(last.items.at(-1).text, 'msg 199');
    const older = await get('?before=50');
    assert.deepEqual([older.start, older.items.length, older.items[0].text], [0, 50, 'msg 0']);
    const tail = await get('?from=190');
    assert.deepEqual([tail.start, tail.items.length], [190, 10]);
    assert.equal((await request(port, { path: '/api/sessions/nope/transcript' })).status, 404);
  } finally {
    server.close();
  }
});

test('with a token, the API needs the cookie, which the startup link sets', async () => {
  const store = new Store();
  const server = createServer({ store, watcher: new EventEmitter(), token: 'secret-token-1234567890-abcdefghij' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    assert.equal((await request(port, { path: '/api/sessions' })).status, 401);
    assert.equal((await request(port, { path: '/' })).status, 200, 'static files need no token');
    assert.equal((await request(port, { path: '/?token=wrong' })).status, 401);
    const login = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/?token=secret-token-1234567890-abcdefghij', headers: { host: `localhost:${port}` } }, resolve).on('error', reject);
    });
    assert.equal(login.statusCode, 302);
    assert.equal(login.headers.location, '/');
    const cookie = login.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const ok = await request(port, { path: '/api/sessions', headers: { cookie: cookie.split(';')[0] } });
    assert.equal(ok.status, 200);
    const bad = await request(port, { path: '/api/sessions', headers: { cookie: 'ccc_token=secret-token-1234567890-abcdefghiX' } });
    assert.equal(bad.status, 401);
  } finally {
    server.close();
  }
});

test('chat endpoints: resume, refuse terminal sessions, answer approvals, reject cross-origin', async () => {
  const calls = [];
  const runs = new Map();
  const runner = Object.assign(new EventEmitter(), {
    query: () => {},
    runs,
    ownedSessions: () => new Set(),
    bySession: id => [...runs.values()].find(r => r.sessionId === id) || null,
    snapshot: () => [],
    start: async opts => { calls.push(['start', opts]); const r = { key: `a${runs.size}0`, sessionId: opts.fork ? null : opts.resume, approvals: new Map() }; runs.set(r.key, r); return r; },
    send: (r, text) => calls.push(['send', r.key, text]),
    answer: (r, id, d) => { calls.push(['answer', id, d]); return id === 'toolu_1'; },
    interrupt: async r => calls.push(['interrupt', r.key]),
    close: key => calls.push(['close', key]),
  });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-chat-')));
  const store = new Store();
  for (const id of ['free-1', 'term-1']) {
    store.ingest({ type: 'user', sessionId: id, timestamp: new Date().toISOString(), cwd: dir, message: { role: 'user', content: 'hi' } });
  }
  const live = { current: () => new Map([['term-1', { pid: 1, status: 'idle' }]]) };
  const server = createServer({ store, watcher: new EventEmitter(), runner, live });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (p, body, headers = {}) => request(port, { method: 'POST', path: p, headers: { 'x-console': '1', ...headers }, body });
  try {
    assert.equal((await post('/api/sessions/free-1/messages', { text: '  ' })).status, 400);
    assert.equal((await post('/api/sessions/free-1/messages', { text: 'go on' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/sessions/free-1/messages', { text: 'go on' })).status, 200);
    assert.deepEqual(calls.at(-1), ['start', { cwd: dir, prompt: 'go on', resume: 'free-1', permissionMode: 'default' }]);
    assert.equal((await post('/api/sessions/free-1/messages', { text: 'more' })).status, 200);
    assert.deepEqual(calls.at(-1), ['send', 'a00', 'more'], 'a running session gets the message directly');

    const term = await post('/api/sessions/term-1/messages', { text: 'hi' });
    assert.equal(term.status, 409);
    assert.match(JSON.parse(term.body).error, /open in a terminal/);
    assert.equal((await post('/api/sessions/term-1/fork', { text: 'hi' })).status, 200);
    assert.deepEqual(calls.at(-1)[1], { cwd: dir, prompt: 'hi', resume: 'term-1', fork: true, permissionMode: 'default' });

    const list = JSON.parse((await request(port, { path: '/api/sessions' })).body);
    assert.equal(list.sessions.find(s => s.id === 'term-1').openIn, 'terminal');
    assert.equal(list.chat, true);

    assert.equal((await post('/api/runs/a00/approvals/toolu_1', { allow: true, always: true, answers: { 'Which?': 'A', bad: 3 } })).status, 200);
    assert.deepEqual(calls.at(-1), ['answer', 'toolu_1', { allow: true, always: true, message: '', answers: { 'Which?': 'A' } }]);
    assert.equal((await post('/api/runs/a00/approvals/other', { allow: true })).status, 404);
    assert.equal((await post('/api/sessions/free-1/interrupt', {})).status, 200);
    assert.equal((await post('/api/runs/a00/close', {})).status, 200);
    // PA defaults apply to new runs; the message box's mode choice wins.
    const patch = body => request(port, { method: 'PATCH', path: `/api/pas/${projectId(dir)}`, headers: { 'x-console': '1' }, body });
    assert.equal((await patch({ permissionMode: 'bypassPermissions' })).status, 400, 'bypass is never offered');
    assert.equal((await patch({ model: 'rm -rf /' })).status, 400);
    assert.equal((await patch({ model: 'sonnet', permissionMode: 'acceptEdits' })).status, 200);
    assert.equal((await post(`/api/pas/${projectId(dir)}/sessions`, { text: 'new thing' })).status, 200);
    assert.deepEqual(calls.at(-1), ['start', { cwd: dir, prompt: 'new thing', permissionMode: 'acceptEdits', model: 'sonnet' }]);
    assert.equal((await post(`/api/pas/${projectId(dir)}/sessions`, { text: 'plan it', permissionMode: 'plan' })).status, 200);
    assert.equal(calls.at(-1)[1].permissionMode, 'plan');
    assert.equal((await post(`/api/pas/${projectId(dir)}/sessions`, { text: 'x', permissionMode: 'bypassPermissions' })).status, 400);
  } finally {
    server.close();
  }
});
