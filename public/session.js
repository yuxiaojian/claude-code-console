// The session pane on the PA screen: status, activity, cost and the event log.
import { chatBox } from './chat.js';
import { conversation } from './conversation.js';
import { NEEDS, ago, api, clock, h, home, now, render, sessionName, shortModel, state, statusPill, tokens, usd } from './core.js';

const cacheHit = t => {
  const input = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  return input ? Math.round((t.cacheRead / input) * 100) + '%' : '—';
};
export const costTitle = c => c.source === 'estimate'
  ? `Estimated from transcript tokens at list price${c.unknownModels.length ? ` (unpriced: ${c.unknownModels.join(', ')})` : ''}. Claude Code's own figure appears when the session exits.`
  : c.source === 'claude-code' ? "Claude Code's reported cost"
  : `Claude Code's reported ${usd(c.reported)} + estimated spend since`;

function openFolder(ev, url) {
  ev.preventDefault();
  ev.stopPropagation();
  api('POST', url).catch(err => { ev.target.title = err.message; });
}

export function where(s) {
  return h('div', { class: 'where' },
    s.cwd ? h('a', { title: `Open ${s.cwd}`, onclick: ev => openFolder(ev, `/api/sessions/${s.id}/open`) }, home(s.cwd)) : s.project,
    s.gitBranch && s.gitBranch !== 'HEAD' ? [' · ', h('span', { class: 'branch' }, s.gitBranch)] : null,
  );
}

export function badges(s) {
  const mode = s.permissionMode;
  return [
    mode === 'bypassPermissions' ? h('span', { class: 'badge warn', title: 'All permission checks skipped' }, 'bypass') : null,
    mode && mode !== 'default' && mode !== 'bypassPermissions' ? h('span', { class: 'badge mode' }, mode === 'acceptEdits' ? 'accept edits' : mode) : null,
    s.model ? h('span', { class: 'badge', title: s.model }, shortModel(s.model)) : null,
  ];
}

export function activity(s) {
  if (s.status === 'error' && s.error) {
    return h('div', { class: 'activity err' }, '⚠ ', s.error.message);
  }
  if (s.currentTool) {
    const t = s.currentTool;
    const long = s.status === 'tool' && t.since && now() - t.since > 20_000;
    return h('div', { class: 'activity', title: t.target },
      h('span', { class: 'k' }, t.name), t.target ? ` ${t.target}` : '', ` · ${ago(t.since)}`,
      long && !['auto', 'bypassPermissions'].includes(s.permissionMode)
        ? h('span', { class: 'hint' }, ' — running, or waiting for approval') : null,
    );
  }
  return null;
}

function metrics(s) {
  const m = (k, v, extra = {}) => h('div', { class: 'metric', title: extra.title },
    h('span', { class: 'k' }, k), h('span', { class: 'v' + (extra.vclass ? ' ' + extra.vclass : '') }, v));
  return h('div', { class: 'metrics' },
    m('Cost', usd(s.cost.usd) + (s.cost.source === 'estimate' ? '*' : ''), { title: costTitle(s.cost), vclass: 'cost' }),
    m('Output', tokens(s.tokens.output), { title: `${s.tokens.output.toLocaleString()} output tokens` }),
    m('Cache hit', cacheHit(s.tokens), { title: `${tokens(s.tokens.cacheRead)} cache-read input tokens` }),
    m('Turns', s.turns, { title: `${s.apiCalls} API calls${s.compactions ? `, ${s.compactions} compactions` : ''}` }),
    m('Changes', s.linesAdded || s.linesRemoved ? `+${s.linesAdded} −${s.linesRemoved}` : '—', { title: 'Lines changed (reported on exit)' }),
  );
}

function contextBar(s) {
  const pct = s.context.pct;
  return h('div', { class: 'ctx', title: `${s.context.tokens.toLocaleString()} of ${s.context.window.toLocaleString()} tokens in the last request` },
    h('span', null, 'Context'),
    h('div', { class: 'bar' }, h('div', { class: pct > 80 ? 'high' : pct > 50 ? 'mid' : '', style: `width:${pct.toFixed(1)}%` })),
    h('span', null, `${pct.toFixed(0)}% of ${tokens(s.context.window)}`),
  );
}

function subagents(s) {
  const visible = s.subagents.filter(a => a.status !== 'done').concat(s.subagents.filter(a => a.status === 'done').slice(0, 5));
  if (!visible.length) return null;
  const running = s.subagents.filter(a => a.status === 'running').length;
  return h('div', { class: 'subs' },
    h('div', { class: 'metric' }, h('span', { class: 'k' }, `Subagents · ${running} running / ${s.subagents.length}`)),
    visible.map(a => h('div', { class: `sub ${a.status}`, title: a.description },
      h('span', { class: `dot ${a.status}` }),
      h('span', { class: 'd' }, a.type && a.type !== 'general-purpose' ? `${a.type}: ` : '', a.description || a.id),
      a.status === 'running' && a.tool ? h('span', { class: 't' }, a.tool) : null,
      h('span', { class: 't' }, `${tokens(a.outputTokens)} out`),
    )),
  );
}

