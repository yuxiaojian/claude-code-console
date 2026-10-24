import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tailer } from '../src/tailer.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-tail-')), 'a.jsonl');

test('holds back a partial last line until its newline arrives', async () => {
  const file = tmp();
  const lines = [];
  const t = new Tailer(l => lines.push(l));

  fs.writeFileSync(file, '{"a":1}\n{"b":');
  await t.poke(file);
  assert.deepEqual(lines, ['{"a":1}']);

  fs.appendFileSync(file, '2}\n');
  await t.poke(file);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test('never splits a multi-byte character across reads', async () => {
  const file = tmp();
  const lines = [];
  const t = new Tailer(l => lines.push(l));
  const full = Buffer.from('{"t":"héllo 👋"}\n');
  fs.writeFileSync(file, full.subarray(0, 9)); // cuts inside "é"
  await t.poke(file);
  fs.appendFileSync(file, full.subarray(9));
  await t.poke(file);
  assert.deepEqual(lines, ['{"t":"héllo 👋"}']);
});

test('concurrent pokes never emit a line twice', async () => {
  const file = tmp();
  const lines = [];
  const t = new Tailer(l => lines.push(l));
  fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `{"i":${i}}`).join('\n') + '\n');
  await Promise.all([t.poke(file), t.poke(file), t.poke(file), t.poke(file)]);
  assert.equal(lines.length, 500);
  assert.equal(new Set(lines).size, 500);
});

test('re-reads from the start if the file is truncated', async () => {
  const file = tmp();
  const lines = [];
  const t = new Tailer(l => lines.push(l));
  fs.writeFileSync(file, '{"old":1}\n{"old":2}\n');
  await t.poke(file);
  fs.writeFileSync(file, '{"new":1}\n');
  await t.poke(file);
  assert.deepEqual(lines, ['{"old":1}', '{"old":2}', '{"new":1}']);
});
