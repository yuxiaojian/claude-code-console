#!/usr/bin/env node
// Browser check for copying the session ID in Details, and for the render hold that keeps
// a selected ID selected. Not part of `npm test`: it needs a Chrome or Chromium binary.
//
//   CHROME=/path/to/chrome node scripts/check-copy-session-id.mjs
//
// It writes synthetic Claude and Codex sessions to a temp folder, starts the console on a
// free port with those folders only, drives headless Chrome over the DevTools protocol, and
// exits non-zero if any check fails. Nothing outside the temp folder is read or written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const trace = (...a) => { if (process.env.DEBUG) console.error('·', ...a); };
// Every request gives up after a few seconds, so a slow or stuck browser can't hang the check.
const get = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(3000) });
const WAIT_STEPS = 150; // x 200 ms: up to 30 s for the console, Chrome and the first snapshot
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const cands = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const pw = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  try {
    for (const d of fs.readdirSync(pw).filter(d => d.startsWith('chromium_headless_shell')).sort().reverse()) {
      for (const sub of fs.readdirSync(path.join(pw, d))) cands.unshift(path.join(pw, d, sub, 'chrome-headless-shell'));
    }
  } catch { /* no playwright cache */ }
  return cands.find(p => fs.existsSync(p));
}

// ---------- synthetic data ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-copyid-'));
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
const ts = s => new Date(Date.now() - 120_000 + s * 1000).toISOString();
const CLAUDE = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const CODEX = '01a10000-0000-7000-8000-0000000000c1';
const claudeDir = path.join(tmp, 'claude');
fs.mkdirSync(path.join(claudeDir, 'proj'), { recursive: true });
for (const id of [...CLAUDE, CODEX]) { // the last one shares its native id with the Codex session
  const lines = [
    { type: 'user', uuid: `${id}-u`, sessionId: id, timestamp: ts(1), cwd: proj, message: { role: 'user', content: `hello from ${id.slice(0, 4)}` } },
    { type: 'assistant', uuid: `${id}-a`, sessionId: id, timestamp: ts(2), cwd: proj, message: { id: `m-${id}`, model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  fs.writeFileSync(path.join(claudeDir, 'proj', `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}
const codexDir = path.join(tmp, 'codex', '2026', '01', '01');
fs.mkdirSync(codexDir, { recursive: true });
fs.writeFileSync(path.join(codexDir, `rollout-x-${CODEX}.jsonl`), [
  { timestamp: ts(0), type: 'session_meta', payload: { id: CODEX, session_id: CODEX, cwd: proj, source: 'cli', cli_version: '0.164.0' } },
  { timestamp: ts(1), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'codex hello' }] } } },
].map(l => JSON.stringify(l)).join('\n') + '\n');

// ---------- console + chrome ----------
const port = await freePort();
const cdpPort = await freePort();
const cfg = path.join(tmp, 'state', 'config.json');
const server = spawn(process.execPath, [path.join(ROOT, 'src/cli.js'), '-p', String(port), '--dir', claudeDir, '--codex-dir', path.join(tmp, 'codex'), '--config', cfg], { stdio: 'ignore' });
const chrome = chromePath();
if (!chrome) { console.error('No Chrome found; set CHROME=/path/to/chrome'); process.exit(2); }
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', `--user-data-dir=${path.join(tmp, 'chrome')}`, `--remote-debugging-port=${cdpPort}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { server.kill(); browser.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* chrome may hold files */ } };
process.on('exit', cleanup);
// Watchdog: report what ran and stop, rather than hang, if the browser stops answering.
const results = [];
setTimeout(() => {
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  console.error(`Timed out after ${results.length} checks`);
  process.exit(2);
}, 240_000).unref();

let token;
for (let i = 0; i < WAIT_STEPS && !token; i++) { await sleep(200); try { token = fs.readFileSync(path.join(tmp, 'state', 'token'), 'utf8').trim(); } catch { /* not yet */ } }
trace('token', Boolean(token));
let page;
for (let i = 0; i < WAIT_STEPS && !page; i++) {
  await sleep(200);
  try { page = (await (await get(`http://127.0.0.1:${cdpPort}/json`)).json()).find(t => t.type === 'page'); } catch { /* not yet */ }
}
trace('page', Boolean(page), chrome);
const base = `http://localhost:${port}`;
const api = async () => (await get(`http://127.0.0.1:${port}/api/sessions`, { headers: { cookie: `ccc_token=${token}`, host: `localhost:${port}` } })).json();
let sessions = [];
for (let i = 0; i < WAIT_STEPS && sessions.length < 4; i++) { await sleep(200); try { sessions = (await api()).sessions; } catch { /* not up yet */ } }
if (!token || !page || sessions.length < 4) { console.error(`Setup failed: token ${Boolean(token)}, browser ${Boolean(page)}, sessions ${sessions.length}/4`); process.exit(2); }
trace('sessions', sessions.map(s => s.id));
const byKey = Object.fromEntries(sessions.map(s => [s.id, s]));
const [c1, c2, cx, cTwin] = [byKey[`claude:${CLAUDE[0]}`], byKey[`claude:${CLAUDE[1]}`], byKey[`codex:${CODEX}`], byKey[`claude:${CODEX}`]];

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let seq = 0;
const waits = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } };
const cdp = (method, params = {}) => new Promise(r => { const i = ++seq; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'page error');
  return r.result.result.value;
};
await cdp('Page.enable');
await cdp('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
// Keep a handle on the app's EventSource so a snapshot without a session can be replayed.
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: '{ const ES = window.EventSource; window.EventSource = function (...a) { const es = new ES(...a); window.__es = es; es.addEventListener("message", e => { window.__last = e.data; }); return es; }; }' });
await cdp('Page.navigate', { url: `${base}/?token=${token}` });
await sleep(1500);
trace('navigated');

const open = async s => {
  await ev(`location.hash = '#/pa/${s.pa}/s/${s.id}'`);
  await sleep(700);
  await ev(`[...document.querySelectorAll('.tab')].find(t => t.textContent === 'Details' && !t.classList.contains('on'))?.click()`);
  await sleep(400);
};
const select = async () => {
  await ev(`document.querySelector('.sid').scrollIntoView({ block: 'center' })`);
  const [x, y] = await ev(`(() => { const r = document.querySelector('.sid').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await sleep(150);
  return ev('String(getSelection())');
};
const shownId = () => ev(`document.querySelector('.sid')?.textContent ?? null`);
const copyTarget = () => ev(`document.querySelector('.sid-wrap button')?.getAttribute('aria-label') ?? null`);
const key = async k => {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp('Input.dispatchKeyEvent', { type, key: k, code: k === 'Enter' ? 'Enter' : 'Space', windowsVirtualKeyCode: k === 'Enter' ? 13 : 32, ...(type === 'keyDown' && k === 'Enter' ? { text: '\r' } : {}) });
  }
};

const check = (name, ok, detail = '') => { trace(ok ? 'ok' : 'FAIL', name); results.push({ name, ok: Boolean(ok), detail }); };

// Copy, for both providers, by keyboard; exact native id, no provider prefix.
for (const s of [c1, cx]) {
  await open(s);
  await ev(`navigator.clipboard.writeText('before')`);
  await ev(`document.querySelector('.sid-wrap button').focus()`);
  await key('Enter');
  await sleep(300);
  check(`${s.provider}: Enter copies exactly ${s.nativeId}`, (await ev('navigator.clipboard.readText()')) === s.nativeId);
  check(`${s.provider}: "Copied" shown`, (await ev(`document.querySelector('.copy-status').textContent`)) === 'Copied');
  await ev(`navigator.clipboard.writeText('before')`);
  await key(' ');
  await sleep(300);
  check(`${s.provider}: Space copies too`, (await ev('navigator.clipboard.readText()')) === s.nativeId);
}

// Same-session selection survives live updates (renders every 5 s).
await open(cx);
check('click selects the whole ID', (await select()) === cx.nativeId);
await sleep(6500);
check('selection kept through same-session live updates', (await ev('String(getSelection())')) === cx.nativeId);
check('focus/target unchanged meanwhile', (await copyTarget()) === `Copy session ID ${cx.nativeId}`);

// Navigation while selected: hash change, Back, Forward.
await ev(`location.hash = '#/pa/${c1.pa}/s/${c1.id}'`);
await sleep(800);
check('hash navigation while selected renders the new session', (await shownId()) === c1.nativeId && (await copyTarget()) === `Copy session ID ${c1.nativeId}`, await shownId());
await select();
await ev('history.back()');
await sleep(800);
check('Back while selected renders the previous session', (await shownId()) === cx.nativeId, await shownId());
await select();
await ev('history.forward()');
await sleep(800);
check('Forward while selected renders the next session', (await shownId()) === c1.nativeId, await shownId());

// Switching to the Conversation tab while selected.
await open(c2);
await select();
await ev(`[...document.querySelectorAll('.tab')].find(t => t.textContent === 'Conversation').click()`);
await sleep(500);
check('switching tab while selected leaves Details', (await shownId()) === null);

// The selected session disappears from the snapshot.
await open(c2);
check('selected before removal', (await select()) === c2.nativeId);
await ev(`(() => { const d = JSON.parse(window.__last); d.sessions = d.sessions.filter(s => s.id !== ${JSON.stringify(c2.id)}); window.__es.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(d) })); })()`);
await sleep(500);
check('removed session: no stale Details or Copy target', (await shownId()) === null && (await copyTarget()) === null, await ev(`document.querySelector('.pane')?.innerText.slice(0, 40)`));

// Switching to Conversation by keyboard while selected.
await open(c1);
await select();
await ev(`[...document.querySelectorAll('.tab')].find(t => t.textContent === 'Conversation').focus()`);
await key('Enter');
await sleep(500);
check('keyboard tab switch while selected leaves Details', (await shownId()) === null);

// Same native id under both providers: removing one never keeps the other's stale Details.
const removeAndCheck = async (shown, other, label) => {
  await sleep(5500); // fresh snapshot with both sessions
  await open(other);
  await open(shown);
  check(`${label}: selected`, (await select()) === shown.nativeId);
  await ev(`(() => { const d = JSON.parse(window.__last); d.sessions = d.sessions.filter(s => s.id !== ${JSON.stringify(shown.id)}); window.__es.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(d) })); })()`);
  await sleep(500);
  check(`${label}: removed session leaves no stale Details while ${other.provider} twin remains`, (await shownId()) === null, await ev(`document.querySelector('.pane')?.innerText.slice(0, 40)`));
};
await removeAndCheck(cx, cTwin, 'Claude→Codex, remove Codex');
await removeAndCheck(cTwin, cx, 'Codex→Claude, remove Claude');

// Clipboard refused or missing: the ID is selected for manual copy, and stays selected.
await sleep(5500); // the next push brings the sessions back
await open(cx);
await ev(`navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))`);
await ev(`getSelection().removeAllRanges(); document.querySelector('.sid-wrap button').click()`);
await sleep(300);
check('refused clipboard: guidance shown', /press ⌘C or Ctrl\+C/.test(await ev(`document.querySelector('.copy-status').textContent`)));
check('refused clipboard: ID selected', (await ev('String(getSelection())')) === cx.nativeId);
await sleep(6000);
check('refused clipboard: selection kept through updates', (await ev('String(getSelection())')) === cx.nativeId);
await ev(`getSelection().removeAllRanges(); Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })`);
await ev(`document.querySelector('.sid-wrap button').click()`);
await sleep(300);
check('no clipboard API: ID selected with guidance', (await ev('String(getSelection())')) === cx.nativeId);

// The console locks while the ID is selected.
await ev('getSelection().removeAllRanges()');
check('selected before locking', (await select()) === cx.nativeId);
await cdp('Network.enable');
await cdp('Network.clearBrowserCookies');
await ev(`window.__es.dispatchEvent(new Event('error'))`);
await sleep(1500);
check('locked while selected: locked screen shown', await ev(`Boolean(document.querySelector('.locked'))`));

ws.close();
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok || !r.detail ? '' : ` (${r.detail})`}`);
const failed = results.filter(r => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
