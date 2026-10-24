// Claude Code Console — browser side. No framework: the server pushes a full
// snapshot over SSE and we re-render the current screen.
import { NEEDS, api, dot, flushMounted, h, onRender, paHref, route, state } from './core.js';
import { followPending } from './chat.js';
import { overview } from './overview.js';
import { paView } from './pa.js';

const main = document.getElementById('main');
const side = document.getElementById('side');
let lastRoute = '';

// ---------- sidebar ----------
function addFolderForm() {
  const input = h('input', { type: 'text', placeholder: '/path/to/folder', spellcheck: 'false' });
  const error = h('div', { class: 'err small' });
  const form = h('form', { class: 'add-form' }, input, error);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const p = await api('POST', '/api/pas', { path: input.value });
      state.editing = false;
      location.hash = paHref(p.id);
    } catch (err) {
      error.textContent = err.message;
    }
  });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { state.editing = false; render(); } });
  input.addEventListener('blur', () => setTimeout(() => {
    if (!form.contains(document.activeElement)) { state.editing = false; render(); }
  }, 150));
  return { form, input };
}

function sidebar(r) {
  const item = (href, active, ...kids) => h('a', { class: `side-item${active ? ' active' : ''}`, href }, kids);
  const add = h('button', { class: 'side-item add', type: 'button' }, '+ Add folder');
  add.addEventListener('click', () => {
    state.editing = true;
    const { form, input } = addFolderForm();
    add.replaceWith(form);
    input.focus();
  });
  side.replaceChildren(
    item('#/', r.view === 'overview', h('span', { class: 'glyph' }, '◎'), h('span', { class: 'name' }, 'Overview'),
      state.totals?.needs ? h('span', { class: 'count needs' }, state.totals.needs) : null),
    h('div', { class: 'side-label' }, 'Assistants'),
    ...state.projects.filter(p => !p.hidden).map(p => item(paHref(p.id), r.pa === p.id,
      dot(p.status),
      h('span', { class: 'name', title: p.root }, p.name),
      p.counts.needs ? h('span', { class: 'count needs' }, p.counts.needs)
        : p.counts.active ? h('span', { class: 'count' }, p.counts.active) : null,
    )),
    add,
  );
}

// ---------- render ----------
function render() {
  if (state.editing || state.composing) return; // don't disturb an inline editor or IME input; the next push catches up
  if (state.locked) return showLocked();
  followPending();
  const r = route();
  // Live boxes (message box, answers) are moved, not rebuilt, which drops focus; put it back.
  const active = document.activeElement?.dataset?.keepFocus ? document.activeElement : null;
  const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = new Map([...main.querySelectorAll('[data-scroll]')].map(el => [el.dataset.scroll, el.scrollTop]));
  const mainScroll = main.scrollTop;

  const needs = state.totals?.needs || 0;
  document.title = needs ? `(${needs}) Claude Code Console` : 'Claude Code Console';
  document.getElementById('filter').placeholder = r.view === 'pa' ? 'Filter sessions…' : 'Filter assistants…';

  sidebar(r);
  if (r.view === 'pa') paView(main, r); else overview(main);
  flushMounted();
  if (active?.isConnected && document.activeElement !== active) {
    active.focus({ preventScroll: true });
    if (sel) active.setSelectionRange(...sel);
  }

  // Compare after rendering: paView may have filled in the default session.
  const sameScreen = location.hash === lastRoute;
  lastRoute = location.hash;
  if (sameScreen) {
    main.scrollTop = mainScroll;
    for (const el of main.querySelectorAll('[data-scroll]')) {
      if (scroll.has(el.dataset.scroll)) el.scrollTop = scroll.get(el.dataset.scroll);
    }
  } else {
    main.scrollTop = 0;
  }
}
onRender(render);

function showLocked() {
  side.replaceChildren();
  main.replaceChildren(h('div', { class: 'empty locked' },
    h('h2', null, 'This console is locked'),
    h('p', null, 'Open the link printed in the terminal where the console is running. It looks like ',
      h('code', null, `${location.origin}/?token=…`), '. Your browser remembers it after that.')));
}

