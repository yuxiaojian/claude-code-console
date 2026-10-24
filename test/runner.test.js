import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../src/runner.js';

/** A stand-in for the SDK's query(): one "turn" per user message, asking before a tool if the text says so. */
function fakeQuery(log) {
  return ({ prompt, options }) => {
    log.options = options;
    let closed = false;
    const it = (async function* () {
      for await (const msg of prompt) {
        if (closed) return;
        const text = msg.message.content;
        log.prompts.push(text);
        yield { type: 'system', subtype: 'init', session_id: options.forkSession ? 'forked-1' : options.resume || 'new-1' };
        if (text.includes('tool')) {
          const ac = new AbortController();
          const decision = await options.canUseTool('Bash', { command: 'rm -rf build' }, {
            signal: ac.signal, toolUseID: 'toolu_1', displayName: 'Bash', description: 'rm -rf build',
            suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'allow', destination: 'session' }],
          });
          log.decisions.push(decision);
        }
        if (text.includes('fail')) yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] };
        else yield { type: 'result', subtype: 'success', is_error: false };
      }
    })();
    return Object.assign(it, {
      interrupt: async () => { log.interrupts++; },
      setPermissionMode: async mode => { log.modes = [...(log.modes || []), mode]; },
      close: () => { closed = true; it.return(); },
    });
  };
}

const tick = () => new Promise(r => setTimeout(r, 10));
const until = async (fn, ms = 1000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(); }
};

test('a new session gets its id from init, and follow-ups go to the same process', async () => {
  const log = { prompts: [], decisions: [], interrupts: 0 };
  const runner = new Runner({ query: fakeQuery(log) });
  const run = await runner.start({ cwd: '/w', prompt: 'hello' });
  await until(() => run.state === 'idle');
  assert.equal(run.sessionId, 'new-1');
  assert.equal(log.options.cwd, '/w');
  assert.equal(log.options.permissionMode, 'default', 'console runs ask before tools');
  assert.equal(runner.bySession('new-1'), run);
  assert.deepEqual([...runner.ownedSessions()], ['new-1']);

  runner.send(run, 'again');
  await until(() => log.prompts.length === 2 && run.state === 'idle');
  assert.deepEqual(log.prompts, ['hello', 'again']);
  runner.closeAll();
  assert.equal(run.state, 'closed');
  assert.equal(runner.bySession('new-1'), null);
});

test('approvals wait for the browser; "always" passes the suggested rules along', async () => {
  const log = { prompts: [], decisions: [], interrupts: 0 };
  const runner = new Runner({ query: fakeQuery(log) });
  let changes = 0;
  runner.on('change', () => changes++);
  const run = await runner.start({ cwd: '/w', prompt: 'use a tool', resume: 'abc' });
  await until(() => run.approvals.size === 1);
  const [a] = runner.snapshot()[0].approvals;
  assert.equal(a.id, 'toolu_1');
  assert.equal(a.tool, 'Bash');
  assert.equal(a.canAlways, true);
  assert.equal(run.sessionId, 'abc');
  assert.ok(changes > 0);

  assert.equal(runner.answer(run, 'nope', { allow: true }), false);
  assert.equal(runner.answer(run, 'toolu_1', { allow: true, always: true }), true);
  await until(() => log.decisions.length === 1);
  assert.equal(log.decisions[0].behavior, 'allow');
  assert.deepEqual(log.decisions[0].updatedInput, { command: 'rm -rf build' });
  assert.equal(log.decisions[0].updatedPermissions[0].type, 'addRules');
  assert.equal(run.approvals.size, 0);

  runner.send(run, 'tool again');
  await until(() => run.approvals.size === 1);
  runner.answer(run, 'toolu_1', { allow: false, message: 'use git clean instead' });
  await until(() => log.decisions.length === 2);
  assert.deepEqual(log.decisions[1], { behavior: 'deny', message: 'use git clean instead' });
  runner.closeAll();
});

test('closing a run denies anything still waiting; errors and forks are reported', async () => {
  const log = { prompts: [], decisions: [], interrupts: 0 };
  const runner = new Runner({ query: fakeQuery(log) });
  const run = await runner.start({ cwd: '/w', prompt: 'tool please' });
  await until(() => run.approvals.size === 1);
  runner.close(run.key);
  await until(() => log.decisions.length === 1);
  assert.equal(log.decisions[0].behavior, 'deny');

  const fork = await runner.start({ cwd: '/w', prompt: 'this will fail', resume: 'orig', fork: true });
  assert.equal(fork.sessionId, null, 'a fork has no id until Claude Code assigns one');
  await until(() => fork.state === 'idle');
  assert.equal(fork.sessionId, 'forked-1');
  assert.equal(fork.forkedFrom, 'orig');
  assert.equal(fork.error, 'boom');
  assert.equal(log.options.forkSession, true);
  await runner.interrupt(fork);
  assert.equal(log.interrupts, 1);
  runner.closeAll();
});

test('without the SDK, starting a run explains why', async () => {
  await assert.rejects(new Runner({ query: null }).start({ cwd: '/w', prompt: 'hi' }), /Agent SDK/);
});

test('idle processes are closed after a while', async () => {
  const log = { prompts: [], decisions: [], interrupts: 0 };
  const runner = new Runner({ query: fakeQuery(log), idleMs: 30 });
  const run = await runner.start({ cwd: '/w', prompt: 'hi' });
  await until(() => run.state === 'closed');
});

test('model and mode reach Claude Code; the mode can change while a run is live', async () => {
  const log = { prompts: [], decisions: [], interrupts: 0 };
  const runner = new Runner({ query: fakeQuery(log) });
  const run = await runner.start({ cwd: '/w', prompt: 'hi', model: 'sonnet', permissionMode: 'plan' });
  await until(() => run.state === 'idle');
  assert.equal(log.options.model, 'sonnet');
  assert.equal(log.options.permissionMode, 'plan');
  await runner.setMode(run, 'acceptEdits');
  assert.deepEqual(log.modes, ['acceptEdits']);
  assert.equal(runner.snapshot()[0].mode, 'acceptEdits');
  runner.closeAll();
  await assert.rejects(runner.setMode(run, 'default'), /ended/);
});
