import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexRunner, MODES } from '../src/codex/runner.js';
import { CodexError } from '../src/codex/errors.js';

const THREAD = '01a10000-0000-7000-8000-0000000000f1';
const FORKED = '01a10000-0000-7000-8000-0000000000f2';
const tick = () => new Promise(r => setTimeout(r, 5));
const until = async (fn, ms = 1000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(); }
};

/**
 * An in-process stand-in for `codex app-server`, speaking the 0.164.0 JSON-RPC shapes.
 * `handle(method, params, server)` returns a result, or throws { message } for a JSON-RPC error.
 */
function fakeCodex(handle) {
  const log = { calls: [], replies: new Map(), children: [], spawned: [] };
  const spawn = (cmd, args, opts) => {
    log.spawned.push({ cmd, args, cwd: opts.cwd });
    const child = new EventEmitter();
    child.pid = 40_000 + log.children.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let reqId = 100;
    const waiting = new Map();
    const send = m => child.stdout.write(JSON.stringify(m) + '\n');
    const server = {
      notify: (method, params) => send({ method, params }),
      request: (method, params) => new Promise(resolve => { const id = reqId++; waiting.set(id, resolve); send({ id, method, params }); }),
      raw: line => child.stdout.write(line + '\n'),
      exit: (code = 1) => { child.exitCode = code; child.emit('exit', code); },
    };
    let buf = '';
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk;
        for (let i; (i = buf.indexOf('\n')) !== -1;) {
          const m = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (m.method) {
            log.calls.push([m.method, m.params]);
            if (m.id == null) continue;
            Promise.resolve().then(() => handle(m.method, m.params || {}, server))
              .then(result => send({ id: m.id, result: result ?? {} }), err => send({ id: m.id, error: { code: -32600, message: err.message } }));
          } else if (waiting.has(m.id)) {
            log.replies.set(m.id, m);
            waiting.get(m.id)(m);
            waiting.delete(m.id);
          }
        }
        cb();
      },
    });
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null)); };
    log.children.push({ child, server });
    return child;
  };
  return { spawn, log };
}

/** A well-behaved server: threads start and fork; each turn runs `onTurn`. */
function standard(onTurn = async () => {}) {
  let turn = 0;
  return async (method, p, server) => {
    switch (method) {
      case 'initialize': return { userAgent: 'fake/0.164.0' };
      case 'thread/start': return { thread: { id: THREAD }, model: 'gpt-test', approvalPolicy: p.approvalPolicy, sandbox: { type: p.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } };
      case 'thread/fork': return { thread: { id: FORKED, forkedFromId: p.threadId }, model: 'gpt-test', approvalPolicy: p.approvalPolicy, sandbox: { type: 'workspaceWrite' } };
      case 'turn/start': {
        const id = `turn-${++turn}`;
        setImmediate(async () => {
          server.notify('turn/started', { threadId: p.threadId, turn: { id } });
          const status = await onTurn(server, id, p);
          server.notify('turn/completed', { threadId: p.threadId, turn: { id, status: status?.status || 'completed', error: status?.error || null } });
        });
        return { turn: { id, status: 'inProgress' } };
      }
      case 'turn/interrupt': return {};
      case 'turn/steer': return { turnId: p.expectedTurnId };
      default: throw new Error(`unexpected ${method}`);
    }
  };
}

const available = { installed: true, version: '0.164.0', chat: true };

