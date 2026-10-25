import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { CodexStore } from '../src/codex/store.js';
import { CodexError } from '../src/codex/errors.js';
import { createServer, parseKey } from '../src/server.js';
import { Config, projectId } from '../src/projects.js';
import { ids, ingestFiles, meta, turnContext, user, usage, writeRollouts } from './codex-helpers.js';

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `localhost:${port}`, ...headers } }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function fakeCodexRunner(calls, { chat = true } = {}) {
  const runs = new Map();
  return Object.assign(new EventEmitter(), {
    chat,
    runs,
    bySession: id => [...runs.values()].find(r => r.sessionId === id && r.state !== 'closed') || null,
    ownedSessions: () => new Set(),
    snapshot: () => [...runs.values()].map(r => ({ key: r.key, sessionId: r.sessionId, forkedFrom: null, approvals: [] })),
    start: async opts => {
      calls.push(['start', opts]);
      if (opts.prompt === 'native-error') throw new Error('raw native failure at /Users/me with sk-proj-abcdefghijklmnop');
      if (opts.prompt === 'busy') throw new CodexError('busy');
      const r = { key: `c${runs.size}0`, provider: 'codex', sessionId: opts.fork ? 'forked' : 'new', mode: opts.mode, approvals: new Map(), state: 'running' };
      runs.set(r.key, r);
      return r;
    },
    send: async (r, text) => calls.push(['send', r.key, text]),
    setMode: async (r, mode) => { calls.push(['mode', r.key, mode]); r.mode = mode; },
    answer: (r, id, d) => {
      calls.push(['answer', id, d]);
      if (d.decision === 'bogus') throw new Error('Unknown decision');
      return id === 'r1';
    },
    interrupt: async r => calls.push(['interrupt', r.key]),
    close: key => calls.push(['close', key]),
  });
}

