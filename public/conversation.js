// The conversation view. Each session keeps one live view whose DOM survives re-renders,
// so expanded tool calls and the scroll position stay put while updates stream in.
import { clock, h, onMounted } from './core.js';
import { markdown } from './markdown.js';

const KEEP_VIEWS = 6;
const TAIL = 40;  // items re-read on each update; tool results land on recent items
const LIVE = new Set(['working', 'tool', 'question', 'stale']);

const views = new Map();

export function conversation(s) {
  let v = views.get(s.id);
  if (!v) {
    v = new View(s.id);
    views.set(s.id, v);
    if (views.size > KEEP_VIEWS) views.delete(views.keys().next().value);
  }
  v.live = LIVE.has(s.status);
  v.sync(s.lastActivity);
  onMounted(() => v.restoreScroll());
  return v.el;
}

class View {
  constructor(id) {
    this.id = id;
    this.items = [];
    this.start = 0;
    this.total = 0;
    this.loaded = false;
    this.error = '';
    this.cache = new Map(); // index -> { key, node }
    this.atBottom = true;
    this.scrollTop = 0;
    this.fetchedFor = undefined;
    this.busy = false;
    this.again = false;

    this.more = h('button', { class: 'more conv-more', type: 'button', hidden: true, onclick: () => this.loadEarlier() }, 'Load earlier messages');
    this.list = h('div', { class: 'conv-list' });
    this.status = h('div', { class: 'quiet conv-status' }, 'Loading conversation…');
    this.el = h('div', { class: 'conv' }, this.more, this.status, this.list);
    this.el.addEventListener('scroll', () => {
      if (!this.el.isConnected) return;
      this.scrollTop = this.el.scrollTop;
      this.atBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 80;
    });
    // Content grows after paint (expanded tools, wrapping); stay pinned to the newest message.
    new ResizeObserver(() => {
      if (this.atBottom && this.el.isConnected) this.el.scrollTop = this.el.scrollHeight;
    }).observe(this.list);
  }

  sync(lastActivity) {
    if (lastActivity === this.fetchedFor) return this.paint();
    this.fetchedFor = lastActivity;
    this.refresh();
  }

  restoreScroll() {
    this.el.scrollTop = this.atBottom ? this.el.scrollHeight : this.scrollTop;
  }

  async #get(query) {
    const r = await fetch(`/api/sessions/${this.id}/transcript${query}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }

  async refresh() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      const d = await this.#get(this.loaded ? `?from=${Math.max(this.start, this.total - TAIL)}` : '');
      const end = this.start + this.items.length;
      if (!this.loaded || d.total < this.total || d.start > end) {
        // First load, the file was rewritten, or too much arrived to splice: start over.
        this.start = d.start;
        this.items = d.items;
        this.cache.clear();
      } else {
        this.items.splice(d.start - this.start, Infinity, ...d.items);
      }
      this.total = d.total;
      this.loaded = true;
      this.error = '';
    } catch (err) {
      this.error = err.message;
    }
    this.busy = false;
    this.paint();
    if (this.again) { this.again = false; this.refresh(); }
  }

  async loadEarlier() {
    if (!this.start || this.busy) return;
    this.busy = true;
    this.more.textContent = 'Loading…';
    try {
      const d = await this.#get(`?before=${this.start}`);
      const before = this.el.scrollHeight;
      this.items = [...d.items, ...this.items];
      const shift = this.start - d.start;
      this.cache = new Map([...this.cache].map(([i, c]) => [i + shift, c]));
      this.start = d.start;
      this.busy = false;
      this.paint();
      this.el.scrollTop += this.el.scrollHeight - before; // keep the reader's place
    } catch (err) {
      this.busy = false;
      this.error = err.message;
      this.paint();
    }
    if (this.again) { this.again = false; this.refresh(); }
  }

  paint() {
    this.more.hidden = !this.loaded || this.start === 0;
    this.more.textContent = `Load earlier messages (${this.start})`;
    this.status.hidden = this.loaded && !this.error && this.items.length > 0;
    this.status.textContent = this.error ? `Couldn't load the conversation: ${this.error}`
      : !this.loaded ? 'Loading conversation…' : 'No messages yet.';
    const nodes = this.items.map((item, i) => {
      const pending = item.k === 'tool' && !item.result;
      const key = JSON.stringify(item) + (pending ? this.live : '');
      const hit = this.cache.get(i);
      if (hit?.key === key) return hit.node;
      const node = renderItem(item, this.live);
      if (hit?.node.open) node.open = true; // a tool the reader expanded stays expanded when its result lands
      this.cache.set(i, { key, node });
      return node;
    });
    for (const i of this.cache.keys()) if (i >= this.items.length) this.cache.delete(i);
    const stick = this.atBottom;
    this.list.replaceChildren(...nodes);
    if (stick && this.el.isConnected) this.el.scrollTop = this.el.scrollHeight;
  }
}

// ---------- items ----------
const time = at => (at ? h('span', { class: 'at', title: new Date(at).toLocaleString() }, clock(at)) : null);