test('start: initialize, thread/start with the native preset and console source, then the first turn', async () => {
  const { spawn, log } = fakeCodex(standard());
  const runner = new CodexRunner({ spawn, available });
  const run = await runner.start({ cwd: '/w', prompt: 'hello', mode: 'read-only', model: 'gpt-test' });
  assert.equal(run.sessionId, THREAD);
  assert.deepEqual(log.spawned[0], { cmd: 'codex', args: ['app-server'], cwd: '/w' });
  const calls = Object.fromEntries(log.calls.map(([m, p]) => [m, p]));
  assert.equal(calls.initialize.clientInfo.name, 'claude_code_console');
  assert.deepEqual(calls['thread/start'], { cwd: '/w', approvalPolicy: 'on-request', sandbox: 'read-only', threadSource: 'claude_code_console', model: 'gpt-test' });
  assert.deepEqual(calls['turn/start'].input, [{ type: 'text', text: 'hello', text_elements: [] }]);
  assert.equal(calls['turn/start'].approvalPolicy, undefined, 'no policy override unless the mode changed');
  assert.deepEqual(run.policy, { approval: 'on-request', sandbox: 'read-only' }, 'the effective policy Codex reported');
  await until(() => run.state === 'idle');
  assert.equal(runner.bySession(THREAD), run);
  assert.deepEqual([...runner.ownPids()], [40_000]);
  runner.closeAll();
  assert.equal(run.state, 'closed');
  assert.equal(runner.bySession(THREAD), null);
});

test('presets never include full access or never-ask', () => {
  for (const m of Object.values(MODES)) {
    assert.notEqual(m.sandbox, 'danger-full-access');
    assert.notEqual(m.approvalPolicy, 'never');
  }
});

test('fork: thread/fork of the source, then the turn; follow-ups steer an active turn', async () => {
  let release;
  const { spawn, log } = fakeCodex(standard(() => new Promise(r => { release = r; })));
  const runner = new CodexRunner({ spawn, available });
  const run = await runner.start({ cwd: '/w', prompt: 'hi', fork: THREAD });
  assert.equal(run.sessionId, FORKED);
  assert.equal(run.forkedFrom, THREAD);
  assert.equal(log.calls.find(c => c[0] === 'thread/fork')[1].threadId, THREAD);
  assert.ok(!log.calls.some(c => c[0] === 'thread/resume'), 'the console never resumes');
  await until(() => run.turnId === 'turn-1' && release);
  await runner.send(run, 'also this');
  assert.deepEqual(log.calls.at(-1), ['turn/steer', { threadId: FORKED, expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'also this', text_elements: [] }] }]);
  await runner.interrupt(run);
  assert.deepEqual(log.calls.at(-1), ['turn/interrupt', { threadId: FORKED, turnId: 'turn-1' }]);
  release();
  await until(() => run.state === 'idle');
  runner.closeAll();
});

test('a mode change applies to the next turn as native overrides', async () => {
  const { spawn, log } = fakeCodex(standard());
  const runner = new CodexRunner({ spawn, available });
  const run = await runner.start({ cwd: '/w', prompt: 'hi' });
  await until(() => run.state === 'idle');
  await runner.setMode(run, 'untrusted');
  assert.equal(runner.snapshot()[0].modePending, true);
  await assert.rejects(runner.setMode(run, 'danger-full-access'), /Unknown Codex policy/);
  await runner.send(run, 'next');
  const last = log.calls.filter(c => c[0] === 'turn/start').at(-1)[1];
  assert.equal(last.approvalPolicy, 'untrusted');
  assert.deepEqual(last.sandboxPolicy, { type: 'workspaceWrite' });
  assert.deepEqual(run.policy, { approval: 'untrusted', sandbox: 'workspace-write', requested: true });
  runner.closeAll();
});

