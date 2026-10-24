// Shared state, DOM helper and formatting. All transcript text goes through
// textContent, never innerHTML.

export const STATUS = {
  approval: { label: 'needs approval', group: 'needs' },
  question: { label: 'needs answer', group: 'needs' },
  waiting:  { label: 'waiting for you', group: 'needs' },
  error:    { label: 'error', group: 'needs' },
  tool:     { label: 'running tool', group: 'active' },
  working:  { label: 'thinking', group: 'active' },
  stale:    { label: 'no activity', group: 'recent' },
  idle:     { label: 'idle', group: 'recent' },
  ended:    { label: 'ended', group: 'recent' },
  empty:    { label: 'no recent sessions', group: 'recent' },
};
export const NEEDS = new Set(['approval', 'question', 'waiting', 'error']);

export const state = {
  sessions: [],
  projects: [],
  totals: null,
  runs: [],                 // Claude Code and Codex processes the console started
  chat: false,              // the server can run sessions for at least one provider
  providers: { claude: { chat: false }, codex: { chat: false, installed: false } },
  newProvider: localStorage.getItem('ccc.provider') || 'claude', // provider picked for new sessions
  pending: null,            // { key, pa, from? }: a new or forked session we'll open once it appears
  composing: false,         // IME composition in progress; re-rendering would break it
  locked: false,            // the API wants the access token
  serverSkew: 0,            // server clock - browser clock
  details: new Map(),       // session id -> { at: lastActivity, data }
  filter: '',
  editing: false,           // an inline editor is open; hold re-renders so it keeps focus
  showHidden: false,
  settingsOpen: null,       // PA id whose Defaults panel is open
  sessionTab: localStorage.getItem('ccc.tab') || 'conversation',
  notify: localStorage.getItem('ccc.notify') === '1' && 'Notification' in window && Notification.permission === 'granted',
  prevStatus: new Map(),
};

let rerender = () => {};
const mountedHooks = [];
/** Run `fn` once the current render is in the document (for scroll restoration). */
export const onMounted = fn => { mountedHooks.push(fn); };
export const flushMounted = () => { for (const fn of mountedHooks.splice(0)) fn(); };
export const onRender = fn => { rerender = fn; };
export const render = () => rerender();

// ---------- tiny DOM helper ----------
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** POST/PATCH/DELETE with the header the server requires for anything that changes state. */
export async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'x-console': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { state.locked = true; render(); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ---------- routing ----------
export function route() {
  const m = location.hash.match(/^#\/pa\/([a-f0-9]+)(?:\/s\/([\w:-]+)|\/(new))?/);
  // Links from before sessions had provider-qualified keys name a Claude session by its bare id.
  const session = m?.[2] ? (m[2].includes(':') ? m[2] : `claude:${m[2]}`) : null;
  return m ? { view: 'pa', pa: m[1], session, isNew: Boolean(m[3]) } : { view: 'overview' };
}
export const paHref = (pa, session) => `#/pa/${pa}${session === 'new' ? '/new' : session ? `/s/${session}` : ''}`;

// ---------- formatting ----------
export const now = () => Date.now() + state.serverSkew;
export function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((now() - ms) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}
export function tokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n || 0);
}
export function usd(n) {
  if (n == null) return '—';
  if (n === 0) return '$0';
  return n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}
export const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const shortModel = m => (m || '').replace(/^(us|eu|apac|global)\.anthropic\./, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
export const home = p => p.replace(/^\/(Users|home)\/[^/]+/, '~');
export const sessionName = s => s.title || s.lastPrompt || s.project;
/** Permission modes the console offers (bypassPermissions is deliberately absent). */
export const MODES = [
  ['default', 'Ask before tools'],
  ['acceptEdits', 'Accept edits'],
  ['plan', 'Plan only'],
  ['auto', 'Auto'],
];
export const modeLabel = m => MODES.find(([k]) => k === m)?.[1] || m;
/** Codex policy presets the console offers, as native approval policy · sandbox (full access is deliberately absent). */
export const CODEX_MODES = [
  ['workspace', 'on-request · workspace-write'],
  ['read-only', 'on-request · read-only'],
  ['untrusted', 'untrusted · workspace-write'],
];
export const codexModeLabel = m => CODEX_MODES.find(([k]) => k === m)?.[1] || m;
export const POLICY_NOTE = 'Native Codex approval policy and sandbox. Workspace writes may run without asking; your Codex rules and managed settings still apply. A change applies from the next turn: while a turn is running, messages can’t be sent under the old policy until it ends or you stop it.';
export const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' };
export const providerName = p => PROVIDER_NAMES[p] || 'Claude';
/** A session's dollar figure: unknown when some of its usage has no price. */
export const money = cost => (cost?.usd == null ? 'unknown' : usd(cost.usd));

/** A <select> that holds re-renders while it's open, so the menu doesn't close under the user. */
export function select(options, value, onchange, props = {}) {
  const el = h('select', props, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  el.addEventListener('focus', () => { state.editing = true; });
  el.addEventListener('blur', () => { state.editing = false; });
  el.addEventListener('change', () => { state.editing = false; onchange(el.value); el.blur(); });
  return el;
}

export const SPEND_NOTE = 'Estimated from transcript tokens at list price, by the day each call was made';
export const INCOMPLETE_NOTE = 'Some usage has no known price (Codex models) or could not be attributed, so this total is incomplete';
/** "+?" after a total that doesn't cover everything. */
export const incompleteMark = flag => (flag ? h('span', { class: 'quiet', title: INCOMPLETE_NOTE }, ' +?') : null);

export function statusPill(s) {
  return h('span', { class: `pill s-${s.status}`, title: s.phaseSince ? `since ${clock(s.phaseSince)}` : '' },
    STATUS[s.status].label, s.phaseSince && s.status !== 'ended' ? ` · ${ago(s.phaseSince)}` : '');
}

export const dot = status => h('span', { class: `dot s-${status}`, title: STATUS[status]?.label });

/** Click-to-edit text. Calls `save(value)` on Enter or blur, cancels on Escape. */
export function editable(text, { title, save, cls = '' }) {
  const label = h('span', { class: `editable ${cls}`, title, tabindex: '0' }, text);
  const start = () => {
    state.editing = true;
    const input = h('input', { class: `edit ${cls}`, value: text, maxlength: '80' });
    let done = false;
    const finish = async commit => {
      if (done) return;
      done = true;
      state.editing = false;
      if (commit && input.value.trim() !== text) {
        try { await save(input.value.trim()); } catch (err) { alert(err.message); }
      }
      render();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    label.replaceWith(input);
    input.focus();
    input.select();
  };
  label.addEventListener('click', start);
  label.addEventListener('keydown', e => { if (e.key === 'Enter') start(); });
  return label;
}