// ---------- notifications ----------
/** What a notification says about a session that just started needing you. */
function needsText(s, runs) {
  if (s.status === 'error') return s.error?.message || 'Hit an error';
  if (s.status === 'question') return 'Has a question for you';
  if (s.status === 'approval') {
    const a = runs.find(r => r.sessionId === s.id)?.approvals[0];
    if (a?.tool === 'AskUserQuestion') return 'Has a question for you';
    if (a?.tool === 'ExitPlanMode') return 'Has a plan for you to review';
    if (a) return `Wants to use ${a.displayName}${a.description ? `: ${a.description}` : ''}`;
    return s.currentTool ? `Waiting for approval in the terminal: ${s.currentTool.name}` : 'Waiting for approval in the terminal';
  }
  return 'Finished and waiting for you';
}

function notifyTransitions(sessions, runs) {
  const names = new Map(state.projects.map(p => [p.id, p.name]));
  for (const s of sessions) {
    const prev = state.prevStatus.get(s.id);
    state.prevStatus.set(s.id, s.status);
    if (!state.notify || !prev || prev === s.status || !NEEDS.has(s.status) || !document.hidden) continue;
    // An approval can interrupt anything; the others matter when work just finished.
    if (s.status !== 'approval' && !['working', 'tool', 'approval'].includes(prev)) continue;
    const n = new Notification(`${names.get(s.pa) || s.project} · ${s.title || s.lastPrompt || 'session'}`, {
      body: needsText(s, runs),
      tag: s.id,
      requireInteraction: s.status === 'approval', // stays until answered; Claude is blocked
    });
    n.onclick = () => { window.focus(); location.hash = paHref(s.pa, s.id); n.close(); };
  }
}

// ---------- wiring ----------
function connect() {
  const conn = document.getElementById('conn');
  const es = new EventSource('/api/events');
  es.onopen = () => { conn.className = 'conn live'; conn.title = 'Live'; };
  es.onerror = () => {
    conn.className = 'conn down';
    conn.title = 'Disconnected — retrying';
    // EventSource hides the status code; ask once to tell "locked" from "server down".
    fetch('/api/sessions').then(r => { if (r.status === 401) { state.locked = true; es.close(); render(); } }).catch(() => {});
  };
  es.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    state.serverSkew = msg.now - Date.now();
    state.sessions = msg.sessions;
    state.projects = msg.projects;
    state.totals = msg.totals;
    state.runs = msg.runs || [];
    state.chat = Boolean(msg.chat);
    notifyTransitions(msg.sessions, state.runs);
    render();
  };
}

const filter = document.getElementById('filter');
filter.addEventListener('input', () => { state.filter = filter.value.trim(); render(); });
const screenOf = hash => hash.startsWith('#/pa/') ? hash.split('/')[2] : 'overview';
window.addEventListener('hashchange', () => {
  // Each screen filters a different list, so start clean when moving between them.
  if (screenOf(location.hash) !== screenOf(lastRoute)) { filter.value = ''; state.filter = ''; }
  render();
});

const sideBtn = document.getElementById('sideToggle');
const applySide = collapsed => {
  document.body.classList.toggle('side-collapsed', collapsed);
  sideBtn.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
};
applySide(localStorage.getItem('ccc.side') === 'collapsed');
sideBtn.addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('side-collapsed');
  localStorage.setItem('ccc.side', collapsed ? 'collapsed' : 'open');
  applySide(collapsed);
});

const notifyBtn = document.getElementById('notify');
const syncNotify = () => notifyBtn.classList.toggle('on', state.notify);
syncNotify();
if (!('Notification' in window)) notifyBtn.hidden = true;
notifyBtn.addEventListener('click', async () => {
  if (state.notify) state.notify = false;
  else state.notify = (await Notification.requestPermission()) === 'granted';
  localStorage.setItem('ccc.notify', state.notify ? '1' : '0');
  syncNotify();
});

// Theme: follows the OS until the user picks one, then sticks.
const themeBtn = document.getElementById('theme');
const osLight = matchMedia('(prefers-color-scheme: light)');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const next = theme === 'dark' ? 'light' : 'dark';
  themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
  themeBtn.title = `Switch to ${next} theme`;
  themeBtn.setAttribute('aria-label', themeBtn.title);
}
applyTheme(document.documentElement.dataset.theme);
themeBtn.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('ccc.theme', theme);
  applyTheme(theme);
});
osLight.addEventListener('change', e => {
  if (!localStorage.getItem('ccc.theme')) applyTheme(e.matches ? 'light' : 'dark');
});

// Keep relative times fresh between pushes.
setInterval(render, 15_000);
render();
connect();