test('command approvals offer exactly the native decisions and are answered once', async () => {
  let reply;
  const { spawn } = fakeCodex(standard(async server => {
    reply = await server.request('item/commandExecution/requestApproval', {
      threadId: THREAD, turnId: 'turn-1', itemId: 'exec-1', startedAtMs: 1, command: "/bin/zsh -lc 'touch probe.txt'", cwd: '/w',
      reason: 'Allow creating probe.txt?',
      availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'probe.txt'] } }, 'cancel', 'somethingNew'],
    });
  }));
  const runner = new CodexRunner({ spawn, available });
  const run = await runner.start({ cwd: '/w', prompt: 'touch it' });
  await until(() => run.approvals.size === 1);
  const [a] = runner.snapshot()[0].approvals;
  assert.equal(a.kind, 'command');
  assert.equal(a.command, "/bin/zsh -lc 'touch probe.txt'");
  assert.deepEqual(a.decisions.map(d => d.id), ['accept', 'execpolicy', 'cancel'], 'unknown decisions are left out');
  assert.match(a.decisions[1].label, /saved to your Codex rules/);
  assert.equal(a.decisions[1].persistent, true);
  assert.throws(() => runner.answer(run, a.id, { decision: 'decline' }), /Unknown decision/, 'decline was not offered');
  assert.equal(runner.answer(run, a.id, { decision: 'execpolicy' }), true);
  assert.equal(runner.answer(run, a.id, { decision: 'accept' }), false, 'a second answer finds nothing');
  await until(() => reply);
  assert.deepEqual(reply.result, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'probe.txt'] } } });
  runner.closeAll();
});

test('questions: answers go back by question id; skip sends none; secrets never appear in the snapshot', async () => {
  const replies = [];
  const { spawn } = fakeCodex(standard(async server => {
    replies.push(await server.request('item/tool/requestUserInput', {
      threadId: THREAD, turnId: 'turn-1', itemId: 'q', isBlocking: true,
      questions: [{ id: 'color', header: 'Pick', question: 'Which color?', options: [{ label: 'Red', description: '' }] }, { id: 'key', header: 'Key', question: 'API key?', isSecret: true }],
    }));
    replies.push(await server.request('item/tool/requestUserInput', { threadId: THREAD, turnId: 'turn-1', itemId: 'q2', isBlocking: true, questions: [{ id: 'x', header: '', question: 'Skip me?' }] }));
  }));
  const runner = new CodexRunner({ spawn, available });
  const run = await runner.start({ cwd: '/w', prompt: 'ask' });
  await until(() => run.approvals.size === 1);
  let [a] = runner.snapshot()[0].approvals;
  assert.equal(a.kind, 'question');
  assert.equal(a.questions[1].isSecret, true);
  assert.throws(() => runner.answer(run, a.id, { answers: { color: ['Red'] } }), /every question/);
  assert.equal(runner.answer(run, a.id, { answers: { color: ['Red'], key: ['s3cr3t-value'] } }), true);
  assert.doesNotMatch(JSON.stringify(runner.snapshot()), /s3cr3t/);
  await until(() => run.approvals.size === 1);
  [a] = runner.snapshot()[0].approvals;
  assert.equal(runner.answer(run, a.id, { decision: 'skip' }), true);
  await until(() => replies.length === 2);
  assert.deepEqual(replies[0].result, { answers: { color: { answers: ['Red'] }, key: { answers: ['s3cr3t-value'] } } });
  assert.deepEqual(replies[1].result, { answers: {} });
  runner.closeAll();
});

