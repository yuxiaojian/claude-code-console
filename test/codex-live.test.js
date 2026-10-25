import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexLive, parseLsof } from '../src/codex/live.js';
import { categorize, redact, turnErrorText } from '../src/codex/errors.js';

const A = '01a10000-0000-7000-8000-00000000000a';
const B = '01a10000-0000-7000-8000-00000000000b';
const C = '01a10000-0000-7000-8000-00000000000c';

function lockDir(...ids) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-locks-'));
  for (const id of ids) fs.writeFileSync(path.join(dir, `${id}.lock`), '');
  fs.writeFileSync(path.join(dir, '.coordination.lock'), '');
  fs.writeFileSync(path.join(dir, '../evil.lock'.replace('../', 'x')), '');
  return dir;
}

test('parseLsof reads -F pn output', () => {
  const m = parseLsof('p12\nf40\nn/a/x.lock\np13\nf3\nn/a/x.lock\nn/a/y.lock\n');
  assert.deepEqual([...m.get('/a/x.lock')], [12, 13]);
  assert.deepEqual([...m.get('/a/y.lock')], [13]);
});

test('a lock held by another process is external; the console’s own and stale files are not', async () => {
  const dir = lockDir(A, B, C);
  const live = new CodexLive({
    dir,
    ownPids: () => new Set([500]),
    run: async files => {
      assert.ok(files.every(f => path.dirname(f) === dir && /\/[0-9a-f-]{36}\.lock$/.test(f)), 'only well-formed lock files are passed to lsof');
      return { out: `p500\nn${dir}/${A}.lock\np777\nn${dir}/${B}.lock\n`, failed: false };
    },
  });
  await live.refresh();
  const m = live.current();
  assert.equal(m.get(A), undefined, 'our own app-server');
  assert.deepEqual(m.get(B), { state: 'external', pids: [777] });
  assert.equal(m.get(C), undefined, 'a stale file nobody holds');
});

test('if lsof is missing, fails or is denied, unheld locks are unknown — never free', async () => {
  const dir = lockDir(A, B);
  for (const run of [async () => { throw new Error('ENOENT'); }, async () => ({ out: '', failed: true }), async () => ({ out: `p9\nn${dir}/${B}.lock\n`, failed: true })]) {
    const live = new CodexLive({ dir, run });
    await live.refresh();
    const m = live.current();
    assert.equal(m.get(A).state, 'unknown');
    assert.ok(['unknown', 'external'].includes(m.get(B).state));
  }
});

test('no lock directory, no locks, no lsof call', async () => {
  let called = 0;
  const live = new CodexLive({ dir: path.join(os.tmpdir(), 'ccc-nope-' + Date.now()), run: async () => { called++; return { out: '', failed: false }; } });
  await live.refresh();
  assert.equal(live.current().size, 0);
  assert.equal(called, 0);
});

test('redact removes credentials and paths, including at the very start', () => {
  const cases = [
    'sk-proj-abcdefghijklmnopqrstuvwxyz rejected',
    'Authorization: Bearer abc.def.ghi',
    'api_key=shortsecret failed',
    'token: "quoted secret value"',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
    '/Users/alice/.codex/auth.json not found',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'x'.repeat(40),
  ];
  for (const c of cases) {
    const out = redact(c);
    assert.doesNotMatch(out, /abcdefghij|abc\.def|shortsecret|quoted secret|eyJhbGci|alice|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/, `${c} -> ${out}`);
  }
  assert.equal(redact('Rate limit reached, retry in 20s'), 'Rate limit reached, retry in 20s');
  assert.ok(redact('a'.repeat(500)).length <= 200);
});

test('error categories map to fixed messages', () => {
  assert.equal(categorize({ message: 'thread x already has an active writer' }), 'busy');
  assert.equal(categorize({ message: 'anything', codexErrorInfo: 'unauthorized' }), 'login');
  assert.equal(categorize({ message: '401 Unauthorized' }), 'login');
  assert.equal(categorize({ message: 'boom' }), 'failed');
  assert.match(turnErrorText({ message: '401 for sk-proj-abcdefghijklmnop' }), /^Codex is not logged in/);
  assert.doesNotMatch(turnErrorText({ message: 'quota for sk-proj-abcdefghijklmnop' }), /sk-proj/);
});