async function loadDetail(s) {
  if (state.details.get(s.id)?.loading) return;
  state.details.set(s.id, { ...state.details.get(s.id), loading: true });
  try {
    const r = await fetch(`/api/sessions/${s.id}`);
    if (r.ok) state.details.set(s.id, { at: s.lastActivity, data: await r.json() });
    else state.details.delete(s.id);
  } catch {
    state.details.delete(s.id);
  }
  render();
}

function detail(s) {
  const d = state.details.get(s.id);
  if (!d || (d.at !== s.lastActivity && !d.loading)) loadDetail(s);
  if (!d?.data) return h('div', { class: 'where' }, 'Loading…');
  const data = d.data;
  return [
    data.files.length ? h('div', { class: 'files' }, data.files.map(f => h('span', { class: 'file', title: f }, f.split(/[\\/]/).pop()))) : null,
    h('h3', null, 'Activity'),
    h('div', { class: 'log' }, data.log.slice().reverse().map(e => h('div', { class: 'e' },
      h('span', { class: 'at' }, e.at ? clock(e.at) : ''),
      h('span', { class: `kind k-${e.kind}` }, e.kind),
      h('span', { class: 'text' }, e.text),
    ))),
    data.byModel.length ? [h('h3', null, 'Usage by model'), h('table', { class: 'models' },
      h('tr', null, ['Model', 'Input', 'Cache write', 'Cache read', 'Output', 'Cost'].map(t => h('th', null, t))),
      data.byModel.map(m => h('tr', null,
        h('td', null, shortModel(m.model)), h('td', null, tokens(m.input)), h('td', null, tokens(m.cacheWrite5m + m.cacheWrite1h)),
        h('td', null, tokens(m.cacheRead)), h('td', null, tokens(m.output)), h('td', null, m.cost == null ? 'unpriced' : usd(m.cost)),
      )),
    )] : null,
  ];
}

function tabs(current) {
  const tab = (id, label) => h('button', {
    class: `tab${current === id ? ' on' : ''}`, type: 'button',
    onclick: () => { state.sessionTab = id; localStorage.setItem('ccc.tab', id); render(); },
  }, label);
  return h('div', { class: 'tabs' }, tab('conversation', 'Conversation'), tab('details', 'Details'));
}

function details(s) {
  return h('div', { class: 'session-details', 'data-scroll': `details:${s.id}` },
    s.title && s.lastPrompt ? h('div', { class: 'prompt', title: s.lastPrompt }, s.lastPrompt) : null,
    NEEDS.has(s.status) && s.summary ? h('div', { class: 'summary' }, s.summary) : null,
    metrics(s),
    contextBar(s),
    subagents(s),
    detail(s),
    h('div', { class: 'where foot' }, `session ${s.id}`, s.version ? ` · v${s.version}` : '', s.entrypoint ? ` · ${s.entrypoint}` : '',
      s.startedAt ? ` · started ${new Date(s.startedAt).toLocaleString()}` : ''),
  );
}

/** What the session is doing right now, under the conversation. */
function liveLine(s) {
  return h('div', { class: 'live-line' },
    statusPill(s),
    s.openIn ? h('span', { class: `badge where-${s.openIn}`, title: s.openIn === 'terminal' ? 'A Claude Code process outside the console has this session open' : 'The console is running this session' },
      s.openIn === 'terminal' ? 'in terminal' : 'in console') : null,
    activity(s) || (NEEDS.has(s.status) && s.summary ? h('span', { class: 'quiet clip', title: s.summary }, s.summary) : null),
    h('span', { class: 'quiet push', title: costTitle(s.cost) }, usd(s.cost.usd), ` · context ${s.context.pct.toFixed(0)}%`),
  );
}

/** Links between a fork and the session it was copied from. */
function lineage(s) {
  const link = (x, fallback) => x ? h('a', { href: `#/pa/${x.pa}/s/${x.id}`, title: sessionName(x) }, sessionName(x)) : fallback;
  const parent = s.forkedFrom && state.sessions.find(x => x.id === s.forkedFrom);
  const forks = state.sessions.filter(x => x.forkedFrom === s.id);
  return [
    s.forkedFrom ? h('span', { class: 'lineage' }, '⑂ forked from ', link(parent, s.forkedFrom.slice(0, 8))) : null,
    forks.length ? h('span', { class: 'lineage' }, `⑂ ${forks.length} fork${forks.length > 1 ? 's' : ''}: `,
      forks.map((f, i) => [i ? ', ' : '', link(f)])) : null,
  ];
}

export function sessionPane(s) {
  const tab = state.sessionTab === 'details' ? 'details' : 'conversation';
  return h('div', { class: `session s-${s.status}` },
    h('div', { class: 'session-head' },
      h('div', { class: 'row spread' },
        h('h2', { class: 'title', title: sessionName(s) }, sessionName(s)),
        h('div', { class: 'row' }, badges(s)),
      ),
      h('div', { class: 'row spread' }, h('div', { class: 'row' }, where(s), lineage(s)), tabs(tab)),
    ),
    tab === 'details' ? details(s) : [conversation(s), liveLine(s), chatBox({ session: s })],
  );
}