test('file changes, permissions and MCP elicitation get native cards; unsupported requests get an error', async () => {
  const replies = [];
  const { spawn } = fakeCodex(standard(async server => {
    server.notify('item/started', { item: { type: 'fileChange', id: 'fc1', changes: [{ path: '/w/a.js', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' }] } });
    replies.push(await server.request('item/fileChange/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: 'fc1', startedAtMs: 1 }));
    replies.push(await server.request('item/permissions/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: 'p', startedAtMs: 1, cwd: '/w', permissions: { network: { enabled: true }, extra: 1 } }));
    replies.push(await server.request('mcpServer/elicitation/request', { serverName: 'docs', message: 'Sign in?' }));
    replies.push(await server.request('item/tool/call', { tool: 'x' }));
    replies.push(await server.request('account/chatgptAuthTokens/refresh', {}));
  }));
  const runner = new CodexRunner({ spawn, available });
  const run = await runner.start({ cwd: '/w', prompt: 'go' });
  const next = async () => { await until(() => run.approvals.size === 1); return runner.snapshot()[0].approvals[0]; };
  let a = await next();
  assert.equal(a.kind, 'fileChange');
  assert.deepEqual(a.files[0].diff.hunks[0].lines, ['-a', '+b']);
  assert.deepEqual(a.decisions.map(d => d.id), ['accept', 'acceptForSession', 'decline', 'cancel']);
  runner.answer(run, a.id, { decision: 'decline' });
  a = await next();
  assert.equal(a.kind, 'permissions');
  assert.deepEqual(a.permissions, { network: { enabled: true } });
  runner.answer(run, a.id, { decision: 'session' });
  a = await next();
  assert.equal(a.kind, 'elicitation');
  assert.deepEqual(a.decisions.map(d => d.id), ['decline', 'cancel'], 'the console never accepts an elicitation');
  runner.answer(run, a.id, { decision: 'decline' });
  await until(() => replies.length === 5);
  assert.deepEqual(replies[0].result, { decision: 'decline' });
  assert.deepEqual(replies[1].result, { permissions: { network: { enabled: true } }, scope: 'session' });
  assert.deepEqual(replies[2].result, { action: 'decline' });
  assert.match(replies[3].error.message, /Not supported/);
  assert.match(replies[4].error.message, /Not supported/);
  runner.closeAll();
});

test('a request Codex resolves itself (interrupt, timeout) drops its card', async () => {
  const { spawn, log } = fakeCodex(standard(async (server, turnId) => {
    server.request('item/commandExecution/requestApproval', { threadId: THREAD, turnId, itemId: 'e', startedAtMs: 1, command: 'ls' });
    await new Promise(r => setTimeout(r, 30));
    server.notify('serverRequest/resolved', { threadId: THREAD, requestId: 100 });
    await new Promise(r => setTimeout(r, 30));
    return { status: 'interrupted' };
  }));
  const runner = new CodexRunner({ spawn, available });
  const run = await runner.start({ cwd: '/w', prompt: 'go' });
  await until(() => run.approvals.size === 1);
  const id = [...run.approvals.keys()][0];
  await until(() => run.approvals.size === 0);
  assert.equal(runner.answer(run, id, { decision: 'accept' }), false, 'a stale card can no longer grant anything');
  assert.equal(log.children[0].child.stdin.writableLength, 0);
  runner.closeAll();
});

test('closing or a crash while an approval waits answers nothing', async () => {
  for (const how of ['close', 'crash']) {
    const { spawn, log } = fakeCodex(standard(async server => { await server.request('item/commandExecution/requestApproval', { threadId: THREAD, turnId: 't', itemId: 'e', startedAtMs: 1, command: 'ls' }); }));
    const runner = new CodexRunner({ spawn, available });
    const run = await runner.start({ cwd: '/w', prompt: 'go' });
    await until(() => run.approvals.size === 1);
    const id = [...run.approvals.keys()][0];
    if (how === 'close') runner.close(run.key); else log.children[0].server.exit(1);
    await until(() => run.state === 'closed');
    assert.equal(run.approvals.size, 0);
    assert.equal(log.replies.size, 0, 'no reply was sent');
    assert.equal(runner.answer(run, id, { decision: 'accept' }), false);
    if (how === 'crash') assert.match(runner.snapshot()[0].error, /stopped unexpectedly/);
    if (how === 'close') assert.equal(log.children[0].child.killed, true, 'only the console’s own child is ended');
  }
});

test('a writer conflict at turn/start gives up without retrying and leaves no owned run', async () => {
  const { spawn, log } = fakeCodex(async (method, p) => {
    if (method === 'initialize') return {};
    if (method === 'thread/fork') return { thread: { id: FORKED } };
    if (method === 'turn/start') throw new Error(`thread ${p.threadId} already has an active writer`);
    throw new Error('unexpected');
  });
  const runner = new CodexRunner({ spawn, available });
  await assert.rejects(runner.start({ cwd: '/w', prompt: 'go', fork: THREAD }), err => err instanceof CodexError && err.category === 'busy' && /another Codex process/.test(err.message));
  assert.equal(log.calls.filter(c => c[0] === 'turn/start').length, 1, 'no retry');
  assert.equal(runner.runs.size, 0);
  assert.equal(runner.bySession(FORKED), null);
  assert.equal(log.children[0].child.killed, true);
});

test('protocol and login failures come back as safe fixed messages', async () => {
  const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV';
  for (const [msg, re] of [[`401 Unauthorized: invalid api key ${secret}`, /codex login/], [`weird failure at /Users/me/.codex/x ${secret}`, /^Codex sent a reply|^Codex reported/]]) {
    const { spawn } = fakeCodex(async method => { if (method === 'initialize') return {}; throw new Error(msg); });
    const runner = new CodexRunner({ spawn, available });
    const err = await runner.start({ cwd: '/w', prompt: 'go' }).catch(e => e);
    assert.ok(err instanceof CodexError);
    assert.match(err.message, re);
    assert.doesNotMatch(err.message, /sk-proj|\/Users/);
  }
  const { spawn } = fakeCodex(async method => (method === 'initialize' ? {} : { thread: {} }));
  const err = await new CodexRunner({ spawn, available }).start({ cwd: '/w', prompt: 'go' }).catch(e => e);
  assert.equal(err.category, 'protocol', 'a reply without a thread id is a protocol error');
});

test('failed turns show a redacted reason; garbage lines from the server are ignored', async () => {
  const { spawn } = fakeCodex(standard(async server => {
    server.raw('this is not json');
    server.raw('{"jsonrpc":"2.0"}');
    return { status: 'failed', error: { message: 'Rate limit reached for sk-proj-ABCDEFGHIJKLMNOPQRS on /Users/me/x' } };
  }));
  const runner = new CodexRunner({ spawn, available });
  const run = await runner.start({ cwd: '/w', prompt: 'go' });
  await until(() => run.state === 'idle');
  const error = runner.snapshot()[0].error;
  assert.match(error, /Rate limit reached/);
  assert.doesNotMatch(error, /sk-proj|\/Users/);
  runner.closeAll();
});

test('without a usable Codex, starting explains why', async () => {
  await assert.rejects(new CodexRunner({ available: { installed: false, chat: false } }).start({ cwd: '/w', prompt: 'x' }), /not installed/);
  await assert.rejects(new CodexRunner({ available: { installed: true, chat: false } }).start({ cwd: '/w', prompt: 'x' }), /not been tested/);
  const { spawn } = fakeCodex(standard());
  await assert.rejects(new CodexRunner({ spawn, available }).start({ cwd: '/w', prompt: 'x', mode: 'danger-full-access' }), /Unknown Codex policy/);
});

test('idle runs are closed after a while', async () => {
  const { spawn } = fakeCodex(standard());
  const runner = new CodexRunner({ spawn, available, idleMs: 20 });
  const run = await runner.start({ cwd: '/w', prompt: 'hi' });
  await until(() => run.state === 'closed');
});

test('a failed start ends the console’s child, whatever step failed', async () => {
  const steps = ['thread/start', 'thread/fork', 'turn/start'];
  for (const failing of [...steps, 'initialize', 'timeout']) {
    const { spawn, log } = fakeCodex(async (method, p) => {
      if (failing === 'timeout' && method === 'thread/start') return new Promise(() => {}); // never answers
      if (method === failing) throw new Error('boom');
      if (method === 'initialize') return {};
      if (method === 'thread/start' || method === 'thread/fork') return { thread: { id: THREAD }, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } };
      if (method === 'turn/start') return { turn: { id: 't', status: 'inProgress' } };
      throw new Error('unexpected');
    });
    const runner = new CodexRunner({ spawn, available, rpcTimeoutMs: 30 });
    await assert.rejects(runner.start({ cwd: '/w', prompt: 'go', fork: failing === 'thread/fork' ? THREAD : null }));
    assert.equal(runner.runs.size, 0, failing);
    assert.equal(log.children[0].child.killed, true, `child ended after ${failing} failed`);
  }
});

test('a refused or timed-out interrupt is reported, and the run carries on', async () => {
  for (const how of ['refuse', 'timeout']) {
    let release;
    const handle = standard(() => new Promise(r => { release = r; }));
    const { spawn } = fakeCodex(async (method, p, server) => {
      if (method === 'turn/interrupt') return how === 'refuse' ? Promise.reject(new Error('no active turn /Users/x sk-proj-abcdefghijklmnop')) : new Promise(() => {});
      return handle(method, p, server);
    });
    const runner = new CodexRunner({ spawn, available, rpcTimeoutMs: 40 });
    const run = await runner.start({ cwd: '/w', prompt: 'go' });
    await until(() => run.turnId && release);
    const err = await runner.interrupt(run).catch(e => e);
    assert.ok(err instanceof CodexError, how);
    assert.equal(err.category, 'interrupt');
    assert.doesNotMatch(err.message, /sk-proj|\/Users/);
    assert.equal(run.state, 'running', 'the run is still there');
    release();
    await until(() => run.state === 'idle');
    runner.closeAll();
  }
});

test('a policy change during a running turn is not applied by steering: the message is refused until the next turn', async () => {
  let release;
  const { spawn, log } = fakeCodex(standard(() => new Promise(r => { release = r; })));
  const runner = new CodexRunner({ spawn, available });
  const run = await runner.start({ cwd: '/w', prompt: 'long job' });
  await until(() => run.turnId && release);
  await runner.setMode(run, 'read-only');
  const err = await runner.send(run, 'now read-only please').catch(e => e);
  assert.equal(err?.category, 'policyPending');
  assert.ok(!log.calls.some(c => c[0] === 'turn/steer'), 'nothing went out under the old policy');
  assert.equal(run.state, 'running');
  release();
  await until(() => run.state === 'idle');
  await runner.send(run, 'now read-only please');
  const last = log.calls.filter(c => c[0] === 'turn/start').at(-1)[1];
  assert.equal(last.approvalPolicy, 'on-request');
  assert.deepEqual(last.sandboxPolicy, { type: 'readOnly' });
  assert.equal(runner.snapshot()[0].modePending, false);
  assert.equal(runner.snapshot()[0].policy.requested, true);
  // Without a pending change, follow-ups during a turn still steer it.
  await until(() => run.turnId);
  await runner.send(run, 'and this');
  assert.equal(log.calls.at(-1)[0], 'turn/steer');
  release();
  runner.closeAll();
});

test('managed settings: a substituted policy is shown; a requirements error gets a fixed message; others stay generic', async () => {
  const { spawn } = fakeCodex(async (method, p) => {
    if (method === 'initialize') return {};
    if (method === 'thread/start') return { thread: { id: THREAD }, approvalPolicy: 'untrusted', sandbox: { type: 'readOnly' } };
    if (method === 'turn/start') return { turn: { id: 't', status: 'completed' } };
    throw new Error('unexpected');
  });
  const runner = new CodexRunner({ spawn, available });
  const run = await runner.start({ cwd: '/w', prompt: 'go' });
  assert.deepEqual(run.policy, { approval: 'untrusted', sandbox: 'read-only' });
  assert.match(runner.snapshot()[0].notice, /instead of on-request · workspace-write.*managed settings/);
  runner.closeAll();

  for (const [msg, cat] of [
    ['`sandbox_mode` value `workspace-write` is disallowed by requirements (allowed: read-only)', 'managed'],
    ['approval_policy `on-request` is not in the allowed set [never]', 'managed'],
    ['401 Unauthorized', 'login'],
    ['stream disconnected', 'failed'],
  ]) {
    const { spawn: sp } = fakeCodex(async method => { if (method === 'initialize') return {}; throw new Error(msg); });
    const err = await new CodexRunner({ spawn: sp, available }).start({ cwd: '/w', prompt: 'go' }).catch(e => e);
    assert.equal(err.category, cat, msg);
    if (cat === 'managed') assert.match(err.message, /managed settings don’t allow/);
    assert.doesNotMatch(err.message, /allowed: read-only|\[never\]/, 'native text is not passed on');
  }
});
