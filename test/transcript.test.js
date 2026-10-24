import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversation, TranscriptReader } from '../src/transcript.js';

const T0 = Date.parse('2026-10-24T10:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();
let n = 0;
const line = (sec, extra) => ({ uuid: `u${++n}`, sessionId: 's', timestamp: at(sec), ...extra });
const user = (sec, content, extra) => line(sec, { type: 'user', message: { role: 'user', content }, ...extra });
const asst = (sec, content) => line(sec, { type: 'assistant', message: { id: `m${sec}`, model: 'claude-opus-5-5', content } });
const result = (sec, id, content, extra) => user(sec, [{ type: 'tool_result', tool_use_id: id, content, ...(extra?.block || {}) }], extra?.line);

function conv(events) {
  const c = new Conversation();
  for (const e of events) c.ingest(e);
  return c.view(0);
}

test('prompts, replies and tool calls become items, with results attached to their call', () => {
  const items = conv([
    user(0, 'fix the build'),
    asst(1, [{ type: 'thinking', thinking: 'look at the error first', signature: 'x' }]),
    asst(1, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build', description: 'Build' } }]),
    result(2, 't1', 'ignored', { line: { toolUseResult: { stdout: 'ok\n', stderr: '' } } }),
    asst(3, [{ type: 'text', text: 'Fixed **it**.' }]),
  ]);
  assert.deepEqual(items.map(i => i.k), ['user', 'thinking', 'tool', 'text']);
  const tool = items[2];
  assert.equal(tool.name, 'Bash');
  assert.equal(tool.target, 'npm run build');
  assert.equal(tool.result.text, 'ok\n', 'Bash output comes from stdout/stderr');
  assert.equal(tool.result.error, false);
  assert.equal(items[3].text, 'Fixed **it**.');
});

test('edits carry a diff: Claude Code patch when recorded, otherwise built from the input', () => {
  const patch = [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [' a', '-b', '+c'] }];
  const items = conv([
    asst(1, [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/r/x.js', old_string: 'b', new_string: 'c' } }]),
    result(2, 'e1', 'ok', { line: { toolUseResult: { structuredPatch: patch } } }),
    asst(3, [{ type: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: '/r/y.js', old_string: 'one\ntwo', new_string: 'uno' } }]),
    result(4, 'e2', 'ok'),
    asst(5, [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/r/z.md', content: '# hi\nthere' } }]),
    result(6, 'w1', 'ok', { line: { toolUseResult: { type: 'create', structuredPatch: [] } } }),
  ]);
  const [a, b, w] = items;
  assert.deepEqual(a.diff.hunks[0].lines, [' a', '-b', '+c']);
  assert.equal(a.diff.hunks[0].oldStart, 10);
  assert.deepEqual(b.diff.hunks[0].lines, ['-one', '-two', '+uno']);
  assert.deepEqual(w.diff.hunks[0].lines, ['+# hi', '+there']);
  assert.equal('old_string' in a.input, false, 'file contents live in the diff, not the input');
  assert.equal(a.input.file_path, '/r/x.js');
  assert.equal('fullInput' in a, false);
});

test('long tool output keeps its start and end', () => {
  const big = 'A'.repeat(4000) + 'MIDDLE' + 'Z'.repeat(4000);
  const [tool] = conv([
    asst(1, [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/x' } }]),
    result(2, 'r1', [{ type: 'text', text: big }], { block: { is_error: true } }),
  ]);
  assert.equal(tool.result.truncated, true);
  assert.equal(tool.result.error, true);
  assert.ok(tool.result.text.startsWith('AAA') && tool.result.text.endsWith('ZZZ'));
  assert.ok(!tool.result.text.includes('MIDDLE'));
});

test('slash commands show their output; interrupts, compaction and errors become markers', () => {
  const items = conv([
    user(0, '<command-name>/context</command-name>\n<command-args></command-args>'),
    user(1, '<local-command-stdout>\u001b[1mContext\u001b[22m 12k</local-command-stdout>'),
    user(2, 'go'),
    user(3, [{ type: 'text', text: '[Request interrupted by user]' }]),
    line(10, { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 150000 } }),
    user(11, 'This session is being continued from a previous conversation that ran out of context. Summary…'),
    user(1, '<command-name>/context</command-name>'), // replayed after compaction with its old timestamp
    user(12, 'skill text', { isMeta: true }),
    line(13, { type: 'system', subtype: 'api_error', error: { message: 'Overloaded' }, retryAttempt: 1, maxRetries: 10 }),
    line(14, { type: 'system', subtype: 'api_error', error: { message: 'Overloaded' }, retryAttempt: 2, maxRetries: 10 }),
  ]);
  assert.deepEqual(items.map(i => i.k), ['command', 'user', 'info', 'info', 'summary', 'error']);
  assert.equal(items[0].text, '/context');
  assert.equal(items[0].output, 'Context 12k', 'ANSI codes are stripped');
  assert.equal(items[2].text, 'Interrupted');
  assert.match(items[3].text, /compacted from 150,000 tokens/);
  assert.equal(items[5].text, 'Overloaded (retry 2/10)', 'retries update one item');
});

test('subagent lines and duplicate lines are skipped', () => {
  const dup = user(0, 'hello');
  const items = conv([dup, dup, line(1, { type: 'assistant', isSidechain: true, agentId: 'a1', message: { content: [{ type: 'text', text: 'sub' }] } })]);
  assert.deepEqual(items.map(i => i.text), ['hello']);
});

test('the reader picks up appended lines, holds partial ones, and restarts when a file shrinks', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-tr-')), 's.jsonl');
  const r = new TranscriptReader();
  fs.writeFileSync(file, JSON.stringify(user(0, 'one')) + '\n' + JSON.stringify(user(1, 'two')).slice(0, 20));
  assert.deepEqual((await r.read(file)).view(0).map(i => i.text), ['one']);
  fs.writeFileSync(file, JSON.stringify(user(0, 'one')) + '\n' + JSON.stringify(user(1, 'two')) + '\n');
  // Rewrite in place so the partial line's bytes get completed, like an append would.
  assert.deepEqual((await r.read(file)).view(0).map(i => i.text), ['one', 'two']);
  fs.writeFileSync(file, JSON.stringify(user(5, 'fresh')) + '\n');
  assert.deepEqual((await r.read(file)).view(0).map(i => i.text), ['fresh']);
});