function renderItem(item, live) {
  switch (item.k) {
    case 'user':
      return h('div', { class: 'msg user' }, h('div', { class: 'bubble' }, item.text), time(item.at));
    case 'command':
      return h('div', { class: 'msg command' },
        h('div', { class: 'bubble' }, h('code', null, item.text)), time(item.at),
        item.output ? h('pre', { class: 'out' }, item.output) : null);
    case 'text':
      return h('div', { class: 'msg assistant md' }, markdown(item.text));
    case 'thinking':
      return h('details', { class: 'thinking' }, h('summary', null, 'Thinking'), h('div', { class: 'think-text' }, item.text));
    case 'tool':
      return tool(item, live);
    case 'summary':
      return h('details', { class: 'divider summary-block' },
        h('summary', null, 'Summary of the earlier conversation'), h('div', { class: 'think-text' }, item.text));
    case 'error':
      return h('div', { class: 'msg error' }, '⚠ ', item.text, time(item.at));
    default:
      return h('div', { class: 'divider' }, h('span', null, item.text), time(item.at));
  }
}

function diffStats(diff) {
  let add = 0, del = 0;
  for (const hk of diff.hunks) for (const l of hk.lines) { if (l[0] === '+') add++; else if (l[0] === '-') del++; }
  return { add, del };
}

function diffView(diff) {
  const rows = [];
  for (const hk of diff.hunks) {
    let o = hk.oldStart, n = hk.newStart;
    const numbered = hk.oldStart > 0 || hk.newStart > 0;
    if (rows.length) rows.push(h('tr', { class: 'gap' }, h('td', { colspan: '3' }, '⋯')));
    for (const l of hk.lines) {
      const sign = l[0];
      const cls = sign === '+' ? 'add' : sign === '-' ? 'del' : 'same';
      const on = numbered && sign !== '+' ? o++ : '';
      const nn = numbered && sign !== '-' ? n++ : '';
      rows.push(h('tr', { class: cls }, h('td', { class: 'ln' }, on), h('td', { class: 'ln' }, nn), h('td', { class: 'src' }, l)));
    }
  }
  return h('div', { class: 'diff' }, h('table', null, rows), diff.truncated ? h('div', { class: 'quiet small' }, 'Diff truncated') : null);
}

function output(result, { asMarkdown = false } = {}) {
  if (!result) return null;
  if (!result.text) return h('div', { class: 'quiet small' }, result.error ? 'Failed with no output' : 'No output');
  return [
    asMarkdown && !result.error ? h('div', { class: 'md out-md' }, markdown(result.text)) : h('pre', { class: `out${result.error ? ' err' : ''}` }, result.text),
    result.truncated ? h('div', { class: 'quiet small' }, 'Output trimmed to its start and end') : null,
  ];
}

function inputTable(input) {
  const entries = Object.entries(input || {});
  if (!entries.length) return null;
  return h('table', { class: 'kv' }, entries.map(([k, v]) => h('tr', null,
    h('th', null, k), h('td', null, typeof v === 'string' ? v : JSON.stringify(v, null, 2)))));
}

const TODO = { completed: '☑', in_progress: '◐', pending: '☐' };

function toolBody(item) {
  const { name, input, result } = item;
  switch (name) {
    case 'Bash':
      return [h('pre', { class: 'cmd' }, `$ ${input.command || ''}`), output(result)];
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return [h('div', { class: 'where' }, input.file_path || input.notebook_path || ''),
        item.diff ? diffView(item.diff) : null, result?.error ? output(result) : null];
    case 'Agent': case 'Task':
      return [inputTable(input), output(result, { asMarkdown: true })];
    case 'TodoWrite':
      return h('ul', { class: 'todos' }, (Array.isArray(input.todos) ? input.todos : []).map(t =>
        h('li', { class: t.status }, `${TODO[t.status] || '☐'} `, t.content || t.activeForm || '')));
    default:
      return [inputTable(input), output(result)];
  }
}

function tool(item, live) {
  const state = item.result ? (item.result.error ? 'err' : 'ok') : live ? 'running' : 'none';
  const icon = { ok: '✓', err: '✗', running: '◐', none: '·' }[state];
  const stats = item.diff ? diffStats(item.diff) : null;
  const label = item.name === 'Agent' || item.name === 'Task'
    ? [item.input.subagent_type ? `${item.input.subagent_type}: ` : '', item.input.description || item.target]
    : item.target;
  const el = h('details', { class: `tool t-${state}` },
    h('summary', null,
      h('span', { class: 'icon' }, icon),
      h('span', { class: 'name' }, item.name),
      h('span', { class: 'target' }, label),
      stats ? h('span', { class: 'stats' }, h('span', { class: 'add' }, `+${stats.add}`), ' ', h('span', { class: 'del' }, `−${stats.del}`)) : null,
      time(item.at),
    ),
  );
  // Build the body on first open: most tool calls are never expanded.
  const fill = () => { if (el.childElementCount === 1) el.append(h('div', { class: 'tool-body' }, toolBody(item))); };
  el.addEventListener('toggle', () => { if (el.open) fill(); });
  if (item.name === 'TodoWrite' || (item.diff && (stats.add + stats.del) <= 12) || state === 'err') {
    fill();
    el.open = true;
  }
  return el;
}