async function setup({ codexChat = true, claude = true, token = null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-cx-')));
  const store = new Store();
  store.ingest({ type: 'user', sessionId: 'claude-1', timestamp: new Date().toISOString(), cwd: dir, message: { role: 'user', content: 'hi' } });
  const codexStore = new CodexStore();
  const f = writeRollouts({
    hist: [meta(ids.a, { cwd: dir }), turnContext(1, { cwd: dir }), user('old work'), usage(ids.a, 'r1')],
    ext: [meta(ids.b, { cwd: dir }), user('elsewhere')],
  });
  ingestFiles(codexStore, [f.hist, f.ext]);
  const calls = [];
  const claudeCalls = [];
  const codexRunner = fakeCodexRunner(calls, { chat: codexChat });
  const runner = claude ? Object.assign(new EventEmitter(), {
    query: () => {}, runs: new Map(), ownedSessions: () => new Set(), bySession: () => null, snapshot: () => [],
    start: async opts => { claudeCalls.push(opts); return { key: 'aa', sessionId: null, approvals: new Map() }; },
  }) : null;
  const config = new Config();
  const live = { current: () => new Map([[ids.b, { state: 'external', pids: [9] }]]) };
  const server = createServer({
    store, watcher: new EventEmitter(), config, runner, token,
    codex: { store: codexStore, watcher: new EventEmitter(), runner: codexRunner, live, info: { installed: true, version: '0.164.0', reason: codexChat ? '' : 'Chat for Codex is off.' } },
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (p, body, headers = {}) => request(port, { method: 'POST', path: p, headers: { 'x-console': '1', ...headers }, body });
  return { dir, port, post, calls, claudeCalls, codexRunner, config, codexStore, close: () => server.close() };
}

test('keys are provider-qualified; bare ids still mean Claude', () => {
  assert.deepEqual(parseKey(`codex:${ids.a}`), { provider: 'codex', id: ids.a });
  assert.deepEqual(parseKey('abc-1'), { provider: 'claude', id: 'abc-1' });
  assert.equal(parseKey('codex:../../x'), null);
  assert.equal(parseKey('gemini:abc'), null);
});

test('both providers list together with their own keys, ownership and availability', async () => {
  const t = await setup();
  try {
    const d = (await request(t.port, { path: '/api/sessions' })).json();
    const by = Object.fromEntries(d.sessions.map(s => [s.id, s]));
    assert.ok(by['claude:claude-1']);
    assert.equal(by[`codex:${ids.a}`].provider, 'codex');
    assert.equal(by[`codex:${ids.a}`].nativeId, ids.a);
    assert.equal(by[`codex:${ids.a}`].canContinue, false);
    assert.equal(by[`codex:${ids.b}`].openIn, 'external');
    assert.equal(by[`codex:${ids.a}`].pa, by['claude:claude-1'].pa, 'same folder, same PA');
    assert.deepEqual(d.providers.codex, { installed: true, version: '0.164.0', chat: true, reason: '' });
    assert.equal(d.totals.incomplete, true, 'unpriced Codex usage marks the totals incomplete');
    const pa = d.projects.find(p => p.id === projectId(t.dir));
    assert.deepEqual(pa.codexModels, ['gpt-test']);
    assert.ok(!pa.models.includes('gpt-test'), 'Codex models are not offered as Claude models');
  } finally { t.close(); }
});

test('a Codex session the console is not running is never resumed: refused before any native call', async () => {
  const t = await setup();
  try {
    for (const id of [ids.a, ids.b]) {
      const r = await t.post(`/api/sessions/codex:${id}/messages`, { text: 'continue' });
      assert.equal(r.status, 409);
      assert.match(r.json().error, /Fork it to continue/);
    }
    assert.deepEqual(t.calls, [], 'the runner was never asked to do anything');
    assert.equal((await t.post(`/api/sessions/codex:${ids.a}/interrupt`, {})).status, 409);
    assert.deepEqual(t.calls, []);
  } finally { t.close(); }
});

test('fork works for any Codex session, with the PA’s Codex defaults', async () => {
  const t = await setup();
  try {
    const patch = body => request(t.port, { method: 'PATCH', path: `/api/pas/${projectId(t.dir)}`, headers: { 'x-console': '1' }, body });
    assert.equal((await patch({ codexMode: 'danger-full-access' })).status, 400);
    assert.equal((await patch({ codexMode: 'plan' })).status, 400, 'Claude modes are not Codex policies');
    assert.equal((await patch({ codexModel: 'rm -rf /' })).status, 400);
    assert.equal((await patch({ codexMode: 'read-only', codexModel: 'gpt-test', permissionMode: 'acceptEdits' })).status, 200);
    assert.deepEqual(t.config.get(t.dir), { codexMode: 'read-only', codexModel: 'gpt-test', permissionMode: 'acceptEdits' }, 'stored side by side');
    const r = await t.post(`/api/sessions/codex:${ids.b}/fork`, { text: 'take over' });
    assert.equal(r.status, 200);
    assert.deepEqual(t.calls.at(-1), ['start', { cwd: t.dir, prompt: 'take over', fork: ids.b, mode: 'read-only', model: 'gpt-test' }]);
    assert.equal((await t.post(`/api/sessions/codex:${ids.b}/fork`, { text: 'x', permissionMode: 'acceptEdits' })).status, 400, 'Claude mode on a Codex session');
    assert.equal((await t.post(`/api/sessions/codex:${ids.b}/fork`, { text: 'x', permissionMode: 'untrusted' })).status, 200);
    assert.equal(t.calls.at(-1)[1].mode, 'untrusted');
  } finally { t.close(); }
});

test('the console’s own live run continues; mode changes go to the runner', async () => {
  const t = await setup();
  try {
    const run = { key: 'ab12', provider: 'codex', sessionId: ids.a, mode: 'workspace', approvals: new Map(), state: 'idle' };
    t.codexRunner.runs.set(run.key, run);
    assert.equal((await t.post(`/api/sessions/codex:${ids.a}/messages`, { text: 'more', permissionMode: 'untrusted' })).status, 200);
    assert.deepEqual(t.calls.slice(-2), [['mode', 'ab12', 'untrusted'], ['send', 'ab12', 'more']]);
    const d = (await request(t.port, { path: '/api/sessions' })).json();
    assert.equal(d.sessions.find(s => s.id === `codex:${ids.a}`).canContinue, true);
    assert.equal((await t.post(`/api/sessions/codex:${ids.a}/interrupt`, {})).status, 200);
    assert.deepEqual(t.calls.at(-1), ['interrupt', 'ab12']);
  } finally { t.close(); }
});

test('new sessions pick a provider; unknown providers and unavailable ones are refused', async () => {
  const t = await setup();
  try {
    const url = `/api/pas/${projectId(t.dir)}/sessions`;
    assert.equal((await t.post(url, { text: 'hi', provider: 'gemini' })).status, 400);
    assert.equal((await t.post(url, { text: 'hi', provider: 'codex' })).status, 200);
    assert.deepEqual(t.calls.at(-1), ['start', { cwd: t.dir, prompt: 'hi', mode: 'workspace' }]);
    assert.equal((await t.post(url, { text: 'hi' })).status, 200, 'Claude stays the default');
    assert.equal(t.claudeCalls.length, 1);
    assert.equal(t.claudeCalls[0].permissionMode, 'default');
  } finally { t.close(); }
});

test('provider availability is independent', async () => {
  const off = await setup({ codexChat: false });
  try {
    const r = await off.post(`/api/pas/${projectId(off.dir)}/sessions`, { text: 'hi', provider: 'codex' });
    assert.equal(r.status, 501);
    assert.equal((await off.post(`/api/pas/${projectId(off.dir)}/sessions`, { text: 'hi' })).status, 200, 'Claude still works');
    assert.equal((await request(off.port, { path: `/api/sessions/codex:${ids.a}/transcript` })).status, 200, 'history stays readable');
  } finally { off.close(); }
  const noClaude = await setup({ claude: false });
  try {
    assert.equal((await noClaude.post(`/api/pas/${projectId(noClaude.dir)}/sessions`, { text: 'hi' })).status, 501);
    assert.equal((await noClaude.post(`/api/pas/${projectId(noClaude.dir)}/sessions`, { text: 'hi', provider: 'codex' })).status, 200, 'Codex still works');
  } finally { noClaude.close(); }
});

test('runner errors reach the browser only as safe messages', async () => {
  const t = await setup();
  try {
    const url = `/api/pas/${projectId(t.dir)}/sessions`;
    const raw = await t.post(url, { text: 'native-error', provider: 'codex' });
    assert.equal(raw.status, 409);
    assert.equal(raw.json().error, 'Codex request failed');
    const busy = await t.post(url, { text: 'busy', provider: 'codex' });
    assert.match(busy.json().error, /another Codex process/);
  } finally { t.close(); }
});

test('Codex approvals: native decision ids, 400 for bad ones, 404 once gone', async () => {
  const t = await setup();
  try {
    t.codexRunner.runs.set('cd34', { key: 'cd34', provider: 'codex', sessionId: ids.a, approvals: new Map(), state: 'running' });
    assert.equal((await t.post('/api/runs/cd34/approvals/r1', { decision: 'acceptForSession' })).status, 200);
    assert.deepEqual(t.calls.at(-1), ['answer', 'r1', { decision: 'acceptForSession', answers: null }]);
    assert.equal((await t.post('/api/runs/cd34/approvals/r1', { decision: 'bogus' })).status, 400);
    assert.equal((await t.post('/api/runs/cd34/approvals/r2', { decision: 'accept' })).status, 404);
    await t.post('/api/runs/cd34/approvals/r1', { answers: { q1: ['Red', 3], q2: 'Blue' } });
    assert.deepEqual(t.calls.at(-1)[2].answers, { q1: ['Red'], q2: ['Blue'] });
    assert.equal((await t.post('/api/runs/cd34/mode', { mode: 'plan' })).status, 400);
    assert.equal((await t.post('/api/runs/cd34/mode', { mode: 'read-only' })).status, 200);
    assert.equal((await t.post('/api/runs/cd34/close', {})).status, 200);
    assert.deepEqual(t.calls.at(-1), ['close', 'cd34']);
  } finally { t.close(); }
});

test('Codex routes keep the token, origin and custom-header checks', async () => {
  const t = await setup({ token: 'secret-token-1234567890-abcdefghij' });
  try {
    assert.equal((await request(t.port, { path: `/api/sessions/codex:${ids.a}/transcript` })).status, 401);
    assert.equal((await request(t.port, { method: 'POST', path: `/api/sessions/codex:${ids.a}/fork`, body: { text: 'x' } })).status, 401);
  } finally { t.close(); }
  const u = await setup();
  try {
    assert.equal((await request(u.port, { method: 'POST', path: `/api/sessions/codex:${ids.a}/fork`, body: { text: 'x' } })).status, 403, 'needs the custom header');
    assert.equal((await u.post(`/api/sessions/codex:${ids.a}/fork`, { text: 'x' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await request(u.port, { path: `/api/sessions/codex:${ids.a}`, headers: { host: 'evil.example' } })).status, 403);
    assert.deepEqual(u.calls, []);
  } finally { u.close(); }
});

test('detail, transcript and bare-id lookups', async () => {
  const t = await setup();
  try {
    const d = (await request(t.port, { path: `/api/sessions/codex:${ids.a}` })).json();
    assert.equal(d.id, `codex:${ids.a}`);
    assert.equal(d.provider, 'codex');
    const conv = (await request(t.port, { path: `/api/sessions/codex:${ids.a}/transcript` })).json();
    assert.deepEqual(conv.items.map(i => i.text), ['old work']);
    assert.equal((await request(t.port, { path: '/api/sessions/claude-1' })).json().id, 'claude:claude-1');
    assert.equal((await request(t.port, { path: `/api/sessions/${ids.a}` })).status, 404, 'a bare id is never a Codex session');
    assert.equal((await request(t.port, { path: '/api/sessions/codex:nope' })).status, 404);
  } finally { t.close(); }
});

test('a failed Stop or a pending policy change comes back as a 409 with a safe message', async () => {
  const t = await setup();
  try {
    const run = { key: 'ef56', provider: 'codex', sessionId: ids.a, mode: 'workspace', approvals: new Map(), state: 'running' };
    t.codexRunner.runs.set(run.key, run);
    t.codexRunner.interrupt = async () => { throw new CodexError('interrupt', 'native detail /Users/x'); };
    t.codexRunner.send = async () => { throw new CodexError('policyPending'); };
    const stop = await t.post(`/api/sessions/codex:${ids.a}/interrupt`, {});
    assert.equal(stop.status, 409);
    assert.match(stop.json().error, /didn’t stop the turn/);
    assert.doesNotMatch(stop.body, /Users/);
    const send = await t.post(`/api/sessions/codex:${ids.a}/messages`, { text: 'x', permissionMode: 'read-only' });
    assert.equal(send.status, 409);
    assert.match(send.json().error, /applies from the next turn/);
  } finally { t.close(); }
});
