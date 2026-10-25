import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptReader } from '../src/transcript.js';
import { CodexStore } from '../src/codex/store.js';
import { CodexConversation, diffHunks, readCodexConversation } from '../src/codex/transcript.js';
import { agent, aborted, command, fileChange, ids, ingestFiles, lines, meta, user, writeRollouts } from './codex-helpers.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex', 'rollout-0.164.0-exec.jsonl');
const reader = () => new TranscriptReader(() => new CodexConversation());

test('the captured rollout renders prompts and replies, without raw response items', async () => {
  const c = await reader().read(FIXTURE);
  assert.deepEqual(c.items.map(i => [i.k, i.text]), [
    ['user', 'Reply with just the word ok.'],
    ['text', 'ok'],
    ['user', 'Run exactly this shell command: touch probe.txt . If it is declined, reply "declined".'],
    ['text', 'I’ll run the command as requested.'],
    ['text', 'declined'],
  ]);
});

test('commands, file changes and interrupts map onto the viewer’s items', async () => {
  const f = writeRollouts({ a: [
    meta(ids.a), user('fix it'),
    command('npm test', 'ok\n'),
    command('rm -rf x', '', 6, { status: 'declined' }),
    fileChange('/tmp/proj/a.js', { type: 'update', unified_diff: '@@ -1,2 +1,2 @@\n-old\n+new\n same\n' }),
    fileChange('/tmp/proj/new.md', { type: 'add', content: 'line1\nline2' }),
    agent('done'), aborted(), user('fix it'), // the same item id again: ignored
  ] });
  const c = await reader().read(f.a);
  const tools = c.items.filter(i => i.k === 'tool');
  assert.deepEqual(tools.map(t => [t.name, t.target]), [['Bash', 'npm test'], ['Bash', 'rm -rf x'], ['Edit', 'a.js'], ['Edit', 'new.md']]);
  assert.equal(tools[0].result.text, 'ok\n');
  assert.equal(tools[1].result.error, true);
  assert.equal(tools[1].result.text, 'Declined');
  assert.deepEqual(tools[2].diff.hunks[0], { oldStart: 1, newStart: 1, lines: ['-old', '+new', ' same'] });
  assert.deepEqual(tools[3].diff.hunks[0].lines, ['+line1', '+line2']);
  assert.equal(c.items.filter(i => i.k === 'user').length, 1);
  assert.equal(c.items.at(-1).text, 'Interrupted');
});

test('appended lines are picked up incrementally', async () => {
  const f = writeRollouts({ a: [meta(ids.a), user('one')] });
  const r = reader();
  assert.equal((await r.read(f.a)).items.length, 1);
  fs.appendFileSync(f.a, lines([agent('two')]));
  assert.equal((await r.read(f.a)).items.length, 2);
});

test('a fork shows its parent’s history up to the branch point, then its own', async () => {
  const f = writeRollouts({ a: [meta(ids.a), user('root q'), agent('root a')] });
  const end = fs.statSync(f.a).size;
  fs.appendFileSync(f.a, lines([user('after the fork')])); // the parent kept going: not the fork's history
  const b = writeRollouts({ b: [meta(ids.b, { forked_from_id: ids.a, history_base: { thread_id: ids.a, end_byte_offset: end } }), user('fork q')] }).b;
  const store = new CodexStore();
  ingestFiles(store, [f.a, b]);
  const c = await readCodexConversation(reader(), store, store.get(ids.b));
  assert.deepEqual(c.items.map(i => i.text), ['root q', 'root a', 'Forked here', 'fork q']);
});

test('fork history that is missing, out of range or off a line boundary is shown as unavailable', async () => {
  const f = writeRollouts({ a: [meta(ids.a), user('root q')] });
  const size = fs.statSync(f.a).size;
  const cases = [
    [ids.b, size + 100, /unreadable/],
    [ids.c, size - 3, /unreadable/],
  ];
  for (const [id, end, re] of cases) {
    const fork = writeRollouts({ x: [meta(id, { forked_from_id: ids.a, history_base: { thread_id: ids.a, end_byte_offset: end } }), user('mine')] }).x;
    const store = new CodexStore();
    ingestFiles(store, [f.a, fork]);
    const c = await readCodexConversation(reader(), store, store.get(id));
    assert.match(c.items[0].text, re);
    assert.equal(c.items.at(-1).text, 'mine');
    assert.ok(!c.items.some(i => i.text === 'root q'));
  }
  const orphan = writeRollouts({ o: [meta(ids.d, { forked_from_id: ids.a, history_base: { thread_id: ids.a, end_byte_offset: 0 } }), user('alone')] }).o;
  const store = new CodexStore();
  ingestFiles(store, [orphan]);
  const c = await readCodexConversation(reader(), store, store.get(ids.d));
  assert.match(c.items[0].text, /isn't available \(not loaded\)/);
});

test('the reader refuses prefixes outside the file or mid-line', async () => {
  const f = writeRollouts({ a: [meta(ids.a), user('x')] });
  const r = reader();
  await assert.rejects(r.read(f.a, 1e9), /outside/);
  await assert.rejects(r.read(f.a, 5), /line boundary/);
  await assert.rejects(r.read(f.a, -1), /outside/);
  assert.equal((await r.read(f.a, 0)).items.length, 0);
});

test('diffHunks clips huge diffs', () => {
  const d = diffHunks({ content: Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n') });
  assert.equal(d.hunks[0].lines.length, 400);
  assert.equal(d.truncated, true);
  assert.equal(diffHunks({}), null);
});
