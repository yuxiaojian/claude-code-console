#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from './store.js';
import { TranscriptWatcher } from './watcher.js';
import { createServer } from './server.js';
import { Config, clearRootCache } from './projects.js';
import { LiveSessions } from './live.js';
import { Runner, loadQuery } from './runner.js';
import { CodexStore } from './codex/store.js';
import { CodexRunner, detectCodex } from './codex/runner.js';
import { CodexLive } from './codex/live.js';
import { ClaudeProfiles, DEFAULT_CLAUDE_DIR, envFor, normalizeDir } from './profiles.js';

function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: process.env.PORT || '3001' },
    host: { type: 'string', default: process.env.HOST || '127.0.0.1' },
    days: { type: 'string', short: 'd', default: '7' },
    dir: { type: 'string' },
    'codex-dir': { type: 'string', default: path.join(codexHome(), 'sessions') },
    config: { type: 'string', default: path.join(os.homedir(), '.claude-code-console', 'config.json') },
    help: { type: 'boolean', short: 'h' },
  },
});

if (opts.help) {
  console.log(`claude-code-console — watch every Claude Code session on this machine

Usage: claude-code-console [options]

  -p, --port <n>   Port to listen on (default 3001, or $PORT)
      --host <h>   Interface to bind (default 127.0.0.1). Anyone who can reach it and
                   has the access token can run Claude Code on this machine.
  -d, --days <n>   Load sessions active in the last n days (default 7)
      --dir <path> Transcript directory, fixed (default: <config dir>/projects, where the
                   config dir is $CLAUDE_CONFIG_DIR, else the one last picked in
                   the browser, else ~/.claude)
      --codex-dir <path>
                   Codex CLI sessions (default ~/.codex/sessions, honours $CODEX_HOME)
      --config <f> Where PA names, pins and added folders are saved
                   (default ~/.claude-code-console/config.json)
  -h, --help       Show this help`);
  process.exit(0);
}

const port = Number(opts.port);
const days = Number(opts.days);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Invalid --port: ${opts.port}`);
  process.exit(1);
}
if (!(days > 0)) {
  console.error(`Invalid --days: ${opts.days}`);
  process.exit(1);
}

const windowMs = days * 86_400_000;
const stateDir = path.dirname(opts.config);

/** A random token kept next to the config, so the browser's cookie survives restarts. */
function accessToken() {
  const file = path.join(stateDir, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[\w-]{32,}$/.test(t)) return t;
  } catch { /* first run */ }
  const t = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}
const token = accessToken();
let config;
try { config = new Config(opts.config); } catch (err) {
  console.error(err.message);
  process.exit(1);
}
const query = await loadQuery();
if (!query) console.warn('Claude Agent SDK not found: chat is off. Run npm install to enable it.');
const runner = new Runner({ query });

// The Claude config dir: $CLAUDE_CONFIG_DIR wins, then the one picked last in the browser.
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const saved = config.activeClaudeDir();
const initialDir = process.env.CLAUDE_CONFIG_DIR ? normalizeDir(process.env.CLAUDE_CONFIG_DIR)
  : saved && isDir(saved) ? saved : DEFAULT_CLAUDE_DIR;
/** Store, watcher and running-process records for one config dir, loaded and watching. */
async function openClaude(dir) {
  const store = new Store();
  const watcher = new TranscriptWatcher({
    root: opts.dir || path.join(dir, 'projects'),
    sinceMs: Date.now() - windowMs,
    onLine: (line, file) => store.ingestLine(line, file),
  });
  await watcher.start();
  return { store, watcher, live: new LiveSessions(path.join(dir, 'sessions')) };
}
const profiles = new ClaudeProfiles({
  config,
  initial: initialDir,
  fixed: Boolean(opts.dir),
  open: openClaude,
  close: ctx => ctx?.watcher.stop(),
  // Chat processes belong to the account they started under, so a switch ends them.
  onSwitch: dir => { runner.closeAll(); runner.configDir = envFor(dir); },
});

const codexStore = new CodexStore();
const codexWatcher = new TranscriptWatcher({
  root: opts['codex-dir'],
  sinceMs: Date.now() - windowMs,
  onLine: (line, file) => codexStore.ingestLine(line, file),
  create: false,
});

const t0 = Date.now();
const { store, watcher, live } = await profiles.init();
await codexWatcher.start();
const codexCount = codexStore.snapshot().length;
console.log(`Loaded ${store.sessions.size} Claude Code${codexCount ? ` and ${codexCount} Codex` : ''} sessions from the last ${days} day(s) in ${Date.now() - t0} ms (${watcher.root})`);

// Long-running consoles shouldn't grow forever.
setInterval(() => { profiles.current.store.prune(Date.now() - windowMs); codexStore.prune(Date.now() - windowMs); clearRootCache(); }, 10 * 60_000).unref();

const allowRemote = !['127.0.0.1', 'localhost', '::1'].includes(opts.host);
const codexInfo = await detectCodex();
if (codexInfo.installed && !codexInfo.chat) console.warn(`Codex CLI ${codexInfo.version || '(unknown version)'}: ${codexInfo.reason}`);
const codexRunner = new CodexRunner({ available: codexInfo });
const codexLive = new CodexLive({ dir: path.join(codexHome(), 'thread-writer-locks'), ownPids: () => codexRunner.ownPids() });
const codex = { store: codexStore, watcher: codexWatcher, runner: codexRunner, live: codexLive, info: codexInfo };
const server = createServer({ store, watcher, config, days, allowRemote, token, runner, live, codex, profiles });
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Try --port ${port + 1}.`);
  else console.error(err);
  process.exit(1);
});
server.listen(port, opts.host, () => {
  const shown = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  console.log(`Claude Code Console: http://${shown === '127.0.0.1' ? 'localhost' : shown}:${port}/?token=${token}`);
  console.log('Open that link once; the browser remembers it. Anyone with the token can run Claude Code here.');
  if (allowRemote) console.warn('Warning: listening beyond localhost. Traffic is not encrypted.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { runner.closeAll(); codexRunner.closeAll(); profiles.current.watcher.stop(); codexWatcher.stop(); server.close(); process.exit(0); });
}
