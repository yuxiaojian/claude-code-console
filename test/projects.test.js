import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config, buildProjects, clearRootCache, projectId, projectRoot } from '../src/projects.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-pa-')));

test('sessions in a repo and its subfolders share the repo root', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'src', 'lib'), { recursive: true });
  clearRootCache();
  assert.equal(projectRoot(repo), repo);
  assert.equal(projectRoot(path.join(repo, 'src', 'lib')), repo);
});

test('a worktree maps to its main repo; a submodule-style .git file without commondir stays put', () => {
  const main = tmp();
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'feat'), { recursive: true });
  fs.writeFileSync(path.join(main, '.git', 'worktrees', 'feat', 'commondir'), '../..\n');
  const wt = tmp();
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'feat')}\n`);

  const sub = tmp();
  fs.mkdirSync(path.join(main, '.git', 'modules', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${path.join(main, '.git', 'modules', 'sub')}\n`);

  clearRootCache();
  assert.equal(projectRoot(wt), main);
  assert.equal(projectRoot(sub), sub);
});

test('a folder reached through a symlink is the same PA as its real path', () => {
  const real = tmp();
  const link = path.join(tmp(), 'link');
  fs.symlinkSync(real, link);
  clearRootCache();
  assert.equal(projectRoot(link), real);
});

test('a folder outside any repo is its own PA, even if it no longer exists', () => {
  clearRootCache();
  const gone = path.join(tmp(), 'deleted', 'folder');
  assert.equal(projectRoot(gone), gone);
  assert.equal(projectRoot(''), '');
});

test('buildProjects groups, names, totals and orders PAs', () => {
  const a = tmp(), b = tmp();
  fs.mkdirSync(path.join(a, 'api'));
  fs.mkdirSync(path.join(b, 'api'));
  clearRootCache();
  const now = Date.parse('2026-10-24T12:00:00');
  const s = (id, cwd, status, lastActivity, spendByDay = {}) => ({ id, cwd, status, lastActivity, spendByDay, title: id });
  const sessions = [
    s('s1', path.join(a, 'api'), 'ended', now - 5000, { '2026-10-24': 1, '2026-10-20': 2, '2026-10-01': 50 }),
    s('s2', path.join(a, 'api'), 'waiting', now - 9000, { '2026-10-24': 0.5 }),
    s('s3', path.join(b, 'api'), 'working', now - 1000),
  ];
  const config = new Config();
  config.set(path.join(b, 'api'), { pinned: true });

  const { projects, totals } = buildProjects(sessions, config, { now, days: 7 });
  assert.equal(projects.length, 2);
  // Pinned first. Same folder name in two places, so names include the parent.
  assert.equal(projects[0].root, path.join(b, 'api'));
  assert.equal(projects[0].name, `${path.basename(b)}/api`);
  const pa = projects[1];
  assert.equal(pa.status, 'waiting', 'most urgent session wins');
  assert.deepEqual(pa.counts, { needs: 1, active: 0, sessions: 2 });
  assert.deepEqual(pa.spend, { today: 1.5, period: 3.5 }, 'spend outside the window is not counted');
  assert.equal(pa.latest.id, 's1');
  assert.equal(sessions[0].pa, pa.id);
  assert.deepEqual({ needs: totals.needs, active: totals.active, today: totals.today }, { needs: 1, active: 1, today: 1.5 });
});

test('Config persists choices, clears fields, and lists added folders', () => {
  const file = path.join(tmp(), 'nested', 'config.json');
  const c = new Config(file);
  c.set('/x', { name: 'X', pinned: true });
  c.set('/y', { added: true });
  c.set('/x', { pinned: false });
  const reloaded = new Config(file);
  assert.deepEqual(reloaded.get('/x'), { name: 'X' });
  assert.deepEqual(reloaded.added(), ['/y']);
  reloaded.set('/x', { name: '' });
  assert.equal('/x' in new Config(file).pas, false, 'an entry with nothing left is dropped');

  const { projects } = buildProjects([], new Config(file));
  assert.deepEqual(projects.map(p => p.id), [projectId('/y')], 'added folders appear without sessions');
});

test('a corrupt config file is reported, not overwritten', () => {
  const file = path.join(tmp(), 'config.json');
  fs.writeFileSync(file, '{ nope');
  assert.throws(() => new Config(file), /Fix or delete it/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ nope');
});
